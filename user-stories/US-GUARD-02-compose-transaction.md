# US-GUARD-02 — Deduplicate an operation inside a host transaction

As a transaction owner, I want a deduplicated operation to share my transaction so that its receipt and writes commit or roll back with the surrounding account operation.

**Status:** Current with an active transaction client; callers must await sequential operations or use supported nesting.
**Access:** Host owns transaction (for example Account Kit `withCurrent`); only better-sqlite3, pool max 1, one Lucid connection per SQLite file.
**Entry:** Call `executeIn(trx, operation, input)` inside the transaction callback.
**Documentation:** [README transaction contracts](../README.md#contracts)
**Source:** [`executeIn`](../src/receipts.ts)
**Coverage:** [`tests/nesting.spec.ts`](../tests/nesting.spec.ts), [`tests/rollback.spec.ts`](../tests/rollback.spec.ts), [`tests/connections.spec.ts`](../tests/connections.spec.ts)

## Acceptance criteria

- Inputs: `trx` (required; must be a transaction client on a supported connection), `operation` (an `Operation`), and `input` (`ExecuteInput`: `actorId`, `scopeId`, `payload`, `command`, optional `authorization`). Returns `Promise<Outcome<Result>>`, that is `{ replayed, result }`.
- `execute` rejects transaction clients; `executeIn` rejects non-transaction clients (`E_TRANSACTION_OWNER`). Calling `execute` with a base connection inside another transaction is not detected as such and can instead time out acquiring the only pooled connection.
- Each operation uses a savepoint on the caller transaction; nested `executeIn` is supported from the innermost operation authorisation callbacks/work.
- Sibling calls, calls with lost async context and calls from a parent that has already returned fail immediately with `E_CONCURRENT_COMMAND`. A late nested call from a still-innermost closing or aborted frame, or a parent finishing with an open nested operation, fails with `E_UNAWAITED_NESTED_COMMAND`. Parent unwinding marks every open descendant aborted and waits for its children to settle before rollback. It observes each aborted promise, including a grandchild that settles before its own parent unwinds. Awaiting an aborted call still rejects. A dropped failure that settled without an ancestor abort remains unhandled. A child that never settles keeps the parent waiting.
- Authorisation callbacks and `work` must be database-only and safe to rerun if the transaction owner reruns its callback. Do not wrap either API in an independent retry loop.
- Original SQLite transaction-abort errors propagate; failed savepoint cleanup is attached as `cause` when possible.
- Host queries issued on `trx` while an operation is open are inside its savepoint and roll back if that operation fails.

- A savepoint success remains provisional until the host commits. If Account Kit reruns its transaction after a busy error, even a completed reservation in the rolled-back attempt runs fresh. The [Account Kit integration tests](../tests/kit.spec.ts) exercise contention, rollback, commit and replay. If the underlying transaction ends unexpectedly, follow [US-GUARD-06](US-GUARD-06-recover-transaction.md).

## User flow

```mermaid
flowchart TD
    A["Host begins account or application transaction"] --> B["Host awaits executeIn"]
    B --> C{"Operation succeeds?"}
    C -->|No| D["Operation fails; roll back opened savepoint if possible"]
    D --> G{"Outer transaction still usable?"}
    G -->|No| H["End lost transaction; see US-GUARD-06"]
    G -->|Yes| E{"Host continues and commits?"}
    C -->|Yes| E
    E -->|Yes| F["Remaining receipt and host changes commit together"]
    E -->|No| I["Outer rollback discards provisional changes"]
```

## Code flow

Scope: package operation path; caller authentication, HTTP response shaping, and external side effects remain host-owned.

```mermaid
flowchart TD
    A["executeIn(trx, operation, input)"] --> B["executeInTransaction requires transaction and supported connection"]
    B -->|Invalid owner or connection| X["Reject before claiming frame"]
    B --> C["claim frame synchronously"]
    C --> V["Capture input; bind live driver; no-op UPDATE; validate identity and payload"]
    V -->|Error before savepoint| Z["Propagate; release frame"]
    V --> D["SAVEPOINT; authorizeAccess; reserve and execute/replay"]
    D -->|SAVEPOINT creation fails| Z
    D --> E{"Operation succeeds and assertSettled accepts the frame?"}
    E -->|Yes| F["RELEASE SAVEPOINT; release frame; return provisional result"]
    F -->|Release fails| G
    E -->|Failure/unwind| G["abortChildren marks open descendants aborted and observes their promises"]
    G --> Q["Wait for child runs, attach first child error when possible, then attempt savepoint rollback and release"]
    Q --> Z
    C -->|Sibling, lost context or late child| H["Concurrency or unawaited error immediately"]
```

**Code references:** [executeIn](../src/receipts.ts#L457), [descendant abort](../src/receipts.ts#L386), [savepoint and nested execution](../src/receipts.ts#L539), [Operation](../src/types.ts#L41), [ExecuteInput](../src/types.ts#L56)
