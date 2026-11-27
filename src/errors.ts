import { Exception } from '@adonisjs/core/exceptions'

/**
 * The command id or request key was already used in this actor's operation with a different
 * pairing, scope or payload. Another actor or operation is a separate namespace and never conflicts.
 */
export class DuplicateRequestConflictException extends Exception {
  static code = 'E_DUPLICATE_REQUEST_CONFLICT'
  static status = 409
  static message = 'Command identity already used'

  constructor() {
    super()
  }
}

/**
 * The receipt is still pending. The fresh path runs under a savepoint that is rolled back on any
 * failure, so a pending row is never committed; this is reachable only by re-entering the same
 * operation (same identity and payload) from inside its own `work` or authorisation callbacks.
 */
export class DuplicateRequestInProgressException extends Exception {
  static code = 'E_DUPLICATE_REQUEST_IN_PROGRESS'
  static status = 409
  static message = 'Command is in progress in this transaction'

  constructor() {
    super()
  }
}

const PLAIN_JSON =
  'plain JSON data (plain objects, arrays, strings, finite numbers, booleans, null)'

/** The client's payload is not plain JSON data, or its command identity is not well-formed text. */
export class InvalidCommandValueException extends Exception {
  static code = 'E_INVALID_COMMAND_VALUE'
  static status = 400
  constructor(message = `Command payload must be ${PLAIN_JSON}`) {
    super(message)
  }
}

/** The operation's `work` returned something that is not plain JSON data: a server bug. */
export class InvalidCommandResultException extends Exception {
  static code = 'E_INVALID_COMMAND_RESULT'
  static status = 500
  static message = `Command result must be ${PLAIN_JSON}`

  constructor() {
    super()
  }
}

/**
 * Another operation is open on the transaction and the caller is not inside it: a sibling (for
 * example `Promise.all` on one trx), a call that lost its async context, or a call from an
 * operation that already returned. Await each `executeIn` before starting the next one on the same trx.
 */
export class ConcurrentOperationException extends Exception {
  static code = 'E_CONCURRENT_OPERATION'
  static status = 500
  static message =
    'Another deduplicated operation is open on this transaction; await it before starting the next one'

  constructor() {
    super()
  }
}

/**
 * An operation reached completion while a nested operation it started was still open, or an
 * enclosing operation rolled back over this one. Nothing from either operation is kept.
 */
export class UnawaitedNestedOperationException extends Exception {
  static code = 'E_UNAWAITED_NESTED_OPERATION'
  static status = 500
  static message =
    'A nested deduplicated operation was not awaited; both operations were rolled back'

  constructor(options?: { cause?: unknown }) {
    super(undefined, { cause: options?.cause })
  }
}

/** The receipts table does not match the published migration (for example an older stub). */
export class ReceiptSchemaException extends Exception {
  static code = 'E_RECEIPT_SCHEMA'
  static status = 500
  static message =
    'The request_receipts table does not match the current migration; write a migration that brings it in line with the current stub (configure never rewrites an existing migration)'

  constructor() {
    super()
  }
}

/** Completion found no pending receipt for the operation. */
export class ReceiptNotPendingException extends Exception {
  static code = 'E_RECEIPT_NOT_PENDING'
  static status = 500
  constructor(commandId: string, updatedRowCount: number) {
    super(`Receipt "${commandId}" was not pending (updated ${updatedRowCount} rows)`)
  }
}

/**
 * SQLite ended the host transaction underneath its Lucid client (`INSERT OR ROLLBACK`, a busy
 * abort), in an earlier operation or a host query. Statements on that client would now autocommit,
 * so deduplicated operations refuse it: roll the transaction back and start a new one.
 */
export class TransactionLostException extends Exception {
  static code = 'E_TRANSACTION_LOST'
  static status = 500
  static message =
    'SQLite already ended this transaction; roll it back and run the command in a new one'

  constructor() {
    super()
  }
}

/** Alias of the same exception constructor; codes, status and messages remain stable. */
export const E_DUPLICATE_REQUEST_CONFLICT = DuplicateRequestConflictException
/** Alias for the HTTP 409 exception when the operation already has a pending receipt. */
export const E_DUPLICATE_REQUEST_IN_PROGRESS = DuplicateRequestInProgressException
/** Alias for the HTTP 400 exception for invalid operation identity or value. */
export const E_INVALID_COMMAND_VALUE = InvalidCommandValueException
/** Alias for the HTTP 500 exception for invalid operation result. */
export const E_INVALID_COMMAND_RESULT = InvalidCommandResultException
/** Alias for the receipt completion exception. */
export const E_RECEIPT_NOT_PENDING = ReceiptNotPendingException
/** Alias for the incompatible receipt schema exception. */
export const E_RECEIPT_SCHEMA = ReceiptSchemaException
/** Alias for the concurrent operations on one transaction exception. */
export const E_CONCURRENT_OPERATION = ConcurrentOperationException
/** Alias for the unawaited nested operation exception. */
export const E_UNAWAITED_NESTED_OPERATION = UnawaitedNestedOperationException
/** Alias for the lost transaction exception. */
export const E_TRANSACTION_LOST = TransactionLostException
