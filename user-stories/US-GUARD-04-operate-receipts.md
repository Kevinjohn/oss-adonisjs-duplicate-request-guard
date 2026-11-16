# US-GUARD-04 — Install receipt storage

As an application operator, I want to configure the receipt table and a supported SQLite connection so that guarded commands can reserve and complete durable identities.

**Status:** Operator.
**Access:** Host operator with migration and connection configuration access.
**Entry:** `node ace configure @kevinjohn/adonisjs-duplicate-request-guard`, followed by `node ace migration:run`.
**Documentation:** [Install and connection contracts](../README.md#install).
**Source:** [configure](../configure.ts), [connection validation](../src/receipts.ts).
**Coverage:** [Configure tests](../tests/configure.spec.ts), [connection tests](../tests/connections.spec.ts).

## Acceptance criteria

- Configure publishes the receipts migration once; an existing filename with `_create_request_receipts_table.ts` suffix is left unchanged. A matching entry that is a directory or a link that does not resolve to a regular file stops configure with an error naming it, before anything is published; remove or replace it and rerun.
- A missing migrations directory counts as no existing migration and the migration is published. Any other read failure of the migrations directory (for example permissions, or a file in its place) stops configure with that error before anything is published; fix the directory and rerun.
- The migration creates `request_receipts` with unique operation/command-ID and operation/request-key indexes. An outdated cross-actor unique index can produce `E_RECEIPT_SCHEMA`; the host must use the current schema.
- Public operations require better-sqlite3 and pool maximum one. A competing open Lucid connection is refused when another still-open connection to the same resolved database file was already registered by guarded operations; closed owners are pruned. Unregistered external writers are not detected. Each in-memory connection is independent.
- The package provides APIs and a migration hook, without mounting HTTP routes or a scheduled cleanup job.

## User flow

```mermaid
flowchart TD
    A["Operator configures one SQLite writer connection"] --> B["Run configure"]
    B --> R{"Migrations directory readable?"}
    R -->|Missing| E
    R -->|Unreadable| X["Configure fails; nothing published; fix directory and rerun"]
    X --> B
    R -->|Yes| C{"Migration already published?"}
    C -->|Matching entry is not a file| Y["Configure fails naming the entry; nothing published; fix entry and rerun"]
    Y --> B
    C -->|Yes| D["Existing file remains unchanged"]
    C -->|No| E["Publish receipt migration"]
    D --> M["Host runs Lucid migrations"]
    E --> M
    M --> F["Host invokes guarded commands"]
    F --> G{"Supported connection?"}
    G -->|No| H["Receive dialect or pool/connection error"]
    G -->|Yes| I["Commands use receipt identities"]
```

## Code flow

Scope: configure publication and connection validation; application migration execution is owned by Lucid.

```mermaid
flowchart TD
    A["configure(command)"] --> B["readdir(migrationsPath)"]
    B --> R{"Read error?"}
    R -->|ENOENT| E
    R -->|Other error| X["Rethrow before createCodemods"]
    R -->|No| C{"Suffix exists?"}
    C -->|Not a regular file| Y["Throw naming the entry before createCodemods"]
    C -->|Yes| D["Log skip and return from configure"]
    D --> F
    C -->|No| E["codemods.makeUsingStub publishes migration"]
    E --> F["Host runs Lucid migration; existing file does not prove application"]
    G["execute, executeIn or pruneReceipts"] --> H["assertSupportedConnection"]
    H --> I["Validate dialect, pool and resolved-file ownership"]
    I --> J["Continue or throw before operation query"]
```

**Code references:** [Configure hook](../configure.ts), [migration](../stubs/migrations/create_request_receipts_table.stub), [connection guard](../src/receipts.ts#L104).
