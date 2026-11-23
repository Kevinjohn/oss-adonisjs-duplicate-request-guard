# US-GUARD-01 — Run a deduplicated operation once

As an operation caller, I want to submit an operation with a stable identity so that retries return its first result instead of applying the change twice.

**Status:** Current when using a supported better-sqlite3 connection and the required receipts migration.
**Access:** Host authenticates actor/scope and authorises access. Command identity is scoped to operation name and actor; payload plus scope must match for replay.
**Entry:** Host action calls `execute(client, operation, input)`; client supplies `commandId` and `requestKey`.
**Documentation:** [README use and contracts](../README.md#use)
**Source:** [`execute` and reservation pipeline](../src/receipts.ts)
**Coverage:** [`tests/execute.spec.ts`](../tests/execute.spec.ts), [`tests/values.spec.ts`](../tests/values.spec.ts)

## Acceptance criteria

| Input                                     | API parameter                | Required/default/conditions                                                                                                                                                                   |
| ----------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actorId`, `scopeId`                      | String-typed identity values | Required by `ExecuteInput`; host derives identity and scope from trusted authentication and authorisation. No additional nonempty-string runtime check is promised.                           |
| `command.commandId`, `command.requestKey` | Client command identity      | Both required; must be well-formed Unicode strings. Preserve the pair on a retry. Operation name plus actor forms a separate receipt namespace.                                               |
| `payload`                                 | Operation payload            | Required JSON value; scope and payload are hashed together. Objects must be plain; arrays and finite numbers are allowed.                                                                     |
| `authorization`                           | Opaque optional input        | Parsed only for fresh reservations when `parseAuthorization` exists; omitted parser supplies `undefined`. A non-optional authorization type requires a parser in the public `Operation` type. |

- The package first acquires SQLite's writer lock, then validates payload/scope JSON and both command identifiers before any authorisation callback; `authorizeAccess` is the first authorisation callback and runs before reservation. Invalid payloads do not commit a receipt.
- `Operation` requires `name`, `authorizeAccess`, and `work`; omitted execute/replay authorisation callbacks allow their respective path. Use only the provided `trx` for database changes.
- A fresh reservation parses optional opaque authorisation, runs execute authorisation, calls `work`, and stores a plain JSON result in the same transaction. `execute` opens one transaction and does not retry automatically.
- Matching completed identity returns the stored JSON-equal result with `replayed: true`; a mismatched request key, command ID or payload conflicts, re-entering the same pending operation from `work` or `authorizeExecute` (both run after the pending insert) reports in-progress, and any fresh-path failure rolls back receipt and writes.
- Non-JSON values (including cycles, dates, non-finite numbers, symbols and class instances) are refused; `-0` replays as `0`.

- Preserve both command identifiers on retries. Property order does not change the payload hash, while a changed scope or JSON value conflicts within the same operation and actor. Keep the payload unchanged until the call settles. Invalid input raises `E_INVALID_COMMAND_VALUE`; an invalid work result raises `E_INVALID_COMMAND_RESULT` and rolls back the work. See [identity cases](../tests/identity.spec.ts) and [JSON value cases](../tests/values.spec.ts).

## User flow

```mermaid
flowchart TD
    A["Caller submits command ID, request key and payload"] --> B["Host authenticates actor and scope"]
    B --> V{"Identity and payload valid?"}
    V -->|No| X["Refuse invalid input"]
    V -->|Yes| C["Check current access"]
    C --> C2{"Access allowed?"}
    C2 -->|No| C3["Refuse; no new receipt; an existing receipt is unchanged"]
    C2 -->|Yes| D{"Reservation outcome?"}
    D -->|No, completed and matching| R{"Replay authorisation callback allows?"}
    R -->|No| R2["Refuse; stored receipt is kept"]
    R -->|Yes or callback omitted| E["Return first result"]
    D -->|Conflict or pending| F["Return mapped conflict"]
    D -->|Receipt schema incompatible| F2["Report schema error; operator fixes migration"]
    D -->|Fresh| P["Parse authorisation and check execute permission, if configured"]
    P -->|Denied or invalid| I
    P -->|Allowed| G["Run operation"]
    G --> H{"Operation succeeds?"}
    H -->|No| I["Rollback; retry can run fresh"]
    H -->|Yes| J["Commit result and return"]
```

## Code flow

Scope: package operation path; caller authentication, HTTP response shaping, and response presentation remain host-owned; operation callbacks must be database-only.

```mermaid
flowchart TD
    A["execute(client, operation, input)"] --> B["Reject transaction client; assertSupportedConnection"]
    B -->|Refused| X2["Propagate error"]
    B --> B2["snapshotInput copies the receipt identity before the transaction is requested"]
    B2 --> B3["client.transaction opens the managed transaction"]
    B3 -->|Transaction open fails| X2
    B3 --> C["executeInTransaction validates connection and claims frame"]
    C -->|Admission error| T
    C --> V["bindAndAssertOpenTransaction; no-op UPDATE takes writer lock"]
    V --> D["Hash scope/payload, assertIdentity, derive namespace; open SAVEPOINT"]
    V -->|Error| T["Reject; managed transaction rolls back"]
    D -->|Validation or savepoint error| T
    D --> D2["authorizeAccess"]
    D2 --> E["unique reservation arbitration"]
    E --> F{"INSERT reserved a row?"}
    E -->|Error| Y
    F -->|No| G["Find same namespace by command ID or request key; compare both IDs and hash"]
    G -->|No matching row| S["ReceiptSchemaException"]
    S --> Y
    G -->|Mismatch or pending| X["conflict or in-progress error"]
    G -->|Completed and matching| L["authorizeReplay if provided; build replayed=true outcome"]
    F -->|Yes| H["parseAuthorization (fresh-only parsing); authorizeExecute (transactional authorisation callback); work (the write)"]
    H --> I["completeReceipt requires one pending row"]
    I --> J["Build replayed=false outcome"]
    L --> K["assertSettled; release savepoint"]
    J --> K
    K --> M["Lucid commits managed transaction"]
    K -->|Release or settlement error| Y
    D2 -->|Error| Y["Abort and await nested children; attempt savepoint rollback; rethrow"]
    X --> Y
    L -->|authorizeReplay throws| Y
    H -->|Error| Y
    I -->|Error| Y
    Y --> T
```

**Code references:** [API](../index.ts), [execute](../src/receipts.ts#L693), [Operation](../src/types.ts#L41)
