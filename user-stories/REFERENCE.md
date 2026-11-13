# Reference

## Actors and boundaries

- **Command caller**: host application code that has already authenticated an actor and scope, constructs an `Operation`, passes the client's `commandId` and `requestKey`, and maps package errors to a response. The package provides no UI or routes.
- **Operation policies**: host callbacks `authorizeAccess`, `authorizeReplay`, `parseAuthorization`, `authorizeExecute`, and `work`. They must be database-only and safe to rerun when a transaction owner retries its callback.
- **Transaction owner**: either `execute`, which owns one transaction and does not retry, or the host/Account Kit using `executeIn` in its existing transaction.
- **Operator**: configures the receipts migration and SQLite connection/pool and chooses receipt retention.

## Shared source map

- Public exports and error symbols: [`index.ts`](../index.ts).
- Operation/context/identity/result types: [`src/types.ts`](../src/types.ts).
- Reservation, execution, replay, transaction checks and pruning: [`src/receipts.ts`](../src/receipts.ts).
- Migration setup: [`configure.ts`](../configure.ts), [`stubs/migrations/create_request_receipts_table.stub`](../stubs/migrations/create_request_receipts_table.stub).
- Detailed contracts and host integration examples: [README](../README.md). There is no user-facing guide or built-in route.
- Test evidence: [`tests/execute.spec.ts`](../tests/execute.spec.ts), [`tests/rollback.spec.ts`](../tests/rollback.spec.ts), [`tests/nesting.spec.ts`](../tests/nesting.spec.ts), [`tests/connections.spec.ts`](../tests/connections.spec.ts), [`tests/prune.spec.ts`](../tests/prune.spec.ts).

## Availability

`Current` describes callable source under the stated Lucid/better-sqlite3 and transaction conditions, not runtime verification. The package does not expose UI controls. A receipt is scoped by operation name and actor; the paired command ID/request key and payload/scope identity must match for replay.

## Availability definitions

- **Current:** callable under the stated connection, configuration and transaction conditions; not a test result.
- **Hidden:** implementation remains but its ordinary entry or trigger is unavailable.
- **Removed:** historical capability has no current product entry.
- **Demo:** available only in a named demo context.
- **Operator:** installation or maintenance outside ordinary application requests.
- **Planned:** agreed target without an ordinary implemented journey.

No runtime application journey was exercised for this documentation change. See the [portable template](TEMPLATE.md) for writing and diagram maintenance rules.
