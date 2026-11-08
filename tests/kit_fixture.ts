import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'
import type { ApplicationService } from '@adonisjs/core/types'
import type { Database } from '@adonisjs/lucid/database'
import { AccountKit, defineConfig as defineKitConfig } from '@kevinjohn/adonisjs-account-kit'
import { createSqlUsersAdapter } from '@kevinjohn/adonisjs-account-kit/adapters/sql'
import { defineConfig as defineLimiterConfig, stores } from '@adonisjs/limiter'

const packageRoot = new URL('../', import.meta.url)
const self = '@kevinjohn/adonisjs-duplicate-request-guard'
const importer = (specifier: string) =>
  specifier === self ? import(new URL('index.ts', packageRoot).href) : import(specifier)

const appMigration = `import { BaseSchema } from '@adonisjs/lucid/schema'
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('users', (table) => {
      table.increments('id')
      table.string('email', 254).notNullable().unique()
      table.string('password').notNullable()
    })
    this.schema.createTable('memberships', (table) => {
      table.string('scope_id')
      table.string('user_id')
      table.string('role')
    })
    this.schema.createTable('proofs', (table) => {
      table.string('token').primary()
      table.string('user_id')
      table.boolean('used').defaultTo(false)
    })
    this.schema.createTable('notes', (table) => {
      table.increments('id')
      table.string('scope_id')
      table.string('body')
    })
  }
}
`

const fakeSessionGuard = {
  strategy: 'session' as const,
  name: 'web',
  async establish(userId: string | number, revision: string | null, handle?: string) {
    return { userId: String(userId), revision, sessionHandle: handle! }
  },
  async terminate() {},
}

const anyFunction = new Proxy({}, { get: () => async () => 'http://localhost/' })

export interface KitFixture {
  app: ApplicationService
  db: Database
  kit: AccountKit
  file: string
  signIn(email: string): Promise<{ userId: string; revision: string | null; sessionHandle: string }>
  close(): Promise<void>
}

/**
 * A real AdonisJS app with Lucid, the limiter and Account Kit 0.3.2, after `node ace configure`
 * for the Kit and for this package, with all migrations run.
 */
export async function bootKit(): Promise<KitFixture> {
  const root = await mkdtemp(join(tmpdir(), 'adonisjs-duplicate-request-guard-kit-'))
  await writeFile(
    join(root, 'package.json'),
    '{"type":"module","devDependencies":{"@adonisjs/assembler":"8.6.0"}}'
  )
  await writeFile(join(root, 'tsconfig.json'), '{}')
  await writeFile(
    join(root, 'adonisrc.ts'),
    `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [], commands: [] })\n`
  )
  await mkdir(join(root, 'database/migrations'), { recursive: true })
  await mkdir(join(root, 'start'))
  await writeFile(
    join(root, 'start/env.ts'),
    `import { Env } from '@adonisjs/core/env'\nexport default await Env.create(new URL('../', import.meta.url), {})\n`
  )
  await writeFile(
    join(root, 'database/migrations/0000000000000_create_app_tables.ts'),
    appMigration
  )
  await symlink(fileURLToPath(new URL('node_modules', packageRoot)), join(root, 'node_modules'))

  const configurer = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [], commands: [async () => new ListLoader([Configure])] },
    })
    .create(pathToFileURL(`${root}/`), { importer })
  await configurer.ace().handle(['configure', '@kevinjohn/adonisjs-account-kit'])
  await configurer.ace().handle(['configure', self])

  const file = join(root, 'db.sqlite3')
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          () => import('@adonisjs/lucid/database_provider'),
          () => import('@adonisjs/limiter/limiter_provider'),
          () => import('@kevinjohn/adonisjs-account-kit/account_kit_provider'),
        ],
      },
      config: {
        database: {
          connection: 'sqlite',
          connections: {
            sqlite: {
              client: 'better-sqlite3',
              connection: { filename: file },
              useNullAsDefault: true,
              migrations: { paths: ['database/migrations'] },
            },
          },
        },
        limiter: defineLimiterConfig({ default: 'memory', stores: { memory: stores.memory({}) } }),
        account_kit: defineKitConfig({
          users: createSqlUsersAdapter({ table: 'users' }),
          enabled: ['emailVerification', 'emailPasswordManagement', 'sessionManagement'],
          urls: anyFunction,
          notify: anyFunction,
          limiterSecret: 'a'.repeat(40),
          registration: { availability: 'closed' },
          authentication: { strategy: 'session', guard: 'web' },
          sessionManagement: {},
          minRequestMs: 0,
        }),
      },
    })
    .create(pathToFileURL(`${root}/`), { importer })
  const app = ignitor.createApp('test')
  await app.init()
  await app.boot()
  const db = await app.container.make('lucid.db')
  const { MigrationRunner } = await import('@adonisjs/lucid/migration')
  const migrator = new MigrationRunner(db, app, { direction: 'up', dryRun: false })
  await migrator.run()
  if (migrator.error) throw migrator.error
  const kit = await app.container.make(AccountKit)
  const hash = await app.container.make('hash')

  return {
    app,
    db,
    kit,
    file,
    async signIn(email) {
      await db.table('users').insert({
        email,
        password: await hash.make('secret-pass'),
        email_verified_at: new Date(),
      })
      const { credential } = await kit.authentication.login(
        { email, password: 'secret-pass', clientKey: 'test-client' },
        fakeSessionGuard
      )
      await db
        .table('memberships')
        .insert({ scope_id: 's1', user_id: String(credential.userId), role: 'owner' })
      return credential
    },
    async close() {
      await app.terminate()
      await rm(root, { recursive: true, force: true })
    },
  }
}
