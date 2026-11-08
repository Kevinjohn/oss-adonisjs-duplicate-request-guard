import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/** The paired identity a client sends with one command. */
export interface CommandIdentity {
  commandId: string
  requestKey: string
}

/** What every policy and the work callback receive. Use only `trx` for database access. */
export interface OperationContext<Payload> {
  actorId: string
  scopeId: string
  payload: Payload
  trx: TransactionClientContract
}

interface OperationCallbacks<Payload, Authorization, Result> {
  /** Namespace for request keys. Combined with the actor id. */
  name: string
  /** Runs first, before reservation. Throw to deny; nothing is written. */
  authorizeAccess(context: OperationContext<Payload>): Promise<void> | void
  /** Runs on every replay, with the stored result. Omitted means allow the replay. */
  authorizeReplay?(context: OperationContext<Payload>, result: Result): Promise<void> | void
  /** Runs after parsing on fresh reservations only. Omitted means allow execution. */
  authorizeExecute?(
    context: OperationContext<Payload>,
    authorization: Authorization
  ): Promise<void> | void
  /** The command itself. Its JSON result is stored and replayed. */
  work(context: OperationContext<Payload>, authorization: Authorization): Promise<Result> | Result
}

/**
 * One guarded command. Policies and `work` must be database-only and safe to rerun: a transaction
 * owner may roll back and call them again. A parser may be omitted when Authorization includes
 * undefined; otherwise it must supply the authorization promised to the callbacks.
 */
export type Operation<Payload, Authorization, Result> = OperationCallbacks<
  Payload,
  Authorization,
  Result
> &
  (undefined extends Authorization
    ? { parseAuthorization?(raw: unknown): Authorization }
    : { parseAuthorization(raw: unknown): Authorization })

export interface ExecuteInput<Payload> {
  actorId: string
  scopeId: string
  payload: Payload
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

export interface PruneOptions {
  /** Delete completed receipts last updated before this instant. */
  olderThan: Date
}
