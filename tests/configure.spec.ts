import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { sourceFiles } from '@adonisjs/lucid/utils'
import { configure } from '../configure.js'
import { execute } from '../index.js'
import {
  addProof,
  createDatabase,
  makeOperationInput,
  loadMigration,
  makeNoteOperation,
  makeSignal,
} from './helpers.js'

const PACKAGE = '@kevinjohn/adonisjs-duplicate-request-guard'

test('configure publishes the receipts migration once, and it works', async ({ assert }) => {
  const root = await mkdtemp(join(tmpdir(), 'adonisjs-duplicate-request-guard-configure-'))
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
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

    const relativeMigrations = './database/migrations'
    const discover = () => sourceFiles(pathToFileURL(`${root}/`), relativeMigrations, false)
    const initial = await discover()
    assert.lengthOf(initial.files, 1)
    const nestedDir = join(migrationsDir, 'prior')
    await mkdir(nestedDir)
    const nestedMigration = join(nestedDir, files[0])
    await rename(join(migrationsDir, files[0]), nestedMigration)
    await ignitor.ace().handle(['configure', PACKAGE])
    const { files: discovered } = await discover()
    assert.deepEqual(
      discovered.map(({ absPath }) => absPath),
      [nestedMigration]
    )

    const Migration = await loadMigration(await readFile(discovered[0].absPath, 'utf8'))
    const { client } = await createDatabase()
    await client.schema.dropTable('request_receipts')
    await new Migration(client, 'published', false).execUp()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    const replay = await execute(client, operation, makeOperationInput(1))
    assert.isTrue(replay.replayed)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}).timeout(20_000)

test('simultaneous configure publication is exclusive and a later run preserves the file', async ({
  assert,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'adonisjs-duplicate-request-guard-claim-'))
  const migrationsPath = join(root, 'migrations')
  const publishing = makeSignal()
  const proceed = makeSignal()
  const command = {
    app: { migrationsPath: (name = '') => join(migrationsPath, name) },
    logger: { info() {} },
    createCodemods: async () => ({
      makeUsingStub: async (
        _root: string,
        _stub: string,
        data: { migration: { destination: string } }
      ) => {
        publishing.fire()
        await proceed.fired
        await writeFile(data.migration.destination, 'published migration')
      },
    }),
  } as unknown as Configure
  const first = configure(command)
  try {
    await publishing.fired
    await assert.rejects(() => configure(command), /publication is already claimed/)
    proceed.fire()
    await first
    const files = await readdir(migrationsPath)
    assert.lengthOf(files, 1)
    await configure(command)
    assert.deepEqual(await readdir(migrationsPath), files)
    assert.equal(await readFile(join(migrationsPath, files[0]), 'utf8'), 'published migration')
  } finally {
    proceed.fire()
    await first.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed publication releases the claim for a later configure', async ({ assert }) => {
  const root = await mkdtemp(join(tmpdir(), 'adonisjs-duplicate-request-guard-claim-failed-'))
  try {
    let failPublication = true
    const command = {
      app: { migrationsPath: (name = '') => join(root, name) },
      logger: { info() {} },
      createCodemods: async () => ({
        makeUsingStub: async (
          _root: string,
          _stub: string,
          data: { migration: { destination: string } }
        ) => {
          if (failPublication) throw new Error('publication failed')
          await writeFile(data.migration.destination, 'migration')
        },
      }),
    } as unknown as Configure
    await assert.rejects(() => configure(command), /publication failed/)
    assert.deepEqual(await readdir(root), [])
    failPublication = false
    await configure(command)
    assert.lengthOf(await readdir(root), 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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

  test('a link to a regular file stops configure', async ({ assert }) => {
    const state = await run(async (migrations, root) => {
      await writeFile(join(root, 'real.ts'), '')
      await symlink(join(root, 'real.ts'), join(migrations, NAME))
    })
    try {
      const { files } = await sourceFiles(pathToFileURL(`${state.root}/`), './migrations', false)
      assert.lengthOf(files, 0)
      await assert.rejects(() => state.run(), new RegExp(`${NAME}.*not a regular file`))
      assert.lengthOf(state.logged, 0)
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
      const { files } = await sourceFiles(pathToFileURL(`${state.root}/`), './migrations', false)
      assert.lengthOf(files, 0)
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
