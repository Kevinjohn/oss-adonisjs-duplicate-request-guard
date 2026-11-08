export * as errors from './src/errors.js'

export { configure } from './configure.js'
export {
  RECEIPTS_TABLE,
  assertSupportedConnection,
  execute,
  executeIn,
  pruneReceipts,
} from './src/receipts.js'
export {
  E_CONCURRENT_COMMAND,
  E_DUPLICATE_REQUEST_CONFLICT,
  E_DUPLICATE_REQUEST_IN_PROGRESS,
  E_INVALID_COMMAND_RESULT,
  E_INVALID_COMMAND_VALUE,
  E_RECEIPT_NOT_PENDING,
  E_RECEIPT_SCHEMA,
  E_TRANSACTION_OWNER,
  E_UNAWAITED_NESTED_COMMAND,
  E_UNSAFE_SQLITE_POOL,
  E_UNSUPPORTED_DIALECT,
} from './src/errors.js'
export type {
  CommandIdentity,
  ExecuteInput,
  Operation,
  OperationContext,
  Outcome,
  PruneOptions,
} from './src/types.js'
