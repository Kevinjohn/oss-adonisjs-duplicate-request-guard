# @kevinjohn/adonisjs-request-deduplication

Run each request once. When the same request arrives again (a double-click, or a retry after a
dropped connection), the client gets the first result back instead of a second execution.

For AdonisJS 7 and Lucid 22. Each request's receipt is reserved by a unique index and completed in
the same transaction as the request's own writes, so a failed request leaves nothing behind and its
retry runs fresh.

> Pre-release. Distributed through GitHub release archives.

## Install

Download the `kevinjohn-adonisjs-request-deduplication-*.tgz` archive from the
[releases page](https://github.com/Kevinjohn/oss-adonisjs-duplicate-request-guard/releases)
and install it from your application. Each release lists the archive's SHA-256.

```sh
pnpm add /path/to/downloaded-archive.tgz
node ace configure @kevinjohn/adonisjs-request-deduplication
node ace migration:run
```

The package name changes in the next release. For `0.3.1` and earlier, follow the
[README for that release](https://github.com/Kevinjohn/oss-adonisjs-duplicate-request-guard/blob/v0.3.1/README.md).

## What configure changes

`configure` publishes one receipts migration to `app.migrationsPath()`, which defaults to
`database/migrations`. It preserves an existing regular receipts migration in that directory or
its subdirectories. If configure reports a matching symlink or other non-file entry, replace it
with a regular migration file or remove it before rerunning.

If another configure run owns publication, let it finish and rerun. If it stops unexpectedly,
confirm that no configure process is still running before removing the empty lock directory
named in the error. Run configure processes for the same application with the same system
temporary directory.

## Configuration

Configure a Lucid `better-sqlite3` connection with a pool maximum of one. If your connection
sets its own `migrations.paths`, include the directory where configure publishes the migration
or move the file into one of those paths before running migrations. The package takes its settings
from the Lucid connection and the inputs you pass to its API.

## Usage

Request deduplication protects database writes made through the operation's transaction. If an email or
webhook must survive retries, record it in the same transaction and let a separate delivery
process send it.

```ts
import db from '@adonisjs/lucid/services/db'
import { execute, type Operation } from '@kevinjohn/adonisjs-request-deduplication'

const createNote: Operation<{ body: string }, undefined, { noteId: number }> = {
  name: 'notes.create',
  authorizeAccess: async ({ trx, actorId }) => {
    const user = await trx.from('users').where('id', actorId).first()
    if (!user) throw new Error('User no longer exists')
  },
  work: async ({ trx, actorId, payload }) => {
    const [noteId] = await trx.table('notes').insert({ user_id: actorId, body: payload.body })
    return { noteId }
  },
}

// In an authenticated controller, derive actorId from the signed-in user and validate the
// request data. The client supplies the same commandId and requestKey on each retry.
// scopeId and the operation name are host-owned; never accept them as unchecked request fields.
return execute(db.connection(), createNote, {
  actorId,
  scopeId: actorId,
  payload: { body },
  command: { commandId, requestKey },
})
```

The first call inserts one row and returns its ID with `replayed: false`. A retry with the same
identity, scope and payload returns that ID with `replayed: true`. The note is still stored once.
The [API starter](https://github.com/Kevinjohn/oss-adonisjs-starter-examples/blob/v0.17.0/apps/api/app/controllers/notes_controller.ts)
and its [functional test](https://github.com/Kevinjohn/oss-adonisjs-starter-examples/blob/v0.17.0/apps/api/tests/functional/notes.spec.ts)
show the full request and check the stored rows.

`authorizeAccess` runs on both calls. For this minimal receipt it suffices because the note ID
belongs to the same authenticated account. If a receipt contains a project result that is only
visible while the caller retains a particular project role, use `authorizeReplay` to check that
role against the stored result before returning it.

For a protected operation, pass the client's authorisation through untouched. Put single-use
proof parsing in `parseAuthorization` and proof consumption in `authorizeExecute`, before the
write and inside the same transaction. Neither runs on replay. If `parseAuthorization` is
omitted, its `Authorization` type must admit `undefined`; the `authorization` input is then ignored.
Both `authorizeReplay` and `authorizeExecute` are optional and throw to refuse their path.

The order is `authorizeAccess` → reserve → replay: `authorizeReplay` | fresh: `parseAuthorization`
→ `authorizeExecute` → `work` → complete. Completion updates exactly one pending row.

## Contracts

- **Database.** better-sqlite3 only. Other dialects throw `RuntimeException` before any query.
- **Owners.** `execute` opens and commits its own transaction, once, without retrying. Inside a
  transaction you own (for example Account Kit `withCurrent`), call `executeIn(trx, ...)`. The two
  are mutually exclusive: `execute` rejects a transaction client, `executeIn` requires one. Wrapping
  either in your own retry loop is unsupported. `execute(db.connection(), ...)` called from inside
  another transaction is not detected, because the base connection is not a transaction client: the
  outer transaction holds the pool's only connection, so the call waits and fails with knex's
  acquire timeout. Pass the active transaction to `executeIn` instead.
- **Savepoint.** Reservation and the fresh path run under a raw SQL savepoint on the caller's
  transaction, so `context.trx` is that same transaction. Operations compose: `work` may call
  `executeIn(trx, ...)` for another operation, open `trx.transaction()`, or query `trx` directly.
- **One operation at a time per transaction. Await `executeIn` before issuing any other query on
  that transaction.** Savepoints on one connection are a stack. A call is accepted only when no
  operation is open on the `trx`, or from inside the innermost open operation's own authorisation callbacks or `work`
  (a nested call). A sibling (`Promise.all` on one trx), a call that lost its async context, or a
  call from an operation that already returned is refused at once with `E_CONCURRENT_COMMAND`; it never
  waits. An operation that reaches completion while a nested operation it started is still open fails
  with `E_UNAWAITED_NESTED_COMMAND` and rolls back both. The package cannot see host queries: a host
  query on `trx` while an operation is open runs inside that operation's savepoint and is lost if the
  operation fails.
- **Aborted nested operations.** When an operation fails or unwinds while a nested operation it started is
  still running (for example `Promise.all([executeIn(trx, child), validate()])` where `validate`
  rejects first), it marks that nested operation aborted and waits for it to settle before rolling
  back. The nested operation stops at its next checkpoint (before each of its statements, authorisation callbacks
  and `work`), and anything it wrote stays inside the parent's savepoint, so the rollback removes
  it: no note without a receipt, and a retry runs once. The parent rethrows its own error with the
  nested `E_UNAWAITED_NESTED_COMMAND` as `cause`: the same error the nested call rejects with, whose
  own `cause` is the nested callback's error when it threw one. A parent error that already has a
  `cause`, or a thrown value that cannot carry one (not an `Error`, frozen, or with a read-only
  `cause`), is rethrown as it is. Committing afterwards is safe. A
  nested operation whose `work` never settles keeps its parent waiting. The abort reaches every open
  operation nested below as well. Once an operation starts to complete, replay or unwind, or is aborted,
  it accepts no new nested operation: a late call from its context gets `E_UNAWAITED_NESTED_COMMAND`,
  since it would outlive the operation that should have awaited it. When a parent fails because of
  a nested operation that was still open, and so reports it as `cause`, the package observes that
  nested promise, so dropping it does not additionally cause an unhandled rejection. A dropped nested
  operation that fails and settles before its parent finishes is reported by nobody: its rejection
  stays unhandled, as in v0.1.3, and the parent can still complete. Awaiting the child still
  rejects; callers must await nested work.
- **Original errors.** If SQLite already rolled back the whole transaction (`INSERT OR ROLLBACK`, a
  busy abort), the original error, such as `SQLITE_BUSY`, is rethrown; the failed savepoint cleanup
  is attached as its `cause` when it has none. That transaction is over even though Lucid still
  reports it open: do not catch the error and carry on, roll the transaction back and start a new
  one. Until you do, `executeIn` on that client or on any child transaction of it is refused with
  `E_TRANSACTION_LOST`, and an operation still open around the failed one stops at its next
  checkpoint. The same holds when one of your own statements ended the transaction (a failed
  `INSERT OR ROLLBACK`, a raw `COMMIT`), with two limits. The package watches a Lucid connection
  only from its first deduplicated call on it, so call `assertSupportedConnection(db.connection())` at
  boot, and again after closing and reopening a connection, to cover transactions before that.
  And a statement issued on the transaction without awaiting the one that ended it can slip past
  the check. Your own later queries on a lost transaction autocommit.
- **Reruns and failures.** An owner may roll back and rerun the callback, so authorisation callbacks and `work`
  must be database-only and safe to rerun. Any failure rolls the savepoint back, even when the host
  catches it and commits. A failed fresh operation leaves no pending receipt or partial work, so its
  identity runs fresh next time. A refused replay preserves its completed receipt; a later permitted
  attempt replays that result.
- **SQLite writers.** better-sqlite3 waits for locks synchronously, so a second in-process writer
  stalls the event loop. `RuntimeException` is thrown when `pool.max` is not 1 (the knex
  default), or when a second open Lucid connection (any name, any Database instance, symlinks
  resolved, surrounding whitespace trimmed as the driver does) runs operations on a file another open
  connection already used. Hard-linked paths and `file:` URI filenames are not detected. Closing a
  connection releases its file; every `:memory:` or blank-filename connection is its own database. `executeIn` first takes the
  writer lock with a no-op update, so a commit by another process between the access check and the
  reservation cannot fail the request with `SQLITE_BUSY_SNAPSHOT`.
- **Plain JSON only.** Payloads and results must be plain objects (including null-prototype
  objects), arrays, strings, finite numbers, booleans or null; shared references are fine, cycles
  are not. Every own key must be an enumerable data property: getters, setters and non-enumerable
  keys are refused, and no method of the value is called. Anything else (Dates, Maps, BigInt, NaN,
  class instances, functions, cycles) is refused
  before anything commits: `E_INVALID_COMMAND_VALUE` (400) for payloads, checked before
  `authorizeAccess`, `E_INVALID_COMMAND_RESULT` (500) for results. A replay returns JSON-equal data
  (-0 comes back as 0), whatever `authorizeReplay` did to the copy it was given: redact or decorate
  the result after `execute` returns. Actor, scope and request identity are read once when the call
  starts; keep the payload itself unchanged until the call settles.
- **Identity scope.** Command ids and request keys are scoped to one actor's operation. Another
  actor using the same ids runs its own operation and learns nothing about yours. Command ids and
  request keys must be well-formed Unicode strings (no lone surrogates); others are refused with
  `E_INVALID_COMMAND_VALUE` (400) before `authorizeAccess`.
- **Pruning.** `pruneReceipts(db.connection(), { olderThan })` deletes completed receipts updated
  strictly before `olderThan`. A pruned identity executes fresh again, so keep receipts as long as
  clients may retry.

## Errors

Match an operation failure by its `code` or with `instanceof errors.E_<CODE>`, for example
`error instanceof errors.E_DUPLICATE_REQUEST_CONFLICT`. The same code-named constructors are
available as named imports from the package.

The operation exceptions are `E_DUPLICATE_REQUEST_CONFLICT` (409),
`E_DUPLICATE_REQUEST_IN_PROGRESS` (409, only on re-entry from the operation's own `work` or authorisation callbacks),
`E_INVALID_COMMAND_VALUE` (400), `E_CONCURRENT_COMMAND`, `E_UNAWAITED_NESTED_COMMAND`,
`E_INVALID_COMMAND_RESULT`, `E_RECEIPT_NOT_PENDING`,
`E_RECEIPT_SCHEMA` (receipts table from an older stub) and `E_TRANSACTION_LOST` (500).

A mismatched transaction client throws `InvalidArgumentsException` from
`@adonisjs/core/exceptions`. An unsupported database dialect or unsafe SQLite pool or writer
configuration throws `RuntimeException` from the same module.

## Supported versions

Use Node 24 or newer, AdonisJS Core ^7.0.0 and Lucid ^22.0.0. The configure hook declares
Assembler ^8.6.0 as an optional peer. The clean consumer checks exercise this migration
with the current and minimum Core and Lucid versions.

## User stories

The [user story catalogue](https://github.com/Kevinjohn/oss-adonisjs-duplicate-request-guard/blob/main/user-stories/README.md)
covers operation behaviour, transaction boundaries, replay authorisation and receipt storage.
