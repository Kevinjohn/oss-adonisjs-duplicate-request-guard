import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type Configure from '@adonisjs/core/commands/configure'

/** Directory holding the package stubs, next to this file in source and in build. */
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))

const MIGRATION_SUFFIX = '_create_request_receipts_table.ts'

/** Publishes the receipts migration once. A second run leaves the existing migration alone. */
export async function configure(command: Configure) {
  const migrationsPath = command.app.migrationsPath()
  const existing = await readdir(migrationsPath).catch(() => [] as string[])
  if (existing.some((file) => file.endsWith(MIGRATION_SUFFIX))) {
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
