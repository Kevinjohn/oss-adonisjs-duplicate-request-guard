# User story catalogue

Scope: the current public exports and operation contract, fresh execution and replay, transaction composition, concurrency/nesting failure behaviour, SQLite connection constraints, and pruning. Story status describes availability, not a test result. The linked focused tests and packed consumer cover these contracts.

## Index

| Story                                             | Action                                             | Status   |
| ------------------------------------------------- | -------------------------------------------------- | -------- |
| [US-GUARD-01](US-GUARD-01-execute-command.md)     | Run a deduplicated operation once                  | Current  |
| [US-GUARD-02](US-GUARD-02-compose-transaction.md) | Deduplicate an operation inside a host transaction | Current  |
| [US-GUARD-03](US-GUARD-03-authorize-replay.md)    | Reauthorise access before replaying a result       | Current  |
| [US-GUARD-04](US-GUARD-04-operate-receipts.md)    | Install receipt storage                            | Operator |
| [US-GUARD-05](US-GUARD-05-prune-receipts.md)      | Remove completed receipts past the retry horizon   | Operator |
| [US-GUARD-06](US-GUARD-06-recover-transaction.md) | Recover after the transaction ends unexpectedly    | Current  |

## Files

- [Template and maintenance rules](TEMPLATE.md)
- [Roles, interfaces and source map](REFERENCE.md)
- [Capability coverage](COVERAGE.md)
- [Decision gaps](GAPS.md)
