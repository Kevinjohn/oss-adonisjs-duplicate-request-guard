# US-GUARD-01 — Run a deduplicated operation once

As an operation caller, I want to reuse the same operation identity on retries so that I get the first result instead of applying the change twice.

**Status:** Current when using a supported better-sqlite3 connection and the required receipts migration.
**Access:** Host authenticates the actor, establishes the scope, and authorises access. The operation name and actor define the receipt namespace. Replay requires a matching operation identity, scope, and payload.
**Entry:** Host action calls `execute(client, operation, input)`; client supplies the operation identity as `commandId` and `requestKey`.
**Documentation:** [README use and contracts](../README.md#use)
**Source:** [`execute` and reservation pipeline](../src/receipts.ts)
**Coverage:** [`tests/execute.spec.ts`](../tests/execute.spec.ts), [`tests/values.spec.ts`](../tests/values.spec.ts)

## Acceptance criteria

| Input                                     | API parameter                | Required/default/conditions                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actorId`, `scopeId`                      | String-typed identity values | Required by `ExecuteInput`; host derives identity and scope from trusted authentication and authorisation. No additional nonempty-string runtime check is promised.                             |
| `command.commandId`, `command.requestKey` | Operation identity           | Both values are required and must be well-formed Unicode strings. Preserve the command ID and request key together on retries. The operation name and actor define the receipt namespace.       |
| `payload`                                 | Operation payload            | Required JSON value; scope and payload are hashed together. Objects must be plain; arrays and finite numbers are allowed.                                                                       |
| `authorization`                           | Opaque optional input        | Parsed only for fresh reservations when `parseAuthorization` exists; omitted parser supplies `undefined`. A non-optional `Authorization` type requires a parser in the public `Operation` type. |

- The package first acquires SQLite's writer lock, then validates the payload and scope JSON and the operation identity before any authorisation callback. `authorizeAccess` is the first authorisation callback and runs before reservation. Invalid payloads do not commit a receipt.
- `Operation` requires `name`, `authorizeAccess`, and `work`; omitted execute/replay authorisation callbacks allow their respective path. Use only the provided `trx` for database changes.
- A fresh reservation calls `parseAuthorization(raw)` when present, then `authorizeExecute(context, authorization)` when present, then `work(context, authorization)`. Context contains `actorId`, `scopeId`, `payload` and `trx`; the parser receives no context. It stores a plain JSON result in the same transaction and returns the original value with `replayed: false`. `execute` opens one transaction and does not retry automatically.
- Within the receipt namespace, reusing a command ID or request key finds an existing receipt. A mismatch in either value, scope, or payload reports a conflict.
- A matching completed receipt returns the stored JSON-equal result with `replayed: true` after replay authorisation if configured. Calling `executeIn(trx, operation, input)` from `work` or `authorizeExecute` with the same `trx` and matching values reports that the operation is in progress.
- A fresh-path failure after the savepoint opens triggers rollback of its receipt and writes. If SQLite already ended the transaction, savepoint cleanup can fail; the original error is preserved and the host must abandon that transaction ([US-GUARD-06](US-GUARD-06-recover-transaction.md)).
- Non-JSON values (including cycles, dates, non-finite numbers, symbols and class instances) are refused; `-0` replays as `0`.

- Preserve the operation identity on retries. Property order does not change the payload hash. Changing the scope or a JSON value while reusing the operation identity conflicts within the same receipt namespace. Keep the payload unchanged until the call settles. Invalid input raises `E_INVALID_COMMAND_VALUE`; an invalid work result raises `E_INVALID_COMMAND_RESULT` and rolls back the work. See [identity cases](../tests/identity.spec.ts) and [JSON value cases](../tests/values.spec.ts).

## User flow

```mermaid
flowchart TD
    A["Caller submits an operation identity (command ID and request key) and payload"] --> B["Host authenticates the actor and establishes scope"]
    B --> V{"Operation identity, scope and payload valid?"}
    V -->|No| X["Refuse invalid input"]
    V -->|Yes| C["Check current access"]
    C --> C2{"Access allowed?"}
    C2 -->|No| C3["Refuse; no new receipt; an existing receipt is unchanged"]
    C2 -->|Yes| D{"Reservation outcome?"}
    D -->|Completed and matching| R{"Replay authorisation callback allows?"}
    R -->|No| R2["Refuse; stored receipt is kept"]
    R -->|Yes or callback omitted| E["Return first result"]
    D -->|Conflict or pending| F["Return mapped conflict or in-progress error"]
    D -->|Receipt schema incompatible| F2["Report schema error; operator fixes migration"]
    D -->|Fresh| P["Parse authorisation and check execute permission, if configured"]
    P -->|Denied or invalid| I
    P -->|Allowed| G["Run operation"]
    G --> H{"Work returns a result?"}
    H -->|No| I["Attempt rollback; if transaction is lost, abandon it before retry"]
    H -->|Yes| Q{"Result is valid JSON?"}
    Q -->|No| I
    Q -->|Yes| J{"Managed commit succeeds?"}
    J -->|Yes| K["Return fresh result"]
    J -->|No| L["Report commit failure; host decides recovery"]
```

## Code flow

Scope: package operation path; caller authentication, HTTP response shaping, and response presentation remain host-owned; operation callbacks must be database-only.

```mermaid
flowchart TD
    A["execute(client, operation, input)"] --> B["Reject transaction client; assertSupportedConnection"]
    B -->|Refused| X2["Propagate error"]
    B --> B2["snapshotInput copies the operation identity before the transaction is requested"]
    B2 --> B3["client.transaction opens the managed transaction"]
    B3 -->|Transaction open fails| X2
    B3 --> C["executeInTransaction validates connection and claims frame"]
    C -->|Admission error| T
    C --> V["bindAndAssertOpenTransaction; no-op UPDATE takes writer lock"]
    V --> D["Hash scope and payload, validate operation identity with assertIdentity, derive namespace from operation name and actor, then open SAVEPOINT"]
    V -->|Error| T["Reject; managed transaction rolls back"]
    D -->|Validation or savepoint error| T
    D --> D2["authorizeAccess"]
    D2 --> E["unique reservation arbitration"]
    E --> F{"INSERT reserved a row?"}
    E -->|Error| Y
    F -->|No| G["Find receipt in the namespace by command ID or request key, then compare operation identity and hash"]
    G -->|No matching row| S["E_RECEIPT_SCHEMA"]
    S --> Y
    G -->|Mismatch or pending| X["conflict or in-progress error"]
    G -->|Completed and matching| L["authorizeReplay if provided; build replayed=true outcome"]
    F -->|Yes| H["parseAuthorization (fresh-only parsing); authorizeExecute (transactional authorisation callback); work (the operation)"]
    H --> I["Validate and serialise work result; completeReceipt requires one pending row"]
    I --> J["Build replayed=false outcome"]
    L --> K["assertSettled; release savepoint"]
    J --> K
    K --> M["Release frame; Lucid commits managed transaction"]
    M -->|Commit fails| X2
    M -->|Commit succeeds| O["Return outcome"]
    K -->|Release or settlement error| Y
    D2 -->|Error| Y["Abort and await nested children; attempt savepoint rollback; rethrow"]
    X --> Y
    L -->|authorizeReplay throws| Y
    H -->|Error| Y
    I -->|Error| Y
    Y --> T
```

**Code references:** [API](../index.ts), [execute](../src/receipts.ts#L728), [Operation](../src/types.ts#L41)
