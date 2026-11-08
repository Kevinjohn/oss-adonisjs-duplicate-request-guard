import { assert } from '@japa/assert'
import { processCLIArgs, configure, run } from '@japa/runner'

processCLIArgs(process.argv.slice(2))
configure({
  files: ['tests/**/*.spec.ts'],
  plugins: [assert()],
  timeout: 10_000,
  // Japa exits 0 when its filters select nothing; a gate that ran no tests checked nothing.
  teardown: [
    (runner) => {
      if (runner.getSummary().aggregates.total > 0) return
      console.error('No tests executed: check the --files, --tests and --groups filters')
      process.exitCode = 1
    },
  ],
})

// Awaited at the top level: if a test never settles, Node exits 13 (unsettled top-level await).
await run()
