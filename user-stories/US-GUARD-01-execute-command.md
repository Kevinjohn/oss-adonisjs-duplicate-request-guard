# US-GUARD-01 — Run a guarded command once

As a command caller, I want to submit a command with a stable identity so that retries return its first result instead of applying the change twice.

**Status:** Current when using a supported better-sqlite3 connection and the required receipts migration.
**Access:** Host authenticates actor/scope and authorizes access. Command identity is scoped to operation name and actor; payload plus scope must match for replay.
**Entry:** Host action calls `execute(client, operation, input)`; client supplies `commandId` and `requestKey`.
**Documentation:** [README use and contracts](../README.md#use)
**Source:** [`execute` and reservation pipeline](../src/receipts.ts)
**Coverage:** [`tests/execute.spec.ts`](../tests/execute.spec.ts), [`tests/values.spec.ts`](../tests/values.spec.ts)

## Acceptance criteria

| Input                                     | API parameter                        | Required/default/conditions                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actorId`, `scopeId`                      | String-typed identity values         | Required by `ExecuteInput`; host derives identity and scope from trusted authentication/policy. No additional nonempty-string runtime guard is promised.                                      |
| `command.commandId`, `command.requestKey` | String-typed client command identity | Both required; preserve the pair on a retry. Operation name plus actor forms a separate receipt namespace.                                                                                    |
| `payload`                                 | Operation payload                    | Required JSON value; scope and payload are hashed together. Objects must be plain; arrays and finite numbers are allowed.                                                                     |
| `authorization`                           | Opaque optional input                | Parsed only for fresh reservations when `parseAuthorization` exists; omitted parser supplies `undefined`. A non-optional authorization type requires a parser in the public `Operation` type. |

- Payload/scope JSON validation occurs before any policy; `authorizeAccess` is the first policy and runs before reservation. Invalid payloads do not commit a receipt.
- `Operation` requires `name`, `authorizeAccess`, and `work`; omitted execute/replay policies allow their respective path. Use only the provided `trx` for database changes.
- A fresh reservation parses optional opaque authorization, runs execute authorization, calls `work`, and stores a plain JSON result in the same transaction.
- Matching completed identity returns the stored JSON-equal result with `replayed: true`; mismatched key/command/payload conflicts, pending re-entry reports in-progress, and any fresh-path failure rolls back receipt and writes.
- Non-JSON values (including cycles, dates, non-finite numbers, symbols and class instances) are refused; `-0` replays as `0`.

## User flow

```mermaid
flowchart TD
    A["Caller submits command ID, request key and payload"] --> B["Host authenticates actor and scope"]
    B --> C["Guard checks access"]
    C --> C2{"Access allowed?"}
    C2 -->|No| C3["Refuse; no receipt is kept"]
    C2 -->|Yes| D{"New matching command?"}
    D -->|No, completed and matching| R{"Replay policy allows?"}
    R -->|No| R2["Refuse; stored receipt is kept"]
    R -->|Yes| E["Return first result"]
    D -->|Conflict or pending| F["Return mapped conflict"]
    D -->|Yes| G["Run command"]
    G --> H{"Operation succeeds?"}
    H -->|No| I["Rollback; retry can run fresh"]
    H -->|Yes| J["Commit result and return"]
```

## Code flow

Scope: package command path; caller authentication, HTTP response shaping, and response presentation remain host-owned; operation callbacks must be database-only.

```mermaid
flowchart TD
    A["execute(client, operation, input)"] --> B["assertSupportedConnection; open transaction"]
    B --> C["executeIn claims the transaction frame"]
    C --> D["runClaimed hashes scope and payload, then opens SAVEPOINT"]
    D --> D2["authorizeAccess"]
    D2 --> E["unique reservation arbitration"]
    E --> F{"Existing identity?"}
    F -->|Yes| G["compare command, key, payload"]
    G -->|Mismatch or pending| X["conflict or in-progress error"]
    G -->|Completed and matching| L["authorizeReplay; return replayed=true"]
    F -->|No| H["parse authorization; authorizeExecute; work"]
    H --> I["completeReceipt requires one pending row"]
    I --> J["return replayed=false"]
    L --> K["release savepoint"]
    J --> K
    K --> M["commit transaction"]
    D2 -->|Error| Y["rollback savepoint; rethrow original error"]
    X --> Y
    L -->|authorizeReplay throws| Y
    H -->|Error| Y
    I -->|Error| Y
```

**Code references:** [API](../index.ts), [execute](../src/receipts.ts#L437), [Operation](../src/types.ts#L38)
