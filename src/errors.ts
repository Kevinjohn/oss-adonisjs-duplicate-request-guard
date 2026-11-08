import { Exception } from '@adonisjs/core/exceptions'

/** The command identity was already used with a different payload, actor, operation or pairing. */
export class DuplicateRequestConflictException extends Exception {
  static code = 'E_DUPLICATE_REQUEST_CONFLICT'
  static status = 409
  constructor() {
    super('Command identity already used', {
      code: DuplicateRequestConflictException.code,
      status: DuplicateRequestConflictException.status,
    })
  }
}

/**
 * The receipt is still pending. The fresh path runs under a savepoint that is rolled back on any
 * failure, so a pending row is never committed; this is reachable only by re-entering the same
 * command (same identity and payload) from inside its own `work` or policies.
 */
export class DuplicateRequestInProgressException extends Exception {
  static code = 'E_DUPLICATE_REQUEST_IN_PROGRESS'
  static status = 409
  constructor() {
    super('Command is in progress in this transaction', {
      code: DuplicateRequestInProgressException.code,
      status: DuplicateRequestInProgressException.status,
    })
  }
}

const PLAIN_JSON =
  'plain JSON data (plain objects, arrays, strings, finite numbers, booleans, null)'

/** The client's payload is not plain JSON data. */
export class InvalidCommandValueException extends Exception {
  static code = 'E_INVALID_COMMAND_VALUE'
  static status = 400
  constructor() {
    super(`Command payload must be ${PLAIN_JSON}`, {
      code: InvalidCommandValueException.code,
      status: InvalidCommandValueException.status,
    })
  }
}

/** The operation's `work` returned something that is not plain JSON data: a server bug. */
export class InvalidCommandResultException extends Exception {
  static code = 'E_INVALID_COMMAND_RESULT'
  static status = 500
  constructor() {
    super(`Command result must be ${PLAIN_JSON}`, {
      code: InvalidCommandResultException.code,
      status: InvalidCommandResultException.status,
    })
  }
}

/** The connection's database is not one this package supports (better-sqlite3 only). */
export class UnsupportedDialectException extends Exception {
  static code = 'E_UNSUPPORTED_DIALECT'
  static status = 500
  constructor(connectionName: string, dialect: string) {
    super(
      `Connection "${connectionName}" uses ${dialect}; guarded commands support better-sqlite3 only`,
      { code: UnsupportedDialectException.code, status: UnsupportedDialectException.status }
    )
  }
}

/**
 * Another command is open on the transaction and the caller is not inside it: a sibling (for
 * example `Promise.all` on one trx), a call that lost its async context, or a call from a command
 * that already returned. Await each `executeIn` before starting the next one on the same trx.
 */
export class ConcurrentCommandException extends Exception {
  static code = 'E_CONCURRENT_COMMAND'
  static status = 500
  constructor() {
    super(
      'Another guarded command is open on this transaction; await it before starting the next one',
      { code: ConcurrentCommandException.code, status: ConcurrentCommandException.status }
    )
  }
}

/**
 * A command reached completion while a nested command it started was still open, or an enclosing
 * command rolled back over this one. Nothing from either command is kept.
 */
export class UnawaitedNestedCommandException extends Exception {
  static code = 'E_UNAWAITED_NESTED_COMMAND'
  static status = 500
  constructor(options?: { cause?: unknown }) {
    super('A nested guarded command was not awaited; both commands were rolled back', {
      code: UnawaitedNestedCommandException.code,
      status: UnawaitedNestedCommandException.status,
      cause: options?.cause,
    })
  }
}

/** The receipts table does not match the published migration (for example an older stub). */
export class ReceiptSchemaException extends Exception {
  static code = 'E_RECEIPT_SCHEMA'
  static status = 500
  constructor() {
    super(
      'The request_receipts table does not match the current migration; write a migration that brings it in line with the current stub (configure never rewrites an existing migration)',
      { code: ReceiptSchemaException.code, status: ReceiptSchemaException.status }
    )
  }
}

/** Completion found no pending receipt for the command. */
export class ReceiptNotPendingException extends Exception {
  static code = 'E_RECEIPT_NOT_PENDING'
  static status = 500
  constructor(commandId: string, changes: number) {
    super(`Receipt "${commandId}" was not pending (updated ${changes} rows)`, {
      code: ReceiptNotPendingException.code,
      status: ReceiptNotPendingException.status,
    })
  }
}

/** The caller used the wrong transaction owner: executeIn needs a transaction, execute must not get one. */
export class TransactionOwnerException extends Exception {
  static code = 'E_TRANSACTION_OWNER'
  static status = 500
  constructor(message: string) {
    super(message, {
      code: TransactionOwnerException.code,
      status: TransactionOwnerException.status,
    })
  }
}

/**
 * More than one in-process connection could write the SQLite file (a pool above one, or a second
 * named connection on the same file); better-sqlite3 would stall the event loop on its lock.
 */
export class UnsafeSqlitePoolException extends Exception {
  static code = 'E_UNSAFE_SQLITE_POOL'
  static status = 500
  constructor(message: string) {
    super(message, {
      code: UnsafeSqlitePoolException.code,
      status: UnsafeSqlitePoolException.status,
    })
  }
}

export const E_DUPLICATE_REQUEST_CONFLICT = DuplicateRequestConflictException
export const E_DUPLICATE_REQUEST_IN_PROGRESS = DuplicateRequestInProgressException
export const E_INVALID_COMMAND_VALUE = InvalidCommandValueException
export const E_INVALID_COMMAND_RESULT = InvalidCommandResultException
export const E_UNSUPPORTED_DIALECT = UnsupportedDialectException
export const E_RECEIPT_NOT_PENDING = ReceiptNotPendingException
export const E_RECEIPT_SCHEMA = ReceiptSchemaException
export const E_CONCURRENT_COMMAND = ConcurrentCommandException
export const E_UNAWAITED_NESTED_COMMAND = UnawaitedNestedCommandException
export const E_TRANSACTION_OWNER = TransactionOwnerException
export const E_UNSAFE_SQLITE_POOL = UnsafeSqlitePoolException
