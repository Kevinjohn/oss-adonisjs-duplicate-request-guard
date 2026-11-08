import { test } from '@japa/runner'
import BetterSqlite3 from 'better-sqlite3'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import { assertSupportedConnection, execute, executeIn } from '../index.js'
import { addProof, createDatabase, errors, input, noteOperation, receipts } from './helpers.js'

/** The pool knex actually built, to prove the check agrees with it. */
const realPoolMax = (client: unknown) =>
  (client as { getWriteClient(): { client: { pool: { max: number } } } }).getWriteClient().client
    .pool.max

test.group('SQLite pool rule', () => {
  const allowed = [
    { name: 'no pool config', pool: undefined },
    { name: 'pool without max', pool: { min: 0 } },
    { name: 'pool max 1', pool: { max: 1 } },
  ]
  for (const { name, pool } of allowed) {
    test(`allowed: ${name} (knex builds one connection)`, async ({ assert }) => {
      const { client } = await createDatabase(pool)
      const { operation } = noteOperation()
      await addProof(client, 'p1')
      assert.equal(realPoolMax(client), 1)
      const outcome = await execute(client, operation, {
        ...input(1),
        authorization: { proofToken: 'p1' },
      })
      assert.isFalse(outcome.replayed)
    })
  }

  test('refused: pool max 2, on both owners, before any policy runs', async ({ assert }) => {
    const { client } = await createDatabase({ max: 2 })
    const { operation, calls } = noteOperation()
    assert.equal(realPoolMax(client), 2)
    await assert.rejects(
      () => execute(client, operation, input(1)),
      errors.UnsafeSqlitePoolException
    )
    await assert.rejects(
      () => client.transaction((trx) => executeIn(trx, operation, input(1))),
      errors.UnsafeSqlitePoolException
    )
    assert.equal(calls.access, 0)
  })

  test('refused: a real pg connection config, before connecting', async ({ assert }) => {
    const app = new AppFactory().create(new URL('file:///tmp/'), () => {})
    const db = new Database(
      {
        connection: 'pg',
        connections: {
          pg: {
            client: 'pg',
            connection: { host: '127.0.0.1', port: 1, user: 'none', database: 'none' },
            pool: { min: 0, max: 10 },
          },
        },
      },
      new LoggerFactory().create(),
      new Emitter(app)
    )
    try {
      const client = db.connection()
      assert.equal(client.dialect.name, 'postgres')
      assert.throws(() => assertSupportedConnection(client), /better-sqlite3 only/)
      const { operation, calls } = noteOperation()
      await assert.rejects(
        () => execute(client, operation, input(1)),
        errors.UnsupportedDialectException
      )
      assert.equal(calls.access, 0)
    } finally {
      await db.manager.closeAll()
    }
  })
})

test.group('SQLite writer lock', () => {
  test('another process committing between access check and reservation cannot break it', async ({
    assert,
  }) => {
    const { client, file } = await createDatabase()
    const { operation, hooks } = noteOperation()
    await addProof(client, 'p1')
    // Stands in for another process (an ace command, a cron) writing to the same file.
    const other = new BetterSqlite3(file, { timeout: 0 })
    let otherWrite = 'not attempted'
    hooks.afterAccess = () => {
      try {
        other.prepare("insert into notes (scope_id, body) values ('s1', 'other process')").run()
        otherWrite = 'committed'
      } catch (error) {
        otherWrite = (error as { code: string }).code
      }
    }
    try {
      const outcome = await execute(client, operation, {
        ...input(1),
        authorization: { proofToken: 'p1' },
      })
      assert.isFalse(outcome.replayed)
      assert.equal(otherWrite, 'SQLITE_BUSY')
      assert.lengthOf(await receipts(client), 1)
    } finally {
      other.close()
    }
  })
})

test.group('concurrent duplicates', () => {
  test('on one connection: one runs, one replays', async ({ assert }) => {
    const { client } = await createDatabase({ max: 1 })
    const { operation, calls, hooks } = noteOperation()
    await addProof(client, 'p1')
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const inWork = new Promise<void>((resolve) => (entered = resolve))
    hooks.beforeWork = async () => {
      entered()
      await gate
    }
    const body = { ...input(1), authorization: { proofToken: 'p1' } }
    const first = execute(client, operation, body)
    await inWork
    const second = execute(client, operation, body)
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const outcomes = await Promise.all([first, second])
    assert.deepEqual(
      outcomes.map((o) => o.replayed),
      [false, true]
    )
    assert.equal(calls.work, 1)
  })
})
