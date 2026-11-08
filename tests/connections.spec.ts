import { test } from '@japa/runner'
import { mkdir, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import * as api from '../index.js'
import { assertSupportedConnection, execute, executeIn, pruneReceipts } from '../index.js'
import { addProof, createDatabase, errors, input, noteOperation, prepareSchema } from './helpers.js'

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

test.group('only better-sqlite3 is supported', () => {
  for (const name of ['postgres', 'mysql', 'mssql', 'sqlite3', 'libsql']) {
    test(`a ${name} connection is refused with E_UNSUPPORTED_DIALECT`, async ({ assert }) => {
      const fake = { dialect: { name }, connectionName: name, isTransaction: false } as never
      const { operation, calls } = noteOperation()
      await assert.rejects(
        () => execute(fake, operation, input(1)),
        errors.UnsupportedDialectException
      )
      await assert.rejects(
        () => executeIn({ ...(fake as object), isTransaction: true } as never, operation, input(1)),
        errors.UnsupportedDialectException
      )
      assert.equal(calls.access, 0)
    })
  }
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

test.group('API surface', () => {
  test('completeReceipt is internal', ({ assert }) => {
    assert.notProperty(api, 'completeReceipt')
  })

  test('two Lucid connections on the same SQLite file are refused', async ({ assert }) => {
    const { db, file } = await createDatabase()
    db.manager.add('second', {
      client: 'better-sqlite3',
      connection: { filename: file },
      useNullAsDefault: true,
    })
    const { operation } = noteOperation()
    await addProof(db.connection(), 'p1')
    await execute(db.connection(), operation, { ...input(1), authorization: { proofToken: 'p1' } })
    await assert.rejects(
      () => execute(db.connection('second'), operation, input(2)),
      errors.UnsafeSqlitePoolException
    )
    await assert.rejects(
      () => pruneReceipts(db.connection('second'), { olderThan: new Date() }),
      errors.UnsafeSqlitePoolException
    )
  })
})
