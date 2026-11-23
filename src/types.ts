import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/** The paired identity a client sends with one operation; preserve both values on retries. */
export interface CommandIdentity {
  commandId: string
  requestKey: string
}

/** What the authorisation callbacks and `work` receive. Use only `trx` for database access. */
export interface OperationContext<Payload> {
  actorId: string
  scopeId: string
  payload: Payload
  trx: TransactionClientContract
}

interface OperationCallbacks<Payload, Authorization, Result> {
  /** Host-chosen stable operation namespace for request keys, combined with the actor id. */
  name: string
  /** Runs first, before reservation. Throw to deny; nothing is written. */
  authorizeAccess(context: OperationContext<Payload>): Promise<void> | void
  /** Runs on every replay, with the stored result. Omitted means allow the replay. */
  authorizeReplay?(context: OperationContext<Payload>, result: Result): Promise<void> | void
  /** Transactional authorisation on fresh reservations only, after parsing. Omitted means allow. */
  authorizeExecute?(
    context: OperationContext<Payload>,
    authorization: Authorization
  ): Promise<void> | void
  /** The write, on fresh reservations only. Its JSON result is stored and replayed. */
  work(context: OperationContext<Payload>, authorization: Authorization): Promise<Result> | Result
}

/**
 * One deduplicated operation. The authorisation callbacks (`authorizeAccess`, `authorizeReplay`,
 * `authorizeExecute`) and the write (`work`) run in the transaction; they must be database-only
 * and safe to rerun: a transaction owner may roll back and call them again. `parseAuthorization`
 * runs synchronously on fresh reservations only, gets no transaction, and turns the client's opaque
 * authorisation into the value `authorizeExecute` and `work` receive. It may be omitted when
 * Authorization includes undefined.
 */
export type Operation<Payload, Authorization, Result> = OperationCallbacks<
  Payload,
  Authorization,
  Result
> &
  (undefined extends Authorization
    ? { parseAuthorization?(raw: unknown): Authorization }
    : { parseAuthorization(raw: unknown): Authorization })

/**
 * The input to `execute` (owns its transaction) or `executeIn` (host transaction).
 * Only better-sqlite3 is supported. The host derives actor and scope from current access,
 * validates the payload, and chooses the operation namespace; the client supplies the paired
 * identity and optional opaque authorisation. Keep payload and identity stable across retries.
 */
export interface ExecuteInput<Payload> {
  /** Actor established by the host's authentication, not trusted from the request body. */
  actorId: string
  /** Scope established by host authorisation. */
  scopeId: string
  /** Validated JSON operation payload; must remain unchanged until the call settles. */
  payload: Payload
  /** Client-supplied paired identity. Stored field and member names are retained for compatibility. */
  command: CommandIdentity
  /** Opaque. Passed to `parseAuthorization` only when this request wins a fresh reservation. */
  authorization?: unknown
}

/**
 * `result` is the value `work` returned. It must be plain JSON data (anything else is refused with
 * E_INVALID_COMMAND_RESULT), so a replay, which parses the stored JSON, returns a JSON-equal value:
 * the same data, except that -0 comes back as 0.
 */
export interface Outcome<Result> {
  replayed: boolean
  result: Result
}

/** Retention boundary for completed receipts in the supported SQLite database. */
export interface PruneOptions {
  /** Delete completed receipts last updated before this instant. */
  olderThan: Date
}
