import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { execute } from '../index.js'
import { addProof, createDatabase, input, loadMigration, noteOperation } from './helpers.js'

const PACKAGE = '@kevinjohn/adonisjs-duplicate-request-guard'

test('configure publishes the receipts migration once, and it works', async ({ assert }) => {
  const root = await mkdtemp(join(tmpdir(), 'adonisjs-duplicate-request-guard-configure-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      '{"type":"module","devDependencies":{"@adonisjs/assembler":"8.6.0"}}'
    )
    await writeFile(join(root, 'tsconfig.json'), '{}')
    await writeFile(
      join(root, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`
    )
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(root, 'node_modules')
    )
    const importer = (specifier: string) =>
      specifier === PACKAGE
        ? import(new URL('../index.ts', import.meta.url).href)
        : import(specifier)
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: { providers: [], commands: [async () => new ListLoader([Configure])] },
      })
      .create(pathToFileURL(`${root}/`), { importer })

    await ignitor.ace().handle(['configure', PACKAGE])
    await mkdir(join(root, 'database/migrations'), { recursive: true })
    await ignitor.ace().handle(['configure', PACKAGE])
    const files = await readdir(join(root, 'database/migrations'))
    assert.lengthOf(files, 1)
    assert.match(files[0], /^\d+_create_request_receipts_table\.ts$/)

    const published = await readFile(join(root, 'database/migrations', files[0]), 'utf8')
    const Migration = await loadMigration(published)
    const { client } = await createDatabase()
    await client.schema.dropTable('request_receipts')
    await new Migration(client, 'published', false).execUp()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    const replay = await execute(client, operation, input(1))
    assert.isTrue(replay.replayed)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}).timeout(20_000)
