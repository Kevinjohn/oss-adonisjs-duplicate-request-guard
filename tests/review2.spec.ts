import { test } from '@japa/runner'
import { mkdir, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import { assertSupportedConnection, execute, executeIn, RECEIPTS_TABLE } from '../index.js'
import {
  addProof,
  count,
  createDatabase,
  errors,
  input,
  noteOperation,
  prepareSchema,
  receipts,
} from './helpers.js'

/** Composition on the outer transaction, shared-file detection, value edges. A hang fails here. */
async function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hung for ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, hung])
  } finally {
    clearTimeout(timer)
  }
}

function sqliteDatabase(filename: string) {
  const app = new AppFactory().create(new URL('file:///tmp/'), () => {})
  return new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: { client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app)
  )
}

test.group('commands compose on the outer transaction', () => {
  test('executeIn on the outer trx from inside work runs a nested command', async ({ assert }) => {
    const { client } = await createDatabase()
    const outerOp = noteOperation()
    const innerOp = noteOperation()
    const inner = { ...innerOp.operation, name: 'notes.inner' }
    await addProof(client, 'p1')
    await addProof(client, 'p2')
    const outcome = await within(
      client.transaction(async (trx) => {
        outerOp.hooks.beforeWork = async () => {
          const nested = await executeIn(trx, inner, {
            ...input(2),
            authorization: { proofToken: 'p2' },
          })
          assert.isFalse(nested.replayed)
        }
        return executeIn(trx, outerOp.operation, {
          ...input(1),
          authorization: { proofToken: 'p1' },
        })
      })
    )
    assert.isFalse(outcome.replayed)
    const rows = await receipts(client)
    assert.deepEqual(rows.map((row) => row.state).sort(), ['completed', 'completed'])
    assert.equal(await count(client, 'notes'), 2)
  })

  test('a nested failure caught by work rolls back only the nested command', async ({ assert }) => {
    const { client } = await createDatabase()
    const outerOp = noteOperation()
    const innerOp = noteOperation()
    const inner = { ...innerOp.operation, name: 'notes.inner' }
    await addProof(client, 'p1')
    await addProof(client, 'p2')
    innerOp.hooks.afterWork = () => {
      throw new Error('inner failed after its side effect')
    }
    await within(
      client.transaction(async (trx) => {
        outerOp.hooks.beforeWork = async () => {
          await executeIn(trx, inner, { ...input(2), authorization: { proofToken: 'p2' } }).catch(
            () => null
          )
        }
        return executeIn(trx, outerOp.operation, {
          ...input(1),
          authorization: { proofToken: 'p1' },
        })
      })
    )
    const rows = await receipts(client)
    assert.deepEqual(
      rows.map((row) => [row.command_id, row.state]),
      [['c1', 'completed']]
    )
    assert.equal(await count(client, 'notes'), 1)
    const proof = await client.from('proofs').where('token', 'p2').first()
    assert.equal(proof.used, 0)
  })

  test('an outer failure rolls back the nested command too', async ({ assert }) => {
    const { client } = await createDatabase()
    const outerOp = noteOperation()
    const innerOp = noteOperation()
    const inner = { ...innerOp.operation, name: 'notes.inner' }
    await addProof(client, 'p1')
    await addProof(client, 'p2')
    await within(
      client.transaction(async (trx) => {
        outerOp.hooks.afterWork = async () => {
          await executeIn(trx, inner, { ...input(2), authorization: { proofToken: 'p2' } })
          throw new Error('outer failed after the nested command')
        }
        await executeIn(trx, outerOp.operation, {
          ...input(1),
          authorization: { proofToken: 'p1' },
        }).catch(() => null)
      })
    )
    assert.lengthOf(await receipts(client), 0)
    assert.equal(await count(client, 'notes'), 0)
  })

  test('outerTrx.transaction() from inside work completes', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = noteOperation()
    await addProof(client, 'p1')
    await within(
      client.transaction(async (trx) => {
        hooks.beforeWork = async () => {
          await trx.transaction(async (child) => {
            await child.table('notes').insert({ scope_id: 's1', body: 'child transaction' })
          })
        }
        return executeIn(trx, operation, { ...input(1), authorization: { proofToken: 'p1' } })
      })
    )
    assert.equal(await count(client, 'notes'), 2)
  })

  test('plain queries on the outer trx from inside work complete', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = noteOperation()
    await addProof(client, 'p1')
    await within(
      client.transaction(async (trx) => {
        hooks.beforeWork = async () => {
          await trx.table('notes').insert({ scope_id: 's1', body: 'outer query' })
        }
        return executeIn(trx, operation, { ...input(1), authorization: { proofToken: 'p1' } })
      })
    )
    assert.equal(await count(client, 'notes'), 2)
  })
})

test.group('shared SQLite file detection', () => {
  test('a closed connection releases its file', async ({ assert }) => {
    const { db, file } = await createDatabase()
    db.manager.add('first', { client: 'better-sqlite3', connection: { filename: file } })
    const { operation } = noteOperation()
    await addProof(db.connection(), 'p1')
    await addProof(db.connection(), 'p2')
    await execute(db.connection('first'), operation, {
      ...input(1),
      authorization: { proofToken: 'p1' },
    })
    await db.manager.close('first')
    const outcome = await execute(db.connection(), operation, {
      ...input(2),
      authorization: { proofToken: 'p2' },
    })
    assert.isFalse(outcome.replayed)
  })

  test('a second Database with the same connection name and file is refused', async ({
    assert,
  }) => {
    const { client, file } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    const other = sqliteDatabase(file)
    try {
      await assert.rejects(
        () => execute(other.connection(), operation, input(2)),
        errors.UnsafeSqlitePoolException
      )
    } finally {
      await other.manager.closeAll()
    }
  })

  test('a symlinked path to the same file is refused', async ({ assert }) => {
    const { client, file } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    const link = join(dirname(file), 'link', 'alias.sqlite3')
    await mkdir(dirname(link))
    await symlink(file, link)
    const other = sqliteDatabase(link)
    try {
      await assert.rejects(
        () => execute(other.connection(), operation, input(2)),
        errors.UnsafeSqlitePoolException
      )
    } finally {
      await other.manager.closeAll()
    }
  })

  test('a file not created yet is matched through a symlinked directory', async ({ assert }) => {
    const { file } = await createDatabase()
    const realDir = join(dirname(file), 'real')
    const linkDir = join(dirname(file), 'alias')
    await mkdir(realDir)
    await symlink(realDir, linkDir)
    const first = sqliteDatabase(join(realDir, 'new.sqlite3'))
    const second = sqliteDatabase(join(linkDir, 'new.sqlite3'))
    try {
      assert.doesNotThrow(() => assertSupportedConnection(first.connection()))
      assert.throws(() => assertSupportedConnection(second.connection()), /share .*new\.sqlite3/)
    } finally {
      await first.manager.closeAll()
      await second.manager.closeAll()
    }
  })

  test(':memory: databases are separate and never refused, even open side by side', async ({
    assert,
  }) => {
    const { operation } = noteOperation()
    const dbs = [sqliteDatabase(':memory:'), sqliteDatabase(':memory:')]
    try {
      for (const db of dbs) {
        await prepareSchema(db.connection())
        await addProof(db.connection(), 'p1')
      }
      for (const db of dbs) {
        const outcome = await execute(db.connection(), operation, {
          ...input(1),
          authorization: { proofToken: 'p1' },
        })
        assert.isFalse(outcome.replayed)
      }
    } finally {
      for (const db of dbs) await db.manager.closeAll()
    }
  })
})

test.group('schema and value edges', () => {
  test('a receipts table from the old stub gives a typed error, not a TypeError', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    // The phase-3 stub: command_id unique across every actor.
    await client.schema.alterTable(RECEIPTS_TABLE, (table) => table.unique(['command_id']))
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    await assert.rejects(
      () => execute(client, operation, input(1, { actorId: 'bob' })),
      errors.ReceiptSchemaException
    )
  })

  test('-0 and 0 are the same JSON value', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...input(1, { payload: { body: 'x', n: -0 } }),
      authorization: { proofToken: 'p1' },
    })
    const replay = await execute(client, operation, input(1, { payload: { body: 'x', n: 0 } }))
    assert.isTrue(replay.replayed)
  })

  test('shared non-cyclic references and null-prototype objects are plain data', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    const shared = { k: 1 }
    const bare = Object.assign(Object.create(null) as object, { k: 1 })
    await execute(client, operation, {
      ...input(1, { payload: { body: 'x', a: shared, b: shared, c: bare } }),
      authorization: { proofToken: 'p1' },
    })
    const replay = await execute(
      client,
      operation,
      input(1, { payload: { body: 'x', a: { k: 1 }, b: { k: 1 }, c: { k: 1 } } })
    )
    assert.isTrue(replay.replayed)
  })

  test('the payload is validated before authorizeAccess runs', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, calls } = noteOperation()
    await assert.rejects(
      () =>
        execute(client, operation, input(1, { actorId: 'mallory', payload: { n: Number.NaN } })),
      errors.InvalidCommandValueException
    )
    assert.equal(calls.access, 0)
  })
})
