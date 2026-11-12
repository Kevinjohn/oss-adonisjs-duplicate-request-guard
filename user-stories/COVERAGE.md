# Capability coverage

“New” means newly documented, not newly implemented. Test links identify useful source evidence; no runtime tests were run for this catalogue.

| Story                                             | Action                                                    | Access                                                 | Status   | Catalogue |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ | -------- | --------- |
| [US-GUARD-01](US-GUARD-01-execute-command.md)     | Execute once or return matching stored result             | Host-authorized actor and operation                    | Current  | New       |
| [US-GUARD-02](US-GUARD-02-compose-transaction.md) | Compose command inside a host-owned transaction           | Active transaction; sequential or properly nested call | Current  | New       |
| [US-GUARD-03](US-GUARD-03-authorize-replay.md)    | Recheck current authorization before returning old result | Current access and replay policies                     | Current  | New       |
| [US-GUARD-04](US-GUARD-04-operate-receipts.md)    | Install receipt migration and supported connection        | Application operator                                   | Operator | New       |
| [US-GUARD-05](US-GUARD-05-prune-receipts.md)      | Remove completed receipts before cutoff                   | Host operator/scheduler                                | Operator | New       |

Public exports mapped: `RECEIPTS_TABLE`, `assertSupportedConnection`, `execute`, `executeIn`, `pruneReceipts`, `errors`, named error exports, and all public operation/input/result/options types. No prior story catalogue existed; all rows are newly documented.
