import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import {
  DuplicateRequestConflictException,
  DuplicateRequestInProgressException,
  InvalidCommandResultException,
  InvalidCommandValueException,
  ReceiptNotPendingException,
  ReceiptSchemaException,
  ConcurrentCommandException,
  UnawaitedNestedCommandException,
  TransactionLostException,
  TransactionOwnerException,
  UnsafeSqlitePoolException,
  UnsupportedDialectException,
} from './errors.js'
import type { ExecuteInput, Operation, OperationContext, Outcome, PruneOptions } from './types.js'

/** Table created by the published migration. */
export const RECEIPTS_TABLE = 'request_receipts'

/** The only dialect the package is tested on. Others are refused (see UnsupportedDialectException). */
const SUPPORTED_DIALECT = 'better-sqlite3'

/**
 * Canonical JSON text for plain JSON data, with object keys sorted. Anything that JSON cannot carry
 * faithfully (undefined, functions, symbols, BigInt, non-finite numbers, Dates, Maps, typed arrays,
 * class instances, sparse arrays, symbol keys, getters and setters, non-enumerable keys, cycles)
 * calls `refuse`, so two different values can
 * never share a text and every stored text parses back to an equal value.
 */
function serializeCanonicalJson(
  value: unknown,
  refuse: () => never,
  ancestors = new Set<object>()
): string {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : refuse()
    case 'object':
      break
    default:
      return refuse()
  }
  if (value === null) return 'null'
  if (ancestors.has(value)) return refuse()
  ancestors.add(value)
  try {
    const prototype = Object.getPrototypeOf(value)
    if (Object.getOwnPropertySymbols(value).length > 0) return refuse()
    // Every own key, hidden ones included; read through descriptors, so no getter or method of the
    // value runs and the stored text is what a later read of the value gives.
    const names = Object.getOwnPropertyNames(value)
    const serializeOwnValue = (key: string | number) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return refuse()
      return serializeCanonicalJson(descriptor.value, refuse, ancestors)
    }
    if (Array.isArray(value)) {
      // The indices 0..length-1, each an own data property, plus the intrinsic `length`.
      if (prototype !== Array.prototype || names.length !== value.length + 1) return refuse()
      const items: string[] = []
      for (let index = 0; index < value.length; index++) items.push(serializeOwnValue(index))
      return `[${items.join(',')}]`
    }
    if (prototype !== Object.prototype && prototype !== null) return refuse()
    return `{${names
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeOwnValue(key)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

const refusePayload = (): never => {
  throw new InvalidCommandValueException()
}
const refuseResult = (): never => {
  throw new InvalidCommandResultException()
}

/**
 * The identity is bound to SQLite TEXT, stored as UTF-8: a lone surrogate would come back as U+FFFD,
 * so the retry could never match the stored row. The actor, operation name and scope reach the
 * stored identity only through JSON.stringify, which escapes lone surrogates.
 */
function assertIdentity(...identity: unknown[]) {
  // An untyped host can forward a number or nothing at all: refuse it rather than throw a TypeError.
  if (!identity.every((value) => typeof value === 'string' && value.isWellFormed())) {
    throw new InvalidCommandValueException(
      'Command id and request key must be well-formed Unicode strings'
    )
  }
}

/** A Lucid connection: `client` is its knex instance, unset once the connection is closed. */
interface LucidConnection {
  name: string
  client?: unknown
  once(event: 'disconnect', listener: () => void): unknown
}

/**
 * Real path of a SQLite file → the open Lucid connections that ran operations against it. Exported
 * for tests only; not re-exported from the package entry.
 */
export const writersByDatabasePath = new Map<string, Set<LucidConnection>>()

/** Forgets a closed connection, and its file once no open connection uses it. */
function releaseWriter(file: string, connection: LucidConnection) {
  // Lucid unsets `client` and emits 'disconnect' in one synchronous step, so the lazy sweep has not
  // removed this connection yet: its set, and so the key, are still here.
  const writers = writersByDatabasePath.get(file) as Set<LucidConnection>
  writers.delete(connection)
  if (writers.size === 0) writersByDatabasePath.delete(file)
}

/**
 * The file's real path. Only a file not created yet resolves through its directory's real path;
 * any other failure to inspect the path throws as it is, before the path is registered.
 */
function resolveDatabasePath(filename: string) {
  try {
    return realpathSync(filename)
  } catch (error) {
    // Any failure but a missing file (a loop, a file used as a directory, a permission) surfaces.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return join(realpathSync(dirname(resolve(filename))), basename(filename))
  }
}

/**
 * Refuses connections the package cannot keep safe: any dialect but better-sqlite3, a pool above
 * one connection, or a second named connection on a SQLite file another connection already uses.
 * better-sqlite3 waits for locks synchronously, so a second in-process writer stalls the event loop
 * while the transaction holding the lock cannot commit.
 */
export function assertSupportedConnection(client: QueryClientContract | TransactionClientContract) {
  if (client.dialect.name !== SUPPORTED_DIALECT) {
    throw new UnsupportedDialectException(client.connectionName, client.dialect.name)
  }
  const config = (
    client.getWriteClient() as unknown as {
      client: { config: { pool?: { max?: number }; connection?: { filename?: string } } }
    }
  ).client.config
  const maximumConnectionCount = config.pool?.max ?? 1
  if (maximumConnectionCount !== 1) {
    throw new UnsafeSqlitePoolException(
      `SQLite connection "${client.connectionName}" allows ${maximumConnectionCount} pooled connections; guarded commands require pool.max = 1`
    )
  }
  watchConnection(client)
  // As better-sqlite3 reads it (lib/database.js): trimmed, and empty or :memory: is anonymous.
  const filename = (config.connection?.filename ?? '').trim()
  // Every anonymous connection is its own database.
  if (filename === '' || filename === ':memory:') return
  const file = resolveDatabasePath(filename)
  // Query and transaction clients share the dialect, which holds the query client and its connection.
  const connection = (client.dialect as unknown as { client: { connection: LucidConnection } })
    .client.connection
  const writers = writersByDatabasePath.get(file) ?? new Set<LucidConnection>()
  // Fallback for a close that never emitted 'disconnect' (for example a listener removed by the host).
  for (const writer of writers) {
    if (writer.client === undefined) writers.delete(writer)
  }
  const other = [...writers].find((writer) => writer !== connection)
  if (other) {
    throw new UnsafeSqlitePoolException(
      `SQLite connections "${other.name}" and "${connection.name}" share ${file}; run guarded commands through one connection`
    )
  }
  if (!writers.has(connection)) {
    writers.add(connection)
    // Lucid emits it once the connection's pool is destroyed (manager.close, closeAll, patch).
    connection.once('disconnect', () => releaseWriter(file, connection))
  }
  writersByDatabasePath.set(file, writers)
}

/** The receipt to complete and the serialised result to store in it. */
interface CompleteReceiptInput {
  namespace: string
  commandId: string
  serialized: string
}

/**
 * Marks this namespace's pending receipt completed: exactly one pending row, or throw. Internal: not
 * re-exported from the package entry, and the exports map hides src/.
 */
export async function completeReceipt(
  trx: TransactionClientContract,
  { namespace, commandId, serialized }: CompleteReceiptInput
) {
  const updatedRowCount = Number(
    await trx
      .from(RECEIPTS_TABLE)
      .where('operation', namespace)
      .where('command_id', commandId)
      .where('state', 'pending')
      .update({ state: 'completed', result: serialized, updated_at: new Date().toISOString() })
  )
  if (updatedRowCount !== 1) throw new ReceiptNotPendingException(commandId, updatedRowCount)
}

/** An open operation on a transaction. Its savepoint is on top of the trx's savepoint stack. */
interface Frame {
  trx: TransactionClientContract
  /** Set when the enclosing operation started unwinding while this one was still open. */
  aborted: boolean
  /** Set once the operation completes, replays or unwinds: from then on it accepts no new child. */
  closing: boolean
  /** Only active nested operations, so a parent can wait for them before rolling back. */
  children: Set<Frame>
  parent?: Frame
  /** The trx's driver connection, known from the operation's first checkpoint on. */
  connection?: DriverConnection
  /** This operation's run, settled before its parent may roll back. */
  run?: Promise<unknown>
  /** The promise a nested `executeIn` returned to its caller, observed once its parent reports it. */
  returned?: Promise<unknown>
}

/** The current operation, carried through its authorisation callbacks and `work` by AsyncLocalStorage. */
const operationFrame = new AsyncLocalStorage<Frame>()
/** Open operations per transaction, outermost first. */
const openFramesByTransaction = new WeakMap<TransactionClientContract, Frame[]>()

/** The driver connection a transaction is bound to: better-sqlite3's Database. */
interface DriverConnection {
  inTransaction?: boolean
}

/** The knex client behind a Lucid connection: its pool and its query events. */
interface KnexClient {
  pool: { on(event: string, listener: (...args: any[]) => void): void }
  on(event: 'query' | 'query-error' | 'query-response', listener: () => void): void
}

/**
 * Connections whose transaction SQLite ended underneath its Lucid client (`INSERT OR ROLLBACK`, a
 * busy abort). The client, and every child transaction made from it, still reports a transaction,
 * but statements now autocommit and a new savepoint is outermost, so its release commits. The mark
 * is on the connection because all of those clients share it, and it lasts until the pool
 * hands the connection to its next owner.
 */
const lostConnections = new WeakSet<DriverConnection>()

/**
 * Watched knex clients → the connection their single-connection pool last handed out, and whether
 * a statement has started inside a transaction since.
 */
type Watch = { current?: DriverConnection; didStartTransactionQuery?: boolean }
const watchesByKnexClient = new WeakMap<KnexClient, Watch>()

/** Query and transaction clients share the dialect, which holds the query client and its connection. */
function requireKnexClient(client: QueryClientContract | TransactionClientContract) {
  return (
    client.dialect as unknown as { client: { connection: { client: { client: KnexClient } } } }
  ).client.connection.client.client
}

/**
 * Watches a connection from its first deduplicated use (or a host's `assertSupportedConnection` at boot).
 * A statement inside a transaction that leaves the driver with no open transaction is the moment
 * the transaction ended, whoever issued it; without this, a child transaction opened next would
 * reopen a transaction that looks healthy. The pool handing the connection out again clears the mark.
 */
function watchConnection(client: QueryClientContract | TransactionClientContract) {
  const knexClient = requireKnexClient(client)
  if (watchesByKnexClient.has(knexClient)) return
  const state: Watch = {}
  watchesByKnexClient.set(knexClient, state)
  // A connection the pool hands out carries no transaction from its previous owner.
  knexClient.pool.on('acquireSuccess', (_id: unknown, connection: DriverConnection) => {
    state.current = connection
    state.didStartTransactionQuery = false
    lostConnections.delete(connection)
  })
  // Only a statement that started inside a transaction can lose one: knex runs its own statements
  // on the connection before BEGIN (`enforceForeignCheck` reads PRAGMA foreign_keys there).
  knexClient.on('query', () => {
    if (state.current?.inTransaction) state.didStartTransactionQuery = true
  })
  // After any statement, failed or not (a raw COMMIT or ROLLBACK from the host succeeds). After
  // the owner's own final COMMIT this also fires, harmlessly: the next acquire clears the mark.
  const markLostTransaction = () => {
    if (state.didStartTransactionQuery && state.current?.inTransaction === false)
      lostConnections.add(state.current)
  }
  knexClient.on('query-error', markLostTransaction)
  knexClient.on('query-response', markLostTransaction)
}

/** A knex transaction always resolves its own bound connection. */
function acquireBoundDriverConnection(trx: TransactionClientContract) {
  return (
    trx.knexClient as unknown as { client: { acquireConnection(): Promise<DriverConnection> } }
  ).client.acquireConnection()
}

/**
 * Binds the operation to its connection and asks better-sqlite3 whether a transaction is still open
 * on it: a host query may have ended it before this operation started. Anything but a confirmed open
 * transaction is treated as lost.
 */
async function bindAndAssertOpenTransaction(frame: Frame) {
  // A transaction the host already completed no longer owns its connection: the pool may have
  // handed it to a waiting transaction, which a mark here would refuse.
  if (frame.trx.isCompleted) throw new TransactionLostException()
  const connection = (frame.connection = await acquireBoundDriverConnection(frame.trx))
  // The watcher may have been installed after the pool handed this connection out.
  watchesByKnexClient.get(requireKnexClient(frame.trx))!.current = connection
  if (connection.inTransaction !== true) lostConnections.add(connection)
  assertLive(frame)
}

/**
 * Test-only seams, not exported from the package entry: `onClosing` runs when an operation starts to
 * complete or replay, `onUnwind` once an unwinding operation has taken its list of children.
 */
export const internalHooks: { onClosing?: () => void; onUnwind?: () => void } = {}

/**
 * Claims the transaction synchronously, before the first await. Savepoints on one connection are a
 * stack, so an operation may start only when none is open on this trx, or when the innermost open
 * operation is the caller itself (a nested call from its authorisation callbacks or `work`). Anything else (a
 * sibling, a call that lost its async context, a call from an operation that already returned) is
 * refused at once rather than queued, so it can neither corrupt the stack nor wait forever.
 */
function claimOperationFrame(trx: TransactionClientContract): Frame {
  const stack = openFramesByTransaction.get(trx) ?? []
  const caller = operationFrame.getStore()
  const innermost = stack.at(-1)
  if (innermost !== (caller?.trx === trx ? caller : undefined)) {
    throw new ConcurrentCommandException()
  }
  // A child that arrives after its parent stopped waiting for children would outlive it; one from an
  // aborted operation would run work that is about to be rolled back.
  if (innermost?.closing || innermost?.aborted) throw new UnawaitedNestedCommandException()
  const frame: Frame = {
    trx,
    aborted: false,
    closing: false,
    children: new Set(),
    parent: innermost,
  }
  innermost?.children.add(frame)
  stack.push(frame)
  openFramesByTransaction.set(trx, stack)
  return frame
}

/** Takes the frame off the stack once its run has settled. */
function releaseOperationFrame(frame: Frame) {
  // claim() created the stack, and entries are never deleted.
  const stack = openFramesByTransaction.get(frame.trx) as Frame[]
  const index = stack.indexOf(frame)
  if (index !== -1) stack.splice(index, 1)
  frame.parent?.children.delete(frame)
  frame.parent = undefined
}

/** The nested operations started under this one that are still open. */
function listOpenChildFrames(frame: Frame) {
  return [...frame.children]
}

/** Marks the operation and every open operation nested under it aborted. */
function markFrameAborted(frame: Frame) {
  frame.aborted = true
  // The failure of the operation that aborts this one reports it, so a caller that dropped its
  // promise does not also get an unhandled rejection. This holds at every depth: an aborted
  // operation can settle before its own parent unwinds. An operation nothing aborts keeps its
  // rejection unhandled.
  void frame.returned?.catch(() => {})
  for (const child of listOpenChildFrames(frame)) markFrameAborted(child)
}

/**
 * Before an operation rolls back: marks every nested operation still open, at any depth, as aborted, so
 * each stops at its next checkpoint, then waits for its direct children to settle (each waits for
 * its own). Until then this operation's savepoint stays open, so anything a nested operation wrote,
 * before or after the abort, is inside it and the rollback removes it. Returns the aborted direct
 * children's errors.
 */
async function abortChildren(frame: Frame) {
  const openChildFrames = listOpenChildFrames(frame)
  for (const child of openChildFrames) {
    markFrameAborted(child)
  }
  internalHooks.onUnwind?.()
  const childRunResults = await Promise.allSettled(openChildFrames.map((child) => child.run))
  return childRunResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
}

/**
 * Checked before each of the operation's own statements and before each authorisation callback and `work`: an
 * aborted operation stops at its next checkpoint and rolls back, and so does every operation on a
 * connection whose transaction SQLite already ended. User code already running can still
 * write, but its parent waits for it, so those writes stay inside the parent's open savepoint.
 */
function assertLive(frame: Frame) {
  if (frame.connection && lostConnections.has(frame.connection)) {
    throw new TransactionLostException()
  }
  if (frame.aborted) throw new UnawaitedNestedCommandException()
}

/**
 * Checked before RELEASE: an operation whose nested operation is still open fails instead, and its
 * rollback takes the nested operation's work too.
 */
function assertSettled(frame: Frame) {
  assertLive(frame)
  if (openFramesByTransaction.get(frame.trx)?.at(-1) !== frame)
    throw new UnawaitedNestedCommandException()
}

/**
 * Runs one operation inside a transaction the host owns (for example Account Kit `withCurrent`).
 * Order: authorizeAccess, reserve, then either authorizeReplay (replay) or parseAuthorization,
 * authorizeExecute, work, complete (fresh). Everything after validation runs under a savepoint, so
 * a failure rolls back the pending row and the work even if the host swallows it and commits.
 * Await it before issuing any other query on `trx`.
 */
export function executeIn<Payload, Authorization, Result>(
  trx: TransactionClientContract,
  operation: Operation<Payload, Authorization, Result>,
  input: ExecuteInput<Payload>
): Promise<Outcome<Result>> {
  let claimed: Frame | undefined
  const run = executeInTransaction({
    trx,
    operation,
    admitInput: () => snapshotInput(input),
    onClaimed: (frame) => {
      claimed = frame
    },
  })
  // The claim is synchronous. A nested operation's parent observes this promise only when it
  // reports the operation as its own failure's cause; awaiting callers see the same rejection.
  if (claimed?.parent) claimed.returned = run
  return run
}

// Preserve the dispatch identity while leaving authorization lazy and the payload by reference.
function snapshotInput<Payload>(input: ExecuteInput<Payload>): ExecuteInput<Payload> {
  const { actorId, scopeId, payload, command } = input
  return {
    actorId,
    scopeId,
    payload,
    command: { commandId: command?.commandId, requestKey: command?.requestKey },
    get authorization() {
      return input.authorization
    },
  }
}

/** An operation to run on a transaction, with its input admitted once the transaction is claimed. */
interface TransactionRunInput<Payload, Authorization, Result> {
  trx: TransactionClientContract
  operation: Operation<Payload, Authorization, Result>
  admitInput: () => ExecuteInput<Payload>
  /** Called with the operation's frame as soon as it is claimed, before any await. */
  onClaimed?: (frame: Frame) => void
}

async function executeInTransaction<Payload, Authorization, Result>({
  trx,
  operation,
  admitInput,
  onClaimed,
}: TransactionRunInput<Payload, Authorization, Result>): Promise<Outcome<Result>> {
  if (!trx.isTransaction) {
    throw new TransactionOwnerException('executeIn requires a transaction client')
  }
  assertSupportedConnection(trx)
  const frame = claimOperationFrame(trx)
  onClaimed?.(frame)
  try {
    const admitted = admitInput()
    // The one outcome both observers see: this call's caller and an unwinding parent, which attaches
    // it as its error's cause.
    frame.run = operationFrame
      .run(frame, () => runClaimed({ trx, frame, operation, input: admitted }))
      .catch((error: unknown) => {
        // An enclosing operation rolled back over this one: report that, not the knock-on failure.
        if (frame.aborted && !(error instanceof UnawaitedNestedCommandException)) {
          throw new UnawaitedNestedCommandException({ cause: error })
        }
        throw error
      })
    return (await frame.run) as Outcome<Result>
  } finally {
    releaseOperationFrame(frame)
  }
}

/** A claimed operation: its transaction, its frame and its admitted input. */
interface ClaimedRunInput<Payload, Authorization, Result> {
  trx: TransactionClientContract
  frame: Frame
  operation: Operation<Payload, Authorization, Result>
  input: ExecuteInput<Payload>
}

async function runClaimed<Payload, Authorization, Result>({
  trx,
  frame,
  operation,
  input,
}: ClaimedRunInput<Payload, Authorization, Result>): Promise<Outcome<Result>> {
  // Take SQLite's writer lock before the first read. A deferred transaction that reads and then
  // writes fails with SQLITE_BUSY_SNAPSHOT when another process committed in between.
  assertLive(frame)
  await bindAndAssertOpenTransaction(frame)
  await trx.rawQuery(`UPDATE ${RECEIPTS_TABLE} SET id = id WHERE 0`)
  // Validate before any authorisation callback runs: a payload that cannot be hashed faithfully is the client's error.
  const payloadHash = createHash('sha256')
    .update(
      serializeCanonicalJson({ scopeId: input.scopeId, payload: input.payload }, refusePayload)
    )
    .digest('hex')
  assertIdentity(input.command.commandId, input.command.requestKey)
  // A JSON tuple cannot be confused across the operation/actor boundary.
  const namespace = JSON.stringify([operation.name, input.actorId])

  // A raw savepoint on the caller's transaction, not a knex child transaction: knex would make
  // every other use of `trx` (a nested executeIn, trx.transaction()) wait for the child, forever.
  const savepoint = `drg_${randomUUID().replaceAll('-', '')}`
  assertLive(frame)
  await trx.rawQuery(`SAVEPOINT ${savepoint}`)
  try {
    assertLive(frame)
    await operation.authorizeAccess({
      actorId: input.actorId,
      scopeId: input.scopeId,
      payload: input.payload,
      trx,
    })
    const outcome = await reserveAndRun({ trx, frame, operation, input, namespace, payloadHash })
    assertSettled(frame)
    await trx.rawQuery(`RELEASE SAVEPOINT ${savepoint}`)
    return outcome
  } catch (error) {
    // Before any await: from here on a new child would not be waited for, so claim() refuses it.
    frame.closing = true
    // Nested operations settle first: the rollback below then takes everything they wrote.
    const [firstChildError] = await abortChildren(frame)
    if (firstChildError !== undefined) attachCause(error, firstChildError)
    await rollBack(trx, savepoint, error)
    throw error
  }
}

/**
 * Rolls the savepoint back. When SQLite already rolled back the whole transaction (INSERT OR
 * ROLLBACK, a busy abort), the savepoint is gone; the original error must still surface, because
 * retriers such as Account Kit test its code. The cleanup error becomes its `cause` if it has none.
 * The failed cleanup statement is itself what the connection's watcher sees, so later operations on
 * the connection are refused.
 */
async function rollBack(trx: TransactionClientContract, savepoint: string, error: unknown) {
  try {
    await trx.rawQuery(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    await trx.rawQuery(`RELEASE SAVEPOINT ${savepoint}`)
  } catch (cleanup) {
    attachCause(error, cleanup)
  }
}

/**
 * Gives an error without a `cause` the given one. A frozen error, a read-only `cause` or a `cause`
 * accessor that throws keeps the host's error as it is: reading and writing both stay inside the
 * try, because the rollback that follows must never be skipped over an annotation.
 */
function attachCause(error: unknown, cause: unknown) {
  try {
    if (error instanceof Error && error.cause === undefined) error.cause = cause
  } catch {
    // Not readable or not writable: the error surfaces unannotated.
  }
}

/** A claimed operation inside its savepoint, with the receipt identity it reserves. */
interface ReservationInput<Payload, Authorization, Result> extends ClaimedRunInput<
  Payload,
  Authorization,
  Result
> {
  namespace: string
  payloadHash: string
}

async function reserveAndRun<Payload, Authorization, Result>({
  trx,
  frame,
  operation,
  input,
  namespace,
  payloadHash,
}: ReservationInput<Payload, Authorization, Result>): Promise<Outcome<Result>> {
  const context: OperationContext<Payload> = {
    actorId: input.actorId,
    scopeId: input.scopeId,
    payload: input.payload,
    trx,
  }
  const writtenAt = new Date().toISOString()
  assertLive(frame)
  // The unique indexes on (operation, command_id) and (operation, request_key) arbitrate;
  // RETURNING yields a row only when this insert won.
  const insertedReceipts = (await trx.rawQuery(
    `INSERT INTO ${RECEIPTS_TABLE}
       (id, scope_id, command_id, operation, request_key, payload_hash, state, result, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      randomUUID(),
      input.scopeId,
      input.command.commandId,
      namespace,
      input.command.requestKey,
      payloadHash,
      writtenAt,
      writtenAt,
    ]
  )) as unknown[]

  if (insertedReceipts.length === 0) {
    assertLive(frame)
    const matchingReceipts = await trx
      .from(RECEIPTS_TABLE)
      .where('operation', namespace)
      .where((query) => {
        void query
          .where('command_id', input.command.commandId)
          .orWhere('request_key', input.command.requestKey)
      })
    // The insert lost to a unique index, yet no row in this namespace matches: the table still
    // has a unique index from an older stub (command_id across every actor).
    if (matchingReceipts.length === 0) throw new ReceiptSchemaException()
    // Two matching rows always differ in command_id or request_key.
    const row = matchingReceipts[0]
    if (
      row.command_id !== input.command.commandId ||
      row.request_key !== input.command.requestKey ||
      row.payload_hash !== payloadHash
    ) {
      throw new DuplicateRequestConflictException()
    }
    if (row.state !== 'completed') throw new DuplicateRequestInProgressException()
    assertLive(frame)
    // The authorisation callback gets its own copy: whatever it does to it, the caller receives the stored result.
    await operation.authorizeReplay?.(context, JSON.parse(row.result) as Result)
    frame.closing = true
    internalHooks.onClosing?.()
    return { replayed: true, result: JSON.parse(row.result) as Result }
  }

  // Fresh only, in role order: parsing of the client's opaque authorisation, the transactional
  // authorisation callback, then the write.
  assertLive(frame)
  // Operation permits parser omission only when Authorization includes undefined.
  const authorization = operation.parseAuthorization?.(input.authorization) as Authorization
  assertLive(frame)
  await operation.authorizeExecute?.(context, authorization)
  assertLive(frame)
  const result = await operation.work(context, authorization)
  assertLive(frame)
  frame.closing = true
  internalHooks.onClosing?.()
  await completeReceipt(trx, {
    namespace,
    commandId: input.command.commandId,
    serialized: serializeCanonicalJson(result, refuseResult),
  })
  return { replayed: false, result }
}

/**
 * Managed owner: opens and commits its own transaction, once. It does not retry. Do not call it
 * inside another transaction owner, and do not wrap it in a retrier.
 */
export async function execute<Payload, Authorization, Result>(
  client: QueryClientContract,
  operation: Operation<Payload, Authorization, Result>,
  input: ExecuteInput<Payload>
): Promise<Outcome<Result>> {
  if (client.isTransaction) {
    throw new TransactionOwnerException(
      'execute owns its transaction; inside a host transaction use executeIn'
    )
  }
  assertSupportedConnection(client)
  const admitted = snapshotInput(input)
  return client.transaction((trx) =>
    executeInTransaction({ trx, operation, admitInput: () => admitted })
  )
}

/**
 * Deletes completed receipts last updated strictly before `olderThan`. After pruning, the same
 * identity runs as a fresh operation again, so keep receipts at least as long as clients may retry.
 */
export async function pruneReceipts(
  client: QueryClientContract,
  options: PruneOptions
): Promise<number> {
  assertSupportedConnection(client)
  // Throws for an invalid Date, before any query.
  const cutoff = options.olderThan.toISOString()
  const query = client.from(RECEIPTS_TABLE).where('state', 'completed')
  // Stored timestamps have four-digit years. A year above 9999 is written "+YYYYYY", which sorts
  // before them as text, yet every stored receipt is older. (A year before 0 sorts first and
  // deletes nothing, which is also right.)
  if (!cutoff.startsWith('+')) void query.where('updated_at', '<', cutoff)
  return Number(await query.delete())
}
