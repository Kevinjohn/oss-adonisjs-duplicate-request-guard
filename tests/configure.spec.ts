import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { configure } from '../configure.js'
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

    // First run on a fresh app: no migrations directory exists yet.
    const migrationsDir = join(root, 'database/migrations')
    await ignitor.ace().handle(['configure', PACKAGE])
    const files = await readdir(migrationsDir)
    assert.lengthOf(files, 1)
    assert.match(files[0], /^\d+_create_request_receipts_table\.ts$/)
    const published = await readFile(join(migrationsDir, files[0]), 'utf8')

    // A rerun keeps the first file and its contents.
    await ignitor.ace().handle(['configure', PACKAGE])
    assert.deepEqual(await readdir(migrationsDir), files)
    assert.equal(await readFile(join(migrationsDir, files[0]), 'utf8'), published)

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

test('configure stops when the migrations directory cannot be read', async ({ assert }) => {
  const root = await mkdtemp(join(tmpdir(), 'adonisjs-duplicate-request-guard-unreadable-'))
  try {
    // A file where the directory should be: readdir fails with ENOTDIR, not ENOENT.
    const migrationsPath = join(root, 'migrations')
    await writeFile(migrationsPath, '')
    let codemodsCreated = false
    const command = {
      app: { migrationsPath: () => migrationsPath },
      logger: { info() {} },
      createCodemods: async () => {
        codemodsCreated = true
        return { makeUsingStub: async () => {} }
      },
    } as unknown as Configure

    await assert.rejects(() => configure(command), /ENOTDIR/)
    assert.isFalse(codemodsCreated)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.group('configure with an existing matching migrations entry', () => {
  const NAME = '1_create_request_receipts_table.ts'

  async function run(prepare: (migrations: string, root: string) => Promise<void>): Promise<{
    root: string
    logged: string[]
    codemodsCreated: boolean
    run: () => Promise<void>
  }> {
    const root = await mkdtemp(join(tmpdir(), 'adonisjs-duplicate-request-guard-entry-'))
    const migrations = join(root, 'migrations')
    await mkdir(migrations)
    await prepare(migrations, root)
    const state = {
      root,
      logged: [] as string[],
      codemodsCreated: false,
      run: async () => {},
    }
    const command = {
      app: { migrationsPath: (name = '') => join(migrations, name) },
      logger: { info: (message: string) => state.logged.push(message) },
      createCodemods: async () => {
        state.codemodsCreated = true
        return { makeUsingStub: async () => {} }
      },
    } as unknown as Configure
    state.run = () => configure(command)
    return state
  }

  test('a regular file is left alone and skipped', async ({ assert }) => {
    const state = await run((migrations) => writeFile(join(migrations, NAME), ''))
    try {
      await state.run()
      assert.lengthOf(state.logged, 1)
      assert.isFalse(state.codemodsCreated)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  test('a link to a regular file counts as existing', async ({ assert }) => {
    const state = await run(async (migrations, root) => {
      await writeFile(join(root, 'real.ts'), '')
      await symlink(join(root, 'real.ts'), join(migrations, NAME))
    })
    try {
      await state.run()
      assert.lengthOf(state.logged, 1)
      assert.isFalse(state.codemodsCreated)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  test('a directory with the migration name stops configure', async ({ assert }) => {
    const state = await run((migrations) => mkdir(join(migrations, NAME)))
    try {
      await assert.rejects(() => state.run(), new RegExp(`${NAME}.*not a regular file`))
      assert.isFalse(state.codemodsCreated)
      assert.lengthOf(state.logged, 0)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  test('a broken link with the migration name stops configure', async ({ assert }) => {
    const state = await run((migrations, root) =>
      symlink(join(root, 'missing.ts'), join(migrations, NAME))
    )
    try {
      await assert.rejects(() => state.run(), new RegExp(`${NAME}.*not a regular file`))
      assert.isFalse(state.codemodsCreated)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  test('a link to a directory stops configure', async ({ assert }) => {
    const state = await run(async (migrations, root) => {
      await mkdir(join(root, 'dir'))
      await symlink(join(root, 'dir'), join(migrations, NAME))
    })
    try {
      await assert.rejects(() => state.run(), /not a regular file/)
      assert.isFalse(state.codemodsCreated)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })
})
