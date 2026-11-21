# US-GUARD-03 — Reauthorize access before replaying a result

As an operation caller, I want request deduplication to check current access before returning a saved result so that a retry does not disclose data after permissions change.

**Status:** Current.
**Access:** `authorizeAccess` runs for fresh and replay calls after initial payload validation; optional `authorizeReplay` runs on completed matching replay. Omission permits replay after access authorisation callback passes.
**Entry:** Call `execute` or `executeIn` using the original operation namespace and identity.
**Documentation:** [README operation authorisation callback order](../README.md#use)
**Source:** [`reserveAndRun`](../src/receipts.ts)
**Coverage:** [`tests/optional_policies.spec.ts`](../tests/optional_policies.spec.ts), [`tests/identity.spec.ts`](../tests/identity.spec.ts)

## Acceptance criteria

- Access denial occurs before reservation and does not expose or change a receipt.
- A matching completed result is returned only after `authorizeReplay` succeeds; if that callback throws, the completed receipt remains available for a later permitted attempt.
- `parseAuthorization` and `authorizeExecute` apply only to a fresh reservation; they are not rerun during replay.
- Another actor using the same client IDs is in a separate namespace and learns nothing about the first actor’s result.

## User flow

```mermaid
flowchart TD
    A["Caller retries an earlier operation"] --> B["Current access authorisation callback is checked"]
    B --> C{"Access allowed?"}
    C -->|No| D["Refuse without revealing saved result"]
    C -->|Yes| E["Matching completed receipt found"]
    E --> F{"Replay authorisation callback allows current access?"}
    F -->|No| G["Refuse; preserve receipt"]
    F -->|Yes| H["Return original result"]
```

## Code flow

Scope: package operation path; caller authentication, HTTP response shaping, and external side effects remain host-owned.

```mermaid
flowchart TD
    A["executeIn delegates to runClaimed"] --> A2["runClaimed hashes payload, opens SAVEPOINT, calls authorizeAccess"]
    A2 -->|Denied| Z["rollback savepoint; rethrow; no receipt change"]
    A2 --> B["reserveAndRun finds same operation/actor identity"]
    B --> C["verify command ID, request key, payload hash"]
    C --> D{"Matches and completed?"}
    D -->|No| E["conflict or in-progress error"]
    E --> Z
    D -->|Yes| F["JSON.parse stored result"]
    F --> G["authorizeReplay(context, result), if provided"]
    G -->|Throws| Z
    G --> H["return replayed=true; keep receipt"]
```

**Code references:** [authorisation callback order](../README.md#use), [replay branch](../src/receipts.ts#L607), [namespace construction](../src/receipts.ts#L488), [refusal rollback](../src/receipts.ts#L525)
