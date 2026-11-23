# US-GUARD-05 — Remove completed receipts past the retry horizon

As an application operator, I want to prune completed receipts only after clients can no longer legitimately retry them so that storage is bounded without reopening recent operations.

**Status:** Operator.
**Access:** Host scheduler/operator with a supported better-sqlite3 connection and authority to choose retention.
**Entry:** `pruneReceipts(client, { olderThan })`; no package scheduler or Ace pruning command is provided.
**Documentation:** [Pruning contract](../README.md#contracts).
**Source:** [pruneReceipts](../src/receipts.ts#L714).
**Coverage:** [Prune tests](../tests/prune.spec.ts).

## Acceptance criteria

- `olderThan` is a required JavaScript `Date` supplied by the host. No retention default exists; choose it based on the maximum client retry horizon.
- Only completed receipts last updated strictly before the cutoff are deleted; retention counts from completion rather than reservation. For a UTC year above 9999, all completed receipts qualify. A cutoff before year zero removes none. See the [retention and cutoff boundary tests](../tests/identity.spec.ts#L306-L363). Pending and equal-cutoff rows remain.
- The method returns the deleted-row count. A later call using a deleted identity executes fresh and can apply the operation again.
- Supported-connection checks apply before deletion; database and invalid date failures propagate. Host owns scheduling and any surrounding transaction.

## User flow

```mermaid
flowchart TD
    A["Operator selects cutoff beyond client retry horizon"] --> B["Scheduled host calls pruneReceipts"]
    B --> C{"Deletion succeeds?"}
    C -->|No| D["Observe failure and correct before retry"]
    C -->|Yes| E["Receive removed-row count"]
    E --> F["Deleted receipt identities may execute fresh later"]
```

## Code flow

Scope: public pruning API through Lucid deletion; retention policy and scheduling remain host-owned.

```mermaid
flowchart TD
    A["pruneReceipts(client, options)"] --> B["assertSupportedConnection(client)"]
    B -->|Unsupported| X["Propagate error before delete"]
    B --> C["options.olderThan.toISOString()"]
    C -->|Invalid Date| X
    C --> V{"Cutoff begins with +?"}
    V -->|Yes| P["Filter completed rows only"]
    V -->|No| D["Filter completed rows with updated_at strictly before cutoff"]
    P --> E
    D --> E["Lucid delete query"]
    E -->|Success| F["Return Number of affected rows"]
    E -->|Error| X
```

**Code references:** [pruneReceipts](../src/receipts.ts#L714), [PruneOptions](../src/types.ts#L80), [pruning tests](../tests/prune.spec.ts).
