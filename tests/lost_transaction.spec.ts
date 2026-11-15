import { test } from '@japa/runner'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { executeIn } from '../index.js'
import { addProof, auth, count, createDatabase, named, noteOperation, receipts } from './helpers.js'

/** A statement that makes SQLite roll back the whole transaction, not just the statement. */
const endTransaction = (trx: TransactionClientContract) =>
  trx.rawQuery(`INSERT OR ROLLBACK INTO notes (id, scope_id, body) VALUES (99, 's1', 'x')`)

const codeOf = (error: { code?: string }) => error.code

async function database() {
  const { client } = await createDatabase()
  for (const n of [1, 2]) await addProof(client, `p${n}`)
  await client.table('notes').insert({ id: 99, scope_id: 's1', body: 'existing' })
  return client
}

test.group('a transaction SQLite already ended runs no further command', () => {
  test('a command after one that lost the transaction is refused and commits nothing', async ({
    assert,
  }) => {
    const client = await database()
    const { operation, hooks } = noteOperation()
    hooks.afterWork = ({ trx }) => endTransaction(trx)
    const trx = await client.transaction()
    try {
      const first = await executeIn(trx, operation, auth(1)).catch(codeOf)
      assert.equal(first, 'SQLITE_CONSTRAINT_PRIMARYKEY')
      hooks.afterWork = undefined
      const second = await executeIn(trx, operation, auth(2)).catch(codeOf)
      assert.equal(second, 'E_TRANSACTION_LOST')
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.lengthOf(await receipts(client), 0)
    assert.equal(await count(client, 'notes'), 1)
  })

  test('a command after a host query that ended the transaction is refused', async ({ assert }) => {
    const client = await database()
    const { operation, calls } = noteOperation()
    const trx = await client.transaction()
    try {
      await endTransaction(trx).catch(() => null)
      const outcome = await executeIn(trx, operation, auth(1)).catch(codeOf)
      assert.equal(outcome, 'E_TRANSACTION_LOST')
      // Refused for good: a host savepoint makes the driver report a transaction again, and
      // releasing a command's savepoint inside it would still commit.
      await trx.rawQuery('SAVEPOINT host')
      assert.equal(await executeIn(trx, operation, auth(1)).catch(codeOf), 'E_TRANSACTION_LOST')
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.equal(calls.access, 0)
    assert.lengthOf(await receipts(client), 0)
    assert.equal(await count(client, 'notes'), 1)
  })

  test('a parent that swallows the failure stops at its next checkpoint', async ({ assert }) => {
    const client = await database()
    const parent = named('notes.parent')
    const child = named('notes.child')
    child.hooks.afterWork = ({ trx }) => endTransaction(trx)
    parent.hooks.afterWork = async ({ trx }) => {
      await executeIn(trx, child.operation, auth(2)).catch(() => null)
    }
    const trx = await client.transaction()
    try {
      const outcome = await executeIn(trx, parent.operation, auth(1)).catch(codeOf)
      assert.equal(outcome, 'E_TRANSACTION_LOST')
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.lengthOf(await receipts(client), 0)
    assert.equal(await count(client, 'notes'), 1)
  })
})

test.group('a lost transaction is lost for every client on its connection', () => {
  for (const loser of ['a command', 'a host query'] as const) {
    test(`a child transaction opened after ${loser} lost it runs no command`, async ({
      assert,
    }) => {
      const client = await database()
      const { operation, hooks } = noteOperation()
      const trx = await client.transaction()
      try {
        if (loser === 'a command') {
          hooks.afterWork = (context) => endTransaction(context.trx)
          await executeIn(trx, operation, auth(1)).catch(() => null)
          hooks.afterWork = undefined
        } else {
          await endTransaction(trx).catch(() => null)
          // Marks the connection: afterwards the driver alone could not tell.
          await executeIn(trx, operation, auth(1)).catch(() => null)
        }
        // The child's savepoint reopens a transaction, so the driver reports one again.
        const outcome = await trx
          .transaction((child) => executeIn(child, operation, auth(2)))
          .catch(codeOf)
        assert.equal(outcome, 'E_TRANSACTION_LOST')
      } finally {
        await trx.rollback().catch(() => null)
      }
      assert.lengthOf(await receipts(client), 0)
      assert.equal(await count(client, 'notes'), 1)
    })
  }

  test('a parent that swallows the loss cannot run a command in a child transaction', async ({
    assert,
  }) => {
    const client = await database()
    for (const n of [3]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const child = named('notes.child')
    const later = named('notes.later')
    child.hooks.afterWork = ({ trx }) => endTransaction(trx)
    let laterCode: string | undefined
    parent.hooks.afterWork = async ({ trx }) => {
      await trx
        .transaction((nested) => executeIn(nested, child.operation, auth(2)))
        .catch(() => null)
      laterCode = await trx
        .transaction((nested) => executeIn(nested, later.operation, auth(3)))
        .then(() => 'fulfilled', codeOf)
    }
    const trx = await client.transaction()
    try {
      await executeIn(trx, parent.operation, auth(1)).catch(() => null)
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.equal(laterCode, 'E_TRANSACTION_LOST')
    assert.lengthOf(await receipts(client), 0)
    assert.equal(await count(client, 'notes'), 1)
  })

  test('the next transaction on the connection runs commands again', async ({ assert }) => {
    const client = await database()
    const { operation, hooks } = noteOperation()
    hooks.afterWork = ({ trx }) => endTransaction(trx)
    const lost = await client.transaction()
    await executeIn(lost, operation, auth(1)).catch(() => null)
    await lost.rollback().catch(() => null)
    hooks.afterWork = undefined
    for (const n of [1, 2]) {
      const outcome = await client.transaction((trx) => executeIn(trx, operation, auth(n)))
      assert.isFalse(outcome.replayed)
    }
    assert.lengthOf(await receipts(client), 2)
  })
})

test.group('annotating the error never skips the rollback', () => {
  test('an error whose cause accessor throws still rolls the command back', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const { operation, hooks } = noteOperation()
    class Hostile extends Error {
      get cause(): unknown {
        throw new Error('cause unavailable')
      }
    }
    const hostile = new Hostile('from work')
    let pending: Promise<unknown> = Promise.resolve()
    hooks.afterWork = ({ trx }) => {
      pending = executeIn(trx, operation, { ...auth(2) })
      throw hostile
    }
    await client.transaction(async (trx) => {
      const caught = await executeIn(trx, operation, auth(1)).catch((error: unknown) => error)
      assert.strictEqual(caught, hostile)
      await trx.table('notes').insert({ scope_id: 's1', body: 'host write' })
    })
    const [child] = await Promise.allSettled([pending])
    assert.equal(child.status === 'rejected' && child.reason.code, 'E_UNAWAITED_NESTED_COMMAND')
    assert.lengthOf(await receipts(client), 0)
    assert.equal(await count(client, 'notes'), 1)
  })
})
