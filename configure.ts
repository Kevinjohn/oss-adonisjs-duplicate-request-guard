import { mkdir, readdir, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeException } from '@adonisjs/core/exceptions'
import { fileURLToPath } from 'node:url'
import type Configure from '@adonisjs/core/commands/configure'

/** Directory holding the package stubs, next to this file in source and in build. */
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))

const MIGRATION_SUFFIX = '_create_request_receipts_table.ts'

async function hasReceiptsMigration(migrationsPath: string): Promise<boolean> {
  const entries = await readdir(migrationsPath, { withFileTypes: true })
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
  return matching.length > 0
}

/** Publishes the receipts migration once, with an exclusive publication claim. */
export async function configure(command: Configure) {
  const migrationsPath = command.app.migrationsPath()
  // A new app has no migrations directory; any other read failure must stop configure.
  await readdir(migrationsPath).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    await mkdir(migrationsPath, { recursive: true })
  })
  const claim = join(migrationsPath, '.request-receipts-configure.lock')
  try {
    await mkdir(claim)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new RuntimeException(
      'request receipts migration publication is already claimed; wait for configure to finish and rerun. If it stopped unexpectedly, remove the empty .request-receipts-configure.lock directory before rerunning.'
    )
  }
  try {
    // Decide only while holding the claim; no other configure can publish concurrently.
    if (await hasReceiptsMigration(migrationsPath)) {
      command.logger.info('request receipts migration already exists, skipping')
      return
    }
    const codemods = await command.createCodemods()
    await codemods.makeUsingStub(stubsRoot, 'migrations/create_request_receipts_table.stub', {
      migration: {
        destination: command.app.migrationsPath(`${Date.now()}${MIGRATION_SUFFIX}`),
      },
    })
  } finally {
    await rmdir(claim)
  }
}
