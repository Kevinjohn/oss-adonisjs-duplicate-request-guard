import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeException } from '@adonisjs/core/exceptions'
import { fileURLToPath } from 'node:url'
import type Configure from '@adonisjs/core/commands/configure'

/** Directory holding the package stubs, next to this file in source and in build. */
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))

const MIGRATION_SUFFIX = '_create_request_receipts_table.ts'

/** Publishes the receipts migration once. A second run leaves the existing migration alone. */
export async function configure(command: Configure) {
  const migrationsPath = command.app.migrationsPath()
  const entries = await readdir(migrationsPath, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      // A new app has no migrations directory yet; any other read failure must stop configure.
      if (error.code === 'ENOENT') return []
      throw error
    }
  )
  const matching = entries.filter((entry) => entry.name.endsWith(MIGRATION_SUFFIX))
  for (const entry of matching) {
    // A link counts when it resolves to a regular file; a directory or broken link provides no table.
    const usable =
      entry.isFile() ||
      (entry.isSymbolicLink() &&
        (await stat(join(migrationsPath, entry.name)).then(
          (info) => info.isFile(),
          () => false
        )))
    if (!usable) {
      throw new RuntimeException(
        `${join(migrationsPath, entry.name)} matches the receipts migration name but is not a regular file; remove or replace it and rerun configure`
      )
    }
  }
  if (matching.length > 0) {
    command.logger.info('request receipts migration already exists, skipping')
    return
  }
  const codemods = await command.createCodemods()
  await codemods.makeUsingStub(stubsRoot, 'migrations/create_request_receipts_table.stub', {
    migration: {
      destination: command.app.migrationsPath(`${Date.now()}${MIGRATION_SUFFIX}`),
    },
  })
}
