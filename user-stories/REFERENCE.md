# Reference

## Actors and boundaries

- **operation caller**: host application code that has already authenticated an actor and scope, constructs an `Operation`, passes the client's `commandId` and `requestKey`, and maps package errors to a response. The package provides no UI or routes.
- **Operation callbacks**: host callbacks in three roles. The transactional authorisation callbacks `authorizeAccess` (every call), `authorizeReplay` (replays) and `authorizeExecute` (fresh reservations) receive `{ actorId, scopeId, payload, trx }`; replay also receives a separate parsed result, and execute authorisation receives the parsed authorisation; `parseAuthorization` is fresh-only parsing of the client's opaque authorisation, synchronous and without the transaction; `work(context, authorization)` is the write, on fresh reservations only. The parser receives only raw `authorization`, not the context or transaction. The transactional callbacks and `work` must be database-only, and every callback must be safe to rerun when a transaction owner retries its callback.
- **Transaction owner**: either `execute`, which owns one transaction and does not retry, or the host/Account Kit using `executeIn` in its existing transaction.
- **Operator**: configures the receipts migration and SQLite connection/pool and chooses receipt retention.

## Shared source map

- Public exports and error symbols: [`index.ts`](../index.ts).
- Operation/context/identity/result types: [`src/types.ts`](../src/types.ts).
- Reservation, execution, replay, transaction checks and pruning: [`src/receipts.ts`](../src/receipts.ts).
- Migration setup: [`configure.ts`](../configure.ts), [`stubs/make/migration/create_request_receipts_table.stub`](../stubs/make/migration/create_request_receipts_table.stub).
- Detailed contracts and host integration examples: [README](../README.md). There is no user-facing guide or built-in route.
- Test evidence: [`tests/execute.spec.ts`](../tests/execute.spec.ts), [`tests/rollback.spec.ts`](../tests/rollback.spec.ts), [`tests/nesting.spec.ts`](../tests/nesting.spec.ts), [`tests/connections.spec.ts`](../tests/connections.spec.ts), [`tests/prune.spec.ts`](../tests/prune.spec.ts).

For retry decisions distinguish an [identity conflict](../tests/identity.spec.ts) or [invalid JSON value](../tests/values.spec.ts), [transaction ownership and pending receipts](../tests/owners.spec.ts), and [transaction loss](../tests/lost_transaction.spec.ts). Match the `code` or use `instanceof errors.E_<CODE>` for the corresponding [exception](../src/errors.ts).

## Availability

`Current` describes callable source under the stated Lucid/better-sqlite3 and transaction conditions, not runtime verification. The package does not expose UI controls. A receipt namespace is the JSON tuple of operation name and actor. Either command ID or request key can find a receipt; both and the hash of scope and payload must match for replay. A fresh outcome returns the original work value with `replayed: false`; replay parses the stored JSON with `replayed: true`.

## Availability definitions

- **Current:** callable under the stated connection, configuration and transaction conditions; not a test result.
- **Hidden:** implementation remains but its ordinary entry or trigger is unavailable.
- **Removed:** historical capability has no current product entry.
- **Demo:** available only in a named demo context.
- **Operator:** installation or maintenance outside ordinary application requests.
- **Planned:** agreed target without an ordinary implemented journey.

No runtime application journey was exercised for this documentation change. See the [portable template](TEMPLATE.md) for writing and diagram maintenance rules.
