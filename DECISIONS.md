# Decisions

## Departures

2. **Aligning (#117)** — TOOL-3. The isolated release consumer at `examples/release-consumer/tsconfig.json` uses explicit compiler options until it can declare `@adonisjs/tsconfig` and extend the application preset. Its smoke script installs the fixture in a fresh temporary directory, without the root development dependencies; Core does not ship the preset as a runtime dependency. Adding the preset is outside the current dependency freeze, and extending an unavailable preset would break the consumer check. [#117](https://github.com/Kevinjohn/oss-adonisjs-duplicate-request-guard/issues/117) adds that development dependency, aligns the configuration and removes this entry and its checker mapping.
