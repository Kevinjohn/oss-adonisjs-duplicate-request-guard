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
 * class instances, sparse arrays, symbol keys, cycles) calls `refuse`, so two different values can
 * never share a text and every stored text parses back to an equal value.
 */
function canonical(value: unknown, refuse: () => never, ancestors = new Set<object>()): string {
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
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || Object.keys(value).length !== value.length) {
        return refuse()
      }
      return `[${value.map((item) => canonical(item, refuse, ancestors)).join(',')}]`
    }
    if (prototype !== Object.prototype && prototype !== null) return refuse()
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], refuse, ancestors)}`)
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

/** A Lucid connection: `client` is its knex instance, unset once the connection is closed. */
interface LucidConnection {
  name: string
  client?: unknown
}

/** Real path of a SQLite file → the open Lucid connections that ran commands against it. */
const fileWriters = new Map<string, Set<LucidConnection>>()

/** The file's real path. A file not created yet resolves through its directory's real path. */
function realFile(filename: string) {
  try {
    return realpathSync(filename)
  } catch {
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
  const max = config.pool?.max ?? 1
  if (max !== 1) {
    throw new UnsafeSqlitePoolException(
      `SQLite connection "${client.connectionName}" allows ${max} pooled connections; guarded commands require pool.max = 1`
    )
  }
  const filename = config.connection?.filename
  // Every :memory: connection is its own database.
  if (!filename || filename === ':memory:') return
  const file = realFile(filename)
  // Query and transaction clients share the dialect, which holds the query client and its connection.
  const connection = (client.dialect as unknown as { client: { connection: LucidConnection } })
    .client.connection
  const writers = fileWriters.get(file) ?? new Set<LucidConnection>()
  for (const writer of writers) {
    if (writer.client === undefined) writers.delete(writer)
  }
  const other = [...writers].find((writer) => writer !== connection)
  if (other) {
    throw new UnsafeSqlitePoolException(
      `SQLite connections "${other.name}" and "${connection.name}" share ${file}; run guarded commands through one connection`
    )
  }
  writers.add(connection)
  fileWriters.set(file, writers)
}

/**
 * Marks this namespace's pending receipt completed: exactly one pending row, or throw. Internal: not
 * re-exported from the package entry, and the exports map hides src/.
 */
export async function completeReceipt(
  trx: TransactionClientContract,
  namespace: string,
  commandId: string,
  serialized: string
) {
  const changes = Number(
    await trx
      .from(RECEIPTS_TABLE)
      .where('operation', namespace)
      .where('command_id', commandId)
      .where('state', 'pending')
      .update({ state: 'completed', result: serialized, updated_at: new Date().toISOString() })
  )
  if (changes !== 1) throw new ReceiptNotPendingException(commandId, changes)
}

/** An open command on a transaction. Its savepoint is on top of the trx's savepoint stack. */
interface Frame {
  trx: TransactionClientContract
  /** Set when the enclosing command started unwinding while this one was still open. */
  aborted: boolean
  /** Set once the command completes, replays or unwinds: from then on it accepts no new child. */
  closing: boolean
  /** Every nested command started under this one, so it can wait for them before rolling back. */
  children: Frame[]
  /** This command's run, settled before its parent may roll back. */
  run?: Promise<unknown>
}

/** The current command, carried through its policies and `work` by AsyncLocalStorage. */
const commandFrame = new AsyncLocalStorage<Frame>()
/** Open commands per transaction, outermost first. */
const openCommands = new WeakMap<TransactionClientContract, Frame[]>()

/**
 * Test-only seams, not exported from the package entry: `onClosing` runs when a command starts to
 * complete or replay, `onUnwind` once an unwinding command has taken its list of children.
 */
export const internalHooks: { onClosing?: () => void; onUnwind?: () => void } = {}

/**
 * Claims the transaction synchronously, before the first await. Savepoints on one connection are a
 * stack, so a command may start only when none is open on this trx, or when the innermost open
 * command is the caller itself (a nested call from its policies or `work`). Anything else (a
 * sibling, a call that lost its async context, a call from a command that already returned) is
 * refused at once rather than queued, so it can neither corrupt the stack nor wait forever.
 */
function claim(trx: TransactionClientContract): Frame {
  const stack = openCommands.get(trx) ?? []
  const caller = commandFrame.getStore()
  const innermost = stack.at(-1)
  if (innermost !== (caller?.trx === trx ? caller : undefined)) {
    throw new ConcurrentCommandException()
  }
  // A child that arrives after its parent stopped waiting for children would outlive it.
  if (innermost?.closing) throw new UnawaitedNestedCommandException()
  const frame: Frame = { trx, aborted: false, closing: false, children: [] }
  innermost?.children.push(frame)
  stack.push(frame)
  openCommands.set(trx, stack)
  return frame
}

/** Takes the frame off the stack once its run has settled. */
function unclaim(frame: Frame) {
  // claim() created the stack, and entries are never deleted.
  const stack = openCommands.get(frame.trx) as Frame[]
  const index = stack.indexOf(frame)
  if (index !== -1) stack.splice(index, 1)
}

/**
 * Before a command rolls back: marks every nested command still open as aborted, so each stops at
 * its next checkpoint, then waits for all of them to settle. Until then this command's savepoint
 * stays open, so anything a nested command wrote, before or after the abort, is inside it and the
 * rollback removes it. Returns the aborted commands' errors.
 */
async function abortChildren(frame: Frame) {
  const open = frame.children.filter((child) => openCommands.get(frame.trx)?.includes(child))
  for (const child of open) child.aborted = true
  internalHooks.onUnwind?.()
  const settled = await Promise.allSettled(frame.children.map((child) => child.run))
  return settled.flatMap((result, index) =>
    result.status === 'rejected' && open.includes(frame.children[index]) ? [result.reason] : []
  )
}

/**
 * Checked before each of the command's own statements and before each policy and `work`: an
 * aborted command stops at its next checkpoint and rolls back. User code already running can still
 * write, but its parent waits for it, so those writes stay inside the parent's open savepoint.
 */
function assertLive(frame: Frame) {
  if (frame.aborted) throw new UnawaitedNestedCommandException()
}

/**
 * Checked before RELEASE: a command whose nested command is still open fails instead, and its
 * rollback takes the nested command's work too.
 */
function assertSettled(frame: Frame) {
  assertLive(frame)
  if (openCommands.get(frame.trx)?.at(-1) !== frame) throw new UnawaitedNestedCommandException()
}

/**
 * Runs one command inside a transaction the host owns (for example Account Kit `withCurrent`).
 * Order: authorizeAccess, reserve, then either authorizeReplay (replay) or parseAuthorization,
 * authorizeExecute, work, complete (fresh). Everything after validation runs under a savepoint, so
 * a failure rolls back the pending row and the work even if the host swallows it and commits.
 * Await it before issuing any other query on `trx`.
 */
export async function executeIn<Payload, Authorization, Result>(
  trx: TransactionClientContract,
  operation: Operation<Payload, Authorization, Result>,
  input: ExecuteInput<Payload>
): Promise<Outcome<Result>> {
  if (!trx.isTransaction) {
    throw new TransactionOwnerException('executeIn requires a transaction client')
  }
  assertSupportedConnection(trx)
  const frame = claim(trx)
  frame.run = commandFrame.run(frame, () => runClaimed(trx, frame, operation, input))
  try {
    return (await frame.run) as Outcome<Result>
  } catch (error) {
    // An enclosing command rolled back over this one: report that, not the knock-on failure.
    if (frame.aborted && !(error instanceof UnawaitedNestedCommandException)) {
      throw new UnawaitedNestedCommandException({ cause: error })
    }
    throw error
  } finally {
    unclaim(frame)
  }
}

async function runClaimed<Payload, Authorization, Result>(
  trx: TransactionClientContract,
  frame: Frame,
  operation: Operation<Payload, Authorization, Result>,
  input: ExecuteInput<Payload>
): Promise<Outcome<Result>> {
  // Take SQLite's writer lock before the first read. A deferred transaction that reads and then
  // writes fails with SQLITE_BUSY_SNAPSHOT when another process committed in between.
  assertLive(frame)
  await trx.rawQuery(`UPDATE ${RECEIPTS_TABLE} SET id = id WHERE 0`)
  // Validate before any policy runs: a payload that cannot be hashed faithfully is the client's error.
  const payloadHash = createHash('sha256')
    .update(canonical({ scopeId: input.scopeId, payload: input.payload }, refusePayload))
    .digest('hex')
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
    const outcome = await reserveAndRun(trx, frame, operation, input, namespace, payloadHash)
    assertSettled(frame)
    await trx.rawQuery(`RELEASE SAVEPOINT ${savepoint}`)
    return outcome
  } catch (error) {
    // Before any await: from here on a new child would not be waited for, so claim() refuses it.
    frame.closing = true
    // Nested commands settle first: the rollback below then takes everything they wrote.
    const [aborted] = await abortChildren(frame)
    if (aborted !== undefined && error instanceof Error && error.cause === undefined) {
      error.cause = aborted
    }
    await rollBack(trx, savepoint, error)
    throw error
  }
}

/**
 * Rolls the savepoint back. When SQLite already rolled back the whole transaction (INSERT OR
 * ROLLBACK, a busy abort), the savepoint is gone; the original error must still surface, because
 * retriers such as Account Kit test its code. The cleanup error becomes its `cause` if it has none.
 */
async function rollBack(trx: TransactionClientContract, savepoint: string, error: unknown) {
  try {
    await trx.rawQuery(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    await trx.rawQuery(`RELEASE SAVEPOINT ${savepoint}`)
  } catch (cleanup) {
    if (error instanceof Error && error.cause === undefined) error.cause = cleanup
  }
}

async function reserveAndRun<Payload, Authorization, Result>(
  trx: TransactionClientContract,
  frame: Frame,
  operation: Operation<Payload, Authorization, Result>,
  input: ExecuteInput<Payload>,
  namespace: string,
  payloadHash: string
): Promise<Outcome<Result>> {
  const context: OperationContext<Payload> = {
    actorId: input.actorId,
    scopeId: input.scopeId,
    payload: input.payload,
    trx,
  }
  const now = new Date().toISOString()
  assertLive(frame)
  // The unique indexes on (operation, command_id) and (operation, request_key) arbitrate;
  // RETURNING yields a row only when this insert won.
  const won = (await trx.rawQuery(
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
      now,
      now,
    ]
  )) as unknown[]

  if (won.length === 0) {
    assertLive(frame)
    const rows = await trx
      .from(RECEIPTS_TABLE)
      .where('operation', namespace)
      .where((query) => {
        void query
          .where('command_id', input.command.commandId)
          .orWhere('request_key', input.command.requestKey)
      })
    // The insert lost to a unique index, yet no row in this namespace matches: the table still
    // has a unique index from an older stub (command_id across every actor).
    if (rows.length === 0) throw new ReceiptSchemaException()
    // Two matching rows always differ from rows[0] in command_id or request_key.
    const row = rows[0]
    if (
      row.command_id !== input.command.commandId ||
      row.request_key !== input.command.requestKey ||
      row.payload_hash !== payloadHash
    ) {
      throw new DuplicateRequestConflictException()
    }
    if (row.state !== 'completed') throw new DuplicateRequestInProgressException()
    const result = JSON.parse(row.result) as Result
    assertLive(frame)
    await operation.authorizeReplay?.(context, result)
    frame.closing = true
    internalHooks.onClosing?.()
    return { replayed: true, result }
  }

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
  await completeReceipt(trx, namespace, input.command.commandId, canonical(result, refuseResult))
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
  return client.transaction((trx) => executeIn(trx, operation, input))
}

/**
 * Deletes completed receipts last updated strictly before `olderThan`. After pruning, the same
 * identity runs as a fresh command again, so keep receipts at least as long as clients may retry.
 */
export async function pruneReceipts(
  client: QueryClientContract,
  options: PruneOptions
): Promise<number> {
  return Number(
    await client
      .from(RECEIPTS_TABLE)
      .where('state', 'completed')
      .where('updated_at', '<', options.olderThan.toISOString())
      .delete()
  )
}
