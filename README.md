# @kevinjohn/adonisjs-duplicate-request-guard

Run each request once. When the same request arrives again (a double-click, or a retry after a
dropped connection), the client gets the first result back instead of a second execution.

For AdonisJS 7 and Lucid 22. Each request's receipt is reserved by a unique index and completed in
the same transaction as the request's own writes, so a failed request leaves nothing behind and its
retry runs fresh.

> Pre-release. Installed from GitHub releases; not published to npm.

## Install

```sh
pnpm add https://github.com/Kevinjohn/oss-adonisjs-duplicate-request-guard/releases/download/v0.1.0/kevinjohn-adonisjs-duplicate-request-guard-0.1.0.tgz
node ace configure @kevinjohn/adonisjs-duplicate-request-guard   # publishes the receipts migration once
node ace migration:run
```

Peers: `@adonisjs/core` ^7.0.0, `@adonisjs/lucid` ^22.0.0. Node >= 24. Each release lists its
archive's SHA-256.

## User stories

See the [user story catalogue](user-stories/README.md) for source-reviewed command behavior, transaction boundaries, replay policy and operations.

## Use

```ts
import db from '@adonisjs/lucid/services/db'
import { execute, type Operation } from '@kevinjohn/adonisjs-duplicate-request-guard'

const addNote: Operation<{ body: string }, { proofToken: string }, { noteId: number }> = {
  name: 'notes.add',
  authorizeAccess: async ({ trx, actorId, scopeId }) => {
    /* throw to deny; runs first */
  },
  authorizeReplay: async ({ trx, actorId }, result) => {
    /* runs on every replay */
  },
  parseAuthorization: (raw) => {
    /* validate the opaque input; fresh reservations only */
  },
  authorizeExecute: async ({ trx }, auth) => {
    /* e.g. consume a proof */
  },
  work: async ({ trx, payload }) => ({ noteId: 1 }),
}

// In a controller: pass the client's authorization through untouched.
return execute(db.connection(), addNote, {
  actorId,
  scopeId,
  payload: body.payload,
  command: { commandId, requestKey },
  authorization: body.authorization,
})
```

Order: `authorizeAccess` → reserve → replay: `authorizeReplay` | fresh: `parseAuthorization` →
`authorizeExecute` → `work` → complete. Completion updates only a `pending` row and requires
exactly one.

For commands without authorization, only `name`, `authorizeAccess` and `work` are required.
Omitted `authorizeReplay` and `authorizeExecute` allow the corresponding path. An omitted
`parseAuthorization` ignores the opaque input and passes `undefined` to `authorizeExecute` and
`work`; use `undefined` for the operation authorization type when no parser is needed. If that type
excludes `undefined`, the parser is required so callbacks receive the authorization their type
promises. Supplied policies keep the order above and throw to refuse the command.

```ts
const addPlainNote: Operation<{ body: string }, undefined, { noteId: number }> = {
  name: 'notes.addPlain',
  authorizeAccess: async ({ trx, actorId, scopeId }) => {
    /* require current membership */
  },
  work: async ({ trx, payload }) => ({ noteId: 1 }),
}
```

## Contracts

- **Database.** better-sqlite3 only. Other dialects throw `E_UNSUPPORTED_DIALECT` before any query.
- **Owners.** `execute` opens and commits its own transaction, once, without retrying. Inside a
  transaction you own (for example Account Kit `withCurrent`), call `executeIn(trx, ...)`. The two
  are mutually exclusive: `execute` rejects a transaction client, `executeIn` requires one. Wrapping
  either in your own retry loop is unsupported.
- **Savepoint.** Reservation and the fresh path run under a raw SQL savepoint on the caller's
  transaction, so `context.trx` is that same transaction. Commands compose: `work` may call
  `executeIn(trx, ...)` for another command, open `trx.transaction()`, or query `trx` directly.
- **One command at a time per transaction. Await `executeIn` before issuing any other query on
  that transaction.** Savepoints on one connection are a stack. A call is accepted only when no
  command is open on the `trx`, or from inside the innermost open command's own policies or `work`
  (a nested call). A sibling (`Promise.all` on one trx), a call that lost its async context, or a
  call from a command that already returned is refused at once with `E_CONCURRENT_COMMAND`; it never
  waits. A command that reaches completion while a nested command it started is still open fails
  with `E_UNAWAITED_NESTED_COMMAND` and rolls back both. The package cannot see host queries: a host
  query on `trx` while a command is open runs inside that command's savepoint and is lost if the
  command fails.
- **Aborted nested commands.** When a command fails or unwinds while a nested command it started is
  still running (for example `Promise.all([executeIn(trx, child), validate()])` where `validate`
  rejects first), it marks that nested command aborted and waits for it to settle before rolling
  back. The nested command stops at its next checkpoint (before each of its statements, policies
  and `work`), and anything it wrote stays inside the parent's savepoint, so the rollback removes
  it: no note without a receipt, and a retry runs once. The parent rethrows its own error with the
  nested `E_UNAWAITED_NESTED_COMMAND` as `cause`. Committing afterwards is safe. A nested command
  whose `work` never settles keeps its parent waiting. Once a command starts to complete, replay or
  unwind it accepts no new nested command: a late call from its context gets
  `E_UNAWAITED_NESTED_COMMAND`, since it would outlive the command that should have awaited it.
- **Original errors.** If SQLite already rolled back the whole transaction (`INSERT OR ROLLBACK`, a
  busy abort), the original error, such as `SQLITE_BUSY`, is rethrown; the failed savepoint cleanup
  is attached as its `cause` when it has none.
- **Reruns and failures.** An owner may roll back and rerun the callback, so policies and `work`
  must be database-only and safe to rerun. Any failure rolls the savepoint back, even when the host
  catches it and commits. A failed fresh command leaves no pending receipt or partial work, so its
  identity runs fresh next time. A refused replay preserves its completed receipt; a later permitted
  attempt replays that result.
- **SQLite writers.** better-sqlite3 waits for locks synchronously, so a second in-process writer
  stalls the event loop. `E_UNSAFE_SQLITE_POOL` is thrown when `pool.max` is not 1 (the knex
  default), or when a second open Lucid connection (any name, any Database instance, symlinks
  resolved) runs commands on a file another open connection already used. Closing a connection
  releases its file; every `:memory:` connection is its own database. `executeIn` first takes the
  writer lock with a no-op update, so a commit by another process between the access check and the
  reservation cannot fail the request with `SQLITE_BUSY_SNAPSHOT`.
- **Plain JSON only.** Payloads and results must be plain objects (including null-prototype
  objects), arrays, strings, finite numbers, booleans or null; shared references are fine, cycles
  are not. Anything else (Dates, Maps, BigInt, NaN, class instances, functions, cycles) is refused
  before anything commits: `E_INVALID_COMMAND_VALUE` (400) for payloads, checked before
  `authorizeAccess`, `E_INVALID_COMMAND_RESULT` (500) for results. A replay returns JSON-equal data
  (-0 comes back as 0).
- **Identity scope.** Command ids and request keys are scoped to one actor's operation. Another
  actor using the same ids runs its own command and learns nothing about yours.
- **Pruning.** `pruneReceipts(db.connection(), { olderThan })` deletes completed receipts updated
  strictly before `olderThan`. A pruned identity executes fresh again, so keep receipts as long as
  clients may retry.

## Errors

`errors.*` / `E_*` exports, all `@adonisjs/core` exceptions: `E_DUPLICATE_REQUEST_CONFLICT` (409),
`E_DUPLICATE_REQUEST_IN_PROGRESS` (409, only on re-entry from the command's own `work`),
`E_INVALID_COMMAND_VALUE` (400), `E_CONCURRENT_COMMAND`, `E_UNAWAITED_NESTED_COMMAND`,
`E_INVALID_COMMAND_RESULT`, `E_RECEIPT_NOT_PENDING`,
`E_RECEIPT_SCHEMA` (receipts table from an older stub), `E_TRANSACTION_OWNER`,
`E_UNSAFE_SQLITE_POOL`, `E_UNSUPPORTED_DIALECT` (500).
