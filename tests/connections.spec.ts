import { RuntimeException } from '@adonisjs/core/exceptions'
import { test } from '@japa/runner'
import { realpathSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import * as api from '../index.ts'
import { requestDeduplicator } from '../index.ts'
import { writerRegistry } from '../src/receipts.ts'
import {
  addProof,
  createDatabase,
  makeOperationInput,
  makeNoteOperation,
  prepareSchema,
} from './helpers.ts'

function openTestDatabase(filename: string) {
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
    test(`a ${name} connection is refused as unsupported configuration`, async ({ assert }) => {
      const fake = { dialect: { name }, connectionName: name, isTransaction: false } as never
      const { operation, calls } = makeNoteOperation()
      await assert.rejects(
        () => requestDeduplicator.execute(fake, operation, makeOperationInput(1)),
        RuntimeException
      )
      await assert.rejects(
        () =>
          requestDeduplicator.executeIn(
            { ...(fake as object), isTransaction: true } as never,
            operation,
            makeOperationInput(1)
          ),
        RuntimeException
      )
      assert.equal(calls.access, 0)
    })
  }
})

test.group('shared SQLite file detection', () => {
  test('a closed connection releases its file', async ({ assert }) => {
    const { db, file } = await createDatabase()
    db.manager.add('first', { client: 'better-sqlite3', connection: { filename: file } })
    const { operation } = makeNoteOperation()
    await addProof(db.connection(), 'p1')
    await addProof(db.connection(), 'p2')
    await requestDeduplicator.execute(db.connection('first'), operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    await db.manager.close('first')
    const outcome = await requestDeduplicator.execute(db.connection(), operation, {
      ...makeOperationInput(2),
      authorization: { proofToken: 'p2' },
    })
    assert.isFalse(outcome.replayed)
  })

  test('closing connections on distinct files leaves nothing in the registry', async ({
    assert,
  }) => {
    const { file } = await createDatabase()
    const dir = realpathSync(dirname(file))
    for (const sequenceNumber of [1, 2, 3]) {
      const db = openTestDatabase(join(dir, `tenant${sequenceNumber}.sqlite3`))
      const connection = db.connection()
      // Repeated use registers one disconnect listener, beside Lucid's own.
      for (let i = 0; i < 3; i++) requestDeduplicator.assertSupportedConnection(connection)
      const lucid = db.manager.get('sqlite')?.connection
      assert.equal(lucid?.listenerCount('disconnect'), 2)
      assert.isTrue(writerRegistry.has(join(dir, `tenant${sequenceNumber}.sqlite3`)))
      await db.manager.closeAll()
      assert.isFalse(writerRegistry.has(join(dir, `tenant${sequenceNumber}.sqlite3`)))
    }
  })

  test('a closed connection that never emitted disconnect is still swept', async ({ assert }) => {
    const { db, file } = await createDatabase()
    db.manager.add('first', { client: 'better-sqlite3', connection: { filename: file } })
    requestDeduplicator.assertSupportedConnection(db.connection('first'))
    // A host that strips the connection's listeners: the close below emits to no one.
    db.manager.get('first')?.connection?.removeAllListeners('disconnect')
    await db.manager.close('first')
    assert.doesNotThrow(() => requestDeduplicator.assertSupportedConnection(db.connection()))
  })

  test('a second Database with the same connection name and file is refused', async ({
    assert,
  }) => {
    const { client, file } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    await requestDeduplicator.execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    const other = openTestDatabase(file)
    try {
      await assert.rejects(
        () => requestDeduplicator.execute(other.connection(), operation, makeOperationInput(2)),
        RuntimeException
      )
    } finally {
      await other.manager.closeAll()
    }
  })

  test('a symlinked path to the same file is refused', async ({ assert }) => {
    const { client, file } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    await requestDeduplicator.execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    const link = join(dirname(file), 'link', 'alias.sqlite3')
    await mkdir(dirname(link))
    await symlink(file, link)
    const other = openTestDatabase(link)
    try {
      await assert.rejects(
        () => requestDeduplicator.execute(other.connection(), operation, makeOperationInput(2)),
        RuntimeException
      )
    } finally {
      await other.manager.closeAll()
    }
  })

  test('a path padded with whitespace is the same file, as the driver trims it', async ({
    assert,
  }) => {
    const { client, file } = await createDatabase()
    requestDeduplicator.assertSupportedConnection(client)
    for (const padded of [`${file} `, ` ${file}`, `\t${file}\n`]) {
      const other = openTestDatabase(padded)
      try {
        assert.throws(
          () => requestDeduplicator.assertSupportedConnection(other.connection()),
          /share .*db\.sqlite3/
        )
      } finally {
        await other.manager.closeAll()
      }
    }
  })

  test('padded :memory: and blank filenames are anonymous, as the driver reads them', async ({
    assert,
  }) => {
    const dbs = [' :memory: ', ' :memory: ', '  ', '  '].map(openTestDatabase)
    try {
      for (const db of dbs)
        assert.doesNotThrow(() => requestDeduplicator.assertSupportedConnection(db.connection()))
    } finally {
      for (const db of dbs) await db.manager.closeAll()
    }
  })

  test('a file not created yet is matched through a symlinked directory', async ({ assert }) => {
    const { file } = await createDatabase()
    const realDir = join(dirname(file), 'real')
    const linkDir = join(dirname(file), 'alias')
    await mkdir(realDir)
    await symlink(realDir, linkDir)
    const first = openTestDatabase(join(realDir, 'new.sqlite3'))
    const second = openTestDatabase(join(linkDir, 'new.sqlite3'))
    try {
      assert.doesNotThrow(() => requestDeduplicator.assertSupportedConnection(first.connection()))
      assert.throws(
        () => requestDeduplicator.assertSupportedConnection(second.connection()),
        /share .*new\.sqlite3/
      )
    } finally {
      await first.manager.closeAll()
      await second.manager.closeAll()
    }
  })

  test('a path that cannot be inspected surfaces its error and is not registered', async ({
    assert,
  }) => {
    const { file } = await createDatabase()
    // The existing database file used as a directory: the path exists, it is not just missing.
    const unreachable = join(file, 'nested.sqlite3')
    const db = openTestDatabase(unreachable)
    try {
      assert.throws(
        () => requestDeduplicator.assertSupportedConnection(db.connection()),
        /^ENOTDIR\b/
      )
      assert.isFalse(writerRegistry.has(join(realpathSync(file), 'nested.sqlite3')))
    } finally {
      await db.manager.closeAll()
    }
  })

  test(':memory: databases are separate and never refused, even open side by side', async ({
    assert,
  }) => {
    const { operation } = makeNoteOperation()
    const dbs = [openTestDatabase(':memory:'), openTestDatabase(':memory:')]
    try {
      for (const db of dbs) {
        await prepareSchema(db.connection())
        await addProof(db.connection(), 'p1')
      }
      for (const db of dbs) {
        const outcome = await requestDeduplicator.execute(db.connection(), operation, {
          ...makeOperationInput(1),
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
    const { operation } = makeNoteOperation()
    await addProof(db.connection(), 'p1')
    await requestDeduplicator.execute(db.connection(), operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    await assert.rejects(
      () => requestDeduplicator.execute(db.connection('second'), operation, makeOperationInput(2)),
      RuntimeException
    )
    await assert.rejects(
      () => requestDeduplicator.pruneReceipts(db.connection('second'), { olderThan: new Date() }),
      RuntimeException
    )
  })
})
