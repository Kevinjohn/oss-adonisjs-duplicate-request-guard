# User story catalogue

Source baseline: `6ff12225c8a7698d145798ad705e7a9d5f193c45` (origin/main, 2026-11-14). Scope: public exports and operation contract, fresh execution and replay, transaction composition, concurrency/nesting failure behavior, SQLite connection constraints, and pruning. Source-reviewed only; no runtime journeys were exercised for this catalogue.

## Index

| Story                                             | Action                                           | Status   |
| ------------------------------------------------- | ------------------------------------------------ | -------- |
| [US-GUARD-01](US-GUARD-01-execute-command.md)     | Run a guarded command once                       | Current  |
| [US-GUARD-02](US-GUARD-02-compose-transaction.md) | Guard a command inside a host transaction        | Current  |
| [US-GUARD-03](US-GUARD-03-authorize-replay.md)    | Reauthorize access before replaying a result     | Current  |
| [US-GUARD-04](US-GUARD-04-operate-receipts.md)    | Install receipt storage                          | Operator |
| [US-GUARD-05](US-GUARD-05-prune-receipts.md)      | Remove completed receipts past the retry horizon | Operator |

## Files

- [Template and maintenance rules](TEMPLATE.md)
- [Roles, interfaces and source map](REFERENCE.md)
- [Capability coverage](COVERAGE.md)
- [Decision gaps](GAPS.md)
