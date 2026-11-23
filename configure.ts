import { mkdir, readdir, rmdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { RuntimeException } from '@adonisjs/core/exceptions'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sourceFiles } from '@adonisjs/lucid/utils'
import type Configure from '@adonisjs/core/commands/configure'

/** Directory holding the package stubs, next to this file in source and in build. */
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))

const MIGRATION_IDENTITY = '_create_request_receipts_table'
const MIGRATION_SUFFIX = `${MIGRATION_IDENTITY}.ts`

async function hasReceiptsMigration(migrationsPath: string): Promise<boolean> {
  const entries = await readdir(migrationsPath, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (entry.name.endsWith(MIGRATION_SUFFIX) && !entry.isFile()) {
      throw new RuntimeException(
        `${join(entry.parentPath, entry.name)} matches the receipts migration name but is not a regular file; replace it with a regular migration file or remove it and rerun configure`
      )
    }
  }
  const { files } = await sourceFiles(pathToFileURL(migrationsPath + sep), './', false)
  return files.some(
    ({ absPath, name }) => !absPath.endsWith('.json') && name.endsWith(MIGRATION_IDENTITY)
  )
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
      `request receipts migration publication is already claimed; wait for configure to finish and rerun. If it stopped unexpectedly, remove the empty .request-receipts-configure.lock directory before rerunning. Lock directory: ${claim}`
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
