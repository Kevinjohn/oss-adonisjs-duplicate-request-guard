# User story catalogue

Source baseline: `1a32e0a52155e01af5058292c6a291d1c1e72723` (origin/main, 2026-11-12). Scope: public exports and operation contract, fresh execution and replay, transaction composition, concurrency/nesting failure behavior, SQLite connection constraints, and pruning. Source-reviewed only; no runtime journeys were exercised for this catalogue.

## Index

| Story                                             | Action                                           | Status   |
| ------------------------------------------------- | ------------------------------------------------ | -------- |
| [US-GUARD-01](US-GUARD-01-execute-command.md)     | Run a guarded command once and replay its result | Current  |
| [US-GUARD-02](US-GUARD-02-compose-transaction.md) | Guard a command inside an owned transaction      | Current  |
| [US-GUARD-03](US-GUARD-03-authorize-replay.md)    | Reauthorize access to a stored result            | Current  |
| [US-GUARD-04](US-GUARD-04-operate-receipts.md)    | Install receipt storage                          | Operator |
| [US-GUARD-05](US-GUARD-05-prune-receipts.md)      | Remove receipts past the retry horizon           | Operator |

## Files

- [Template and maintenance rules](TEMPLATE.md)
- [Roles, interfaces and source map](REFERENCE.md)
- [Capability coverage](COVERAGE.md)
- [Decision gaps](GAPS.md)
