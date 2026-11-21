# Capability coverage

Each row maps a reachable outcome to its story and the conditions under which it can be used.

| Story                                             | Action                                                    | Access                                                 | Status   |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ | -------- |
| [US-GUARD-01](US-GUARD-01-execute-command.md)     | Execute once or return matching stored result             | Host-authorised actor and operation                    | Current  |
| [US-GUARD-02](US-GUARD-02-compose-transaction.md) | Compose operation inside a host-owned transaction         | Active transaction; sequential or properly nested call | Current  |
| [US-GUARD-03](US-GUARD-03-authorize-replay.md)    | Recheck current authorisation before returning old result | Current access and optional replay authorisation       | Current  |
| [US-GUARD-04](US-GUARD-04-operate-receipts.md)    | Install receipt migration and supported connection        | Application operator                                   | Operator |
| [US-GUARD-05](US-GUARD-05-prune-receipts.md)      | Remove completed receipts before cutoff                   | Host operator/scheduler                                | Operator |
| [US-GUARD-06](US-GUARD-06-recover-transaction.md) | Recover from a lost SQLite transaction                    | Host transaction owner                                 | Current  |

Public exports mapped: `RECEIPTS_TABLE`, `assertSupportedConnection`, `configure` (US-GUARD-04), the `./types` subpath export, `execute`, `executeIn`, `pruneReceipts`, `errors`, named error exports, and all public operation/input/result/options types. The recovery story traces the transaction-lost error and its relationship to a fresh transaction.
