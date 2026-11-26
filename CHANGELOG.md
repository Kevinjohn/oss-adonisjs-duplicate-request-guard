# Changelog

## Unreleased

### Breaking changes

- The package is now `@kevinjohn/adonisjs-request-deduplication`. Remove
  `@kevinjohn/adonisjs-duplicate-request-guard`, install the new release archive, and update
  root and `/types` imports and any Ace configure commands to use the new package name.
- Import `requestDeduplicator` and call its `execute`, `executeIn`, `pruneReceipts` and
  `assertSupportedConnection` methods. Replace the four previous named function imports.
- Replace `ExecuteInput.command` with `ExecuteInput.requestIdentity` in calls to `execute` and
  `executeIn`. Replace imports of `CommandIdentity` with `RequestIdentity`. Keep sending the
  same `commandId` and `requestKey` values on retries. Existing migrations and stored receipts
  continue to work without a database change.
- Replace catches for `E_TRANSACTION_OWNER` with `InvalidArgumentsException` and catches for
  `E_UNSAFE_SQLITE_POOL` or `E_UNSUPPORTED_DIALECT` with `RuntimeException`, imported from
  `@adonisjs/core/exceptions`. The three old exports and their named exception classes have
  been removed.

### Changed

- Configure publishes the migration through the framework codemod. It takes its publication
  lock at the application root and reports the full path if a lock is already held.
  Finish any configure run using the old release before upgrading.
- Assembler ^8.6.0 is declared as an optional peer for configure tooling.
- Releases reuse the successful `checks.yml` push or manual run for the exact commit on `main` before
  building and validating the release archive.

## 0.3.1 - 2026-11-25

- Exercise transaction composition against the published Account Kit `0.8.0` archive.

## 0.3.0 - 2026-11-24

- Exercise the transaction bridge with Account Kit 0.7.0.
- Throw guard exceptions through their existing `E_*` exports and use the classes' static
  codes, statuses and fixed messages. Existing exception exports remain available.
- Add TypeScript examples for `assertSupportedConnection`, `executeIn`, `execute` and
  `pruneReceipts`.

## 0.2.3 - 2026-11-24

- Clarify operation identity, nested execution in the same transaction and rollback when a work result fails validation.
- Exercise the transaction bridge with Account Kit 0.6.1.

## 0.2.2 - 2026-11-23

- Test against Account Kit 0.5.2.
- Changed: correction to 0.2.0, whose entry omitted two behaviour changes. Configure takes an
  exclusive publication claim, a temporary `.request-receipts-configure.lock` directory in the
  migrations directory, so a simultaneous configure fails and must be rerun. A nested `executeIn`
  promise was observed by the package so that dropping it raised no unhandled rejection.
- Fixed: a dropped nested `executeIn` that failed and settled before its parent finished was
  swallowed since 0.2.0, and the parent could commit. Its rejection is unhandled again, as in
  0.1.3; a nested operation the parent reports as its failure's `cause` still raises none.
- Changed: the "already claimed" configure error names the absolute lock directory path.
- Changed: a SQLite database path that cannot be inspected for any reason other than a file not
  created yet (for example a link loop, or a file used as a directory) now fails the connection
  check with that filesystem error instead of being registered under its directory's real path.

## 0.2.1 - 2026-11-22

- Test against Account Kit 0.5.1.
- Capture operation identity before managed transaction acquisition.
- Recognize nested receipts migrations and reject matching symlinks during configure.

## 0.2.0 - 2026-11-21

- Test against Account Kit 0.5.0.
- Document and verify the package user stories and implementation flows.

## 0.1.3 - 2026-11-21

- Test against Account Kit 0.4.2.

## 0.1.2 - 2026-11-20

- Document a transactional note insert and its replay using the API starter. Explain when to
  authorize replay separately, when to consume single-use authorization, and how to handle external
  effects such as email and webhooks.

## 0.1.1 - 2026-11-19

- Fixed: after SQLite ended a host transaction (`INSERT OR ROLLBACK`, a busy abort), a later
  `executeIn` on the same client could commit its receipt and writes. Commands on that client and
  its child transactions are now refused with the new `E_TRANSACTION_LOST` until the transaction
  is rolled back. See "Original errors" in the README for the two limits.
- Fixed: an error whose `cause` accessor throws could skip the rollback of a command with an open
  nested command.
- Fixed: a command id or request key that is not well-formed Unicode ran once and then conflicted
  with its own retry. It is now refused with `E_INVALID_COMMAND_VALUE` before any policy runs.
- Fixed: `pruneReceipts` with a cutoff beyond year 9999 deleted nothing; it now deletes every
  completed receipt.
- Fixed: payloads and results with getters, setters or non-enumerable keys passed validation and
  could replay a different value. They are refused like other non-plain data.
- Fixed: a SQLite filename with surrounding whitespace bypassed the single-writer check, and closed
  connections stayed in its registry.
- Fixed: an aborted nested command could start further nested commands, an open grandchild was not
  aborted, and the `cause` attached to the parent could differ from the error the child rejected
  with.
- Changed: `authorizeReplay` receives its own copy of the stored result, so a policy that edits it
  no longer changes what the caller gets. Redact after `execute` returns.
- Fixed: a callback that mutated the input's command identity, actor or scope during the call could
  make completion miss the reserved receipt. They are read once when the call starts.

- Verify the packed guard and transaction-loss handling against the supported consumer profiles.
  The Account Kit integration fixture uses 0.4.1.

## 0.1.0 - 2026-11-08

First release.

- `execute` (opens its own transaction) and `executeIn` (runs in your transaction). A request's
  receipt is reserved by a unique index and completed with the request's own writes; a repeat gets
  the stored result.
- A required `authorizeAccess` policy, and optional `authorizeReplay`, `parseAuthorization` and
  `authorizeExecute` policies. An omitted optional policy allows; a parser is required when the
  authorization type excludes `undefined`.
- Requests nest safely: one at a time per transaction (`E_CONCURRENT_COMMAND`), unawaited nested
  requests are rolled back (`E_UNAWAITED_NESTED_COMMAND`), and an aborted nested request stops at its
  next checkpoint.
- Plain-JSON payloads and results (`E_INVALID_COMMAND_VALUE`, `E_INVALID_COMMAND_RESULT`).
- better-sqlite3 only, with a single-connection pool check (`E_UNSAFE_SQLITE_POOL`) and the writer
  lock taken before the first read.
- `pruneReceipts`, typed errors, and `node ace configure` publishing the `request_receipts`
  migration.
