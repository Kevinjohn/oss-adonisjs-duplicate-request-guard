export * as errors from './src/errors.ts'

export { configure } from './configure.ts'
export { RECEIPTS_TABLE, requestDeduplicator } from './src/receipts.ts'
export {
  E_CONCURRENT_COMMAND,
  E_DUPLICATE_REQUEST_CONFLICT,
  E_DUPLICATE_REQUEST_IN_PROGRESS,
  E_INVALID_COMMAND_RESULT,
  E_INVALID_COMMAND_VALUE,
  E_RECEIPT_NOT_PENDING,
  E_RECEIPT_SCHEMA,
  E_TRANSACTION_LOST,
  E_UNAWAITED_NESTED_COMMAND,
} from './src/errors.ts'
export type {
  RequestIdentity,
  ExecuteInput,
  Operation,
  OperationContext,
  Outcome,
  PruneOptions,
} from './src/types.ts'
