import { mkdir, readdir, rmdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { RuntimeException } from '@adonisjs/core/exceptions'
import { pathToFileURL } from 'node:url'
import { sourceFiles } from '@adonisjs/lucid/utils'
import type Configure from '@adonisjs/core/commands/configure'

import { stubsRoot } from './stubs/main.ts'

const MIGRATION_IDENTITY = '_create_request_receipts_table'
const MIGRATION_SUFFIX = `${MIGRATION_IDENTITY}.ts`

async function hasReceiptsMigration(migrationsPath: string): Promise<boolean> {
  const entries = await readdir(migrationsPath, { withFileTypes: true, recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    }
  )
  for (const entry of entries) {
    if (entry.name.endsWith(MIGRATION_SUFFIX) && !entry.isFile()) {
      throw new RuntimeException(
        `${join(entry.parentPath, entry.name)} matches the receipts migration name but is not a regular file; replace it with a regular migration file or remove it and rerun configure`
      )
    }
  }
  if (entries.length === 0) return false
  const { files } = await sourceFiles(pathToFileURL(migrationsPath + sep), './', false)
  return files.some(
    ({ absPath, name }) => !absPath.endsWith('.json') && name.endsWith(MIGRATION_IDENTITY)
  )
}

/** Publishes the receipts migration once, with an exclusive publication claim. */
export async function configure(command: Configure) {
  const migrationsPath = command.app.migrationsPath()
  // Anchor transient coordination at the existing app root. Codemods create the
  // migrations directory only when they publish its first migration.
  const claim = command.app.makePath('.request-receipts-configure.lock')
  try {
    await mkdir(claim)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new RuntimeException(
      `request receipts migration publication is already claimed; wait for configure to finish and rerun. If it stopped unexpectedly, remove the empty directory listed below before rerunning. Lock directory: ${claim}`
    )
  }
  try {
    // Decide only while holding the claim; no other configure can publish concurrently.
    if (await hasReceiptsMigration(migrationsPath)) {
      command.logger.info('request receipts migration already exists, skipping')
      return
    }
    const codemods = await command.createCodemods()
    await codemods.makeUsingStub(stubsRoot, 'make/migration/create_request_receipts_table.stub', {
      migration: {
        filename: `${Date.now()}${MIGRATION_SUFFIX}`,
      },
    })
  } finally {
    await rmdir(claim)
  }
}
