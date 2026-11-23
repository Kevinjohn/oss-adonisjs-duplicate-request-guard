# US-GUARD-06 — Recover after a transaction ends unexpectedly

As the host transaction owner, I want to recognise when SQLite has ended my transaction so that I can abandon the stale client and safely rerun eligible database work.

**Status:** Current.
**Access:** Host application using a supported Lucid connection.
**Entry:** A failed guarded call, or a subsequent `executeIn(trx, operation, input)` on the affected client.
**Documentation:** [Transaction contracts](../README.md#contracts)
**Source:** [Transaction watcher and admission](../src/receipts.ts#L277)
**Coverage:** [Transaction loss and recovery](../tests/lost_transaction.spec.ts)

## Acceptance criteria

- A SQLite error that aborts the transaction can reach the host as the original driver error. A subsequent guarded operation on that transaction raises `E_TRANSACTION_LOST` before its work runs. A raw host commit also ends the transaction. An ordinary statement failure that leaves the transaction open allows further operations.
- Catching the abort, opening a savepoint or starting a child transaction on the affected connection cannot revive the lost owner. An enclosing guarded call that swallowed the loss is stopped at its next liveness check.
- End the failed owner’s scope. A newly acquired transaction on the same pooled connection can run operations again. A late call on an already completed client is refused without poisoning the new owner.
- A managed `execute` handles its own rollback after transaction loss. The host decides whether its application operation can be attempted again and preserves the original identity and payload on retries.
- Watchers start at the first guarded call or an explicit `assertSupportedConnection` check. Arm them at application boot and after reopening a connection to cover earlier host queries. Await statements sequentially: unawaited queries may evade observation, and ordinary host queries on a lost transaction can autocommit. Do not continue issuing queries on a lost transaction.

## User flow

```mermaid
flowchart TD
    A["A statement fails or unexpectedly ends the transaction"] --> B{"Transaction still open?"}
    B -->|Yes| C["Handle the statement failure in the current transaction"]
    B -->|No| D["Stop querying and end the lost transaction; report original or transaction-lost error"]
    D --> E{"Host allows retry?"}
    E -->|Yes| F["Retry in a new transaction"]
    E -->|No| G["Return the failure"]
```

## Code flow

Scope: transaction loss detection and recovery; the host owns retry and outer rollback decisions.

```mermaid
flowchart TD
    W["watchConnection registers Knex query and pool listeners"] --> Q{"Observed query started inside transaction and ended it?"}
    Q -->|Yes| L["Mark driver in lostConnections"]
    Q -->|No| N["No new loss mark"]
    L --> R["Next pool acquireSuccess clears mark for new owner"]
    A["executeInTransaction validates owner and connection; claimOperationFrame"] --> C["runClaimed: bindAndAssertOpenTransaction"]
    C --> K{"Lucid client already completed?"}
    K -->|Yes| E["TransactionLostException; release frame"]
    K -->|No| D{"Driver reports open transaction and is not marked lost?"}
    L -.-> D
    D -->|No| E
    D -->|Yes| F["Proceed with writer lock, validation, savepoint and guarded work"]
    F --> G{"Liveness check or statement failure?"}
    G -->|Before savepoint opens| E2["Propagate error; release frame"]
    G -->|After savepoint opens| H["Unwind children; attempt savepoint cleanup; preserve original error; release frame"]
    G -->|None| I["Release savepoint and frame; return provisional outcome"]
    I -->|Savepoint release fails| H
```

**Code references:** [bindAndAssertOpenTransaction](../src/receipts.ts#L315), [runClaimed](../src/receipts.ts#L515), [TransactionLostException](../src/errors.ts#L146).
