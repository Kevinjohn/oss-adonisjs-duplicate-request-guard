# Changelog

## Unreleased

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
