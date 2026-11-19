import { test } from '@japa/runner'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { assertSupportedConnection, executeIn } from '../index.js'
import {
  addProof,
  makeAuthorizedCommandInput,
  countRows,
  createDatabase,
  makeNamedOperation,
  makeNoteOperation,
  listReceipts,
} from './helpers.js'

/** A statement that makes SQLite roll back the whole transaction, not just the statement. */
const endTransaction = (trx: TransactionClientContract) =>
  trx.rawQuery(`INSERT OR ROLLBACK INTO notes (id, scope_id, body) VALUES (99, 's1', 'x')`)

const readOutcomeCode = (error: { code?: string }) => error.code

async function prepareLostTransactionFixture() {
  const { client } = await createDatabase()
  for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
  await client.table('notes').insert({ id: 99, scope_id: 's1', body: 'existing' })
  return client
}

test.group('a transaction SQLite already ended runs no further command', () => {
  test('a command after one that lost the transaction is refused and commits nothing', async ({
    assert,
  }) => {
    const client = await prepareLostTransactionFixture()
    const { operation, hooks } = makeNoteOperation()
    hooks.afterWork = ({ trx }) => endTransaction(trx)
    const trx = await client.transaction()
    try {
      const first = await executeIn(trx, operation, makeAuthorizedCommandInput(1)).catch(
        readOutcomeCode
      )
      assert.equal(first, 'SQLITE_CONSTRAINT_PRIMARYKEY')
      hooks.afterWork = undefined
      const second = await executeIn(trx, operation, makeAuthorizedCommandInput(2)).catch(
        readOutcomeCode
      )
      assert.equal(second, 'E_TRANSACTION_LOST')
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.lengthOf(await listReceipts(client), 0)
    assert.equal(await countRows(client, 'notes'), 1)
  })

  test('a command after a host query that ended the transaction is refused', async ({ assert }) => {
    const client = await prepareLostTransactionFixture()
    const { operation, calls } = makeNoteOperation()
    const trx = await client.transaction()
    try {
      await endTransaction(trx).catch(() => null)
      const outcome = await executeIn(trx, operation, makeAuthorizedCommandInput(1)).catch(
        readOutcomeCode
      )
      assert.equal(outcome, 'E_TRANSACTION_LOST')
      // Refused for good: a host savepoint makes the driver report a transaction again, and
      // releasing a command's savepoint inside it would still commit.
      await trx.rawQuery('SAVEPOINT host')
      assert.equal(
        await executeIn(trx, operation, makeAuthorizedCommandInput(1)).catch(readOutcomeCode),
        'E_TRANSACTION_LOST'
      )
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.equal(calls.access, 0)
    assert.lengthOf(await listReceipts(client), 0)
    assert.equal(await countRows(client, 'notes'), 1)
  })

  test('a parent that swallows the failure stops at its next checkpoint', async ({ assert }) => {
    const client = await prepareLostTransactionFixture()
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    child.hooks.afterWork = ({ trx }) => endTransaction(trx)
    parent.hooks.afterWork = async ({ trx }) => {
      await executeIn(trx, child.operation, makeAuthorizedCommandInput(2)).catch(() => null)
    }
    const trx = await client.transaction()
    try {
      const outcome = await executeIn(trx, parent.operation, makeAuthorizedCommandInput(1)).catch(
        readOutcomeCode
      )
      assert.equal(outcome, 'E_TRANSACTION_LOST')
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.lengthOf(await listReceipts(client), 0)
    assert.equal(await countRows(client, 'notes'), 1)
  })
})

test.group('a lost transaction is lost for every client on its connection', () => {
  for (const loser of ['a command', 'a host query'] as const) {
    test(`a child transaction opened after ${loser} lost it runs no command`, async ({
      assert,
    }) => {
      const client = await prepareLostTransactionFixture()
      const { operation, hooks } = makeNoteOperation()
      assertSupportedConnection(client)
      const trx = await client.transaction()
      try {
        if (loser === 'a command') {
          hooks.afterWork = (context) => endTransaction(context.trx)
          await executeIn(trx, operation, makeAuthorizedCommandInput(1)).catch(() => null)
          hooks.afterWork = undefined
        } else {
          // No command sees this: the watcher armed by the boot-time check does.
          await endTransaction(trx).catch(() => null)
        }
        // The child's savepoint reopens a transaction, so the driver reports one again.
        const outcome = await trx
          .transaction((child) => executeIn(child, operation, makeAuthorizedCommandInput(2)))
          .catch(readOutcomeCode)
        assert.equal(outcome, 'E_TRANSACTION_LOST')
      } finally {
        await trx.rollback().catch(() => null)
      }
      assert.lengthOf(await listReceipts(client), 0)
      assert.equal(await countRows(client, 'notes'), 1)
    })
  }

  test('a watcher armed mid-transaction by a first command still sees a later host query', async ({
    assert,
  }) => {
    const client = await prepareLostTransactionFixture()
    const { operation } = makeNoteOperation()
    const trx = await client.transaction()
    try {
      // The first guarded call on this connection happens with the transaction already open.
      await executeIn(trx, operation, makeAuthorizedCommandInput(1))
      await endTransaction(trx).catch(() => null)
      const outcome = await trx
        .transaction((child) => executeIn(child, operation, makeAuthorizedCommandInput(2)))
        .catch(readOutcomeCode)
      assert.equal(outcome, 'E_TRANSACTION_LOST')
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.lengthOf(await listReceipts(client), 0)
    assert.equal(await countRows(client, 'notes'), 1)
  })

  test('a parent that swallows the loss cannot run a command in a child transaction', async ({
    assert,
  }) => {
    const client = await prepareLostTransactionFixture()
    for (const sequenceNumber of [3]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    const later = makeNamedOperation('notes.later')
    child.hooks.afterWork = ({ trx }) => endTransaction(trx)
    let laterCode: string | undefined
    parent.hooks.afterWork = async ({ trx }) => {
      await trx
        .transaction((nested) => executeIn(nested, child.operation, makeAuthorizedCommandInput(2)))
        .catch(() => null)
      laterCode = await trx
        .transaction((nested) => executeIn(nested, later.operation, makeAuthorizedCommandInput(3)))
        .then(() => 'fulfilled', readOutcomeCode)
    }
    const trx = await client.transaction()
    try {
      await executeIn(trx, parent.operation, makeAuthorizedCommandInput(1)).catch(() => null)
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.equal(laterCode, 'E_TRANSACTION_LOST')
    assert.lengthOf(await listReceipts(client), 0)
    assert.equal(await countRows(client, 'notes'), 1)
  })

  test('the next transaction on the connection runs commands again', async ({ assert }) => {
    const client = await prepareLostTransactionFixture()
    const { operation, hooks } = makeNoteOperation()
    hooks.afterWork = ({ trx }) => endTransaction(trx)
    const lost = await client.transaction()
    await executeIn(lost, operation, makeAuthorizedCommandInput(1)).catch(() => null)
    await lost.rollback().catch(() => null)
    hooks.afterWork = undefined
    for (const sequenceNumber of [1, 2]) {
      const outcome = await client.transaction((trx) =>
        executeIn(trx, operation, makeAuthorizedCommandInput(sequenceNumber))
      )
      assert.isFalse(outcome.replayed)
    }
    assert.lengthOf(await listReceipts(client), 2)
  })
})

test.group('only the transaction that was lost is refused', () => {
  test('a command on a completed transaction is refused without spoiling the next one', async ({
    assert,
  }) => {
    const client = await prepareLostTransactionFixture()
    const { operation } = makeNoteOperation()
    const done = await client.transaction()
    await done.commit()
    assert.equal(
      await executeIn(done, operation, makeAuthorizedCommandInput(1)).catch(readOutcomeCode),
      'E_TRANSACTION_LOST'
    )
    const outcome = await client.transaction((trx) =>
      executeIn(trx, operation, makeAuthorizedCommandInput(1))
    )
    assert.isFalse(outcome.replayed)
  })

  // The pool has one connection, so a waiting transaction gets it the moment `done` releases it.
  // The late command checks that connection some microtasks later, wherever that falls.
  for (const ticks of Array.from({ length: 30 }, (_, i) => i)) {
    test(`a command ${ticks} ticks after its transaction completed does not spoil a waiting one`, async ({
      assert,
    }) => {
      const client = await prepareLostTransactionFixture()
      const { operation } = makeNoteOperation()
      assertSupportedConnection(client)
      const done = await client.transaction()
      const waiting = client.transaction()
      const committed = done.commit()
      for (let tick = 0; tick < ticks; tick++) await Promise.resolve()
      const late = executeIn(done, operation, makeAuthorizedCommandInput(1)).catch(readOutcomeCode)
      await committed
      const next = await waiting
      try {
        await late
        const outcome = await executeIn(next, operation, makeAuthorizedCommandInput(2))
        assert.isFalse(outcome.replayed)
        await next.commit()
      } finally {
        await next.rollback().catch(() => null)
      }
    })
  }

  test('statements knex runs before BEGIN do not count as a loss', async ({ assert }) => {
    const client = await prepareLostTransactionFixture()
    const { operation } = makeNoteOperation()
    assertSupportedConnection(client)
    // knex reads and restores PRAGMA foreign_keys around the transaction, outside it.
    const options = { enforceForeignCheck: true } as unknown as { isolationLevel?: never }
    // Twice: the second transaction's PRAGMA follows statements the first ran inside its own.
    for (const sequenceNumber of [1, 2]) {
      const outcome = await client.transaction(
        (trx) => executeIn(trx, operation, makeAuthorizedCommandInput(sequenceNumber)),
        options
      )
      assert.isFalse(outcome.replayed)
    }
    assert.lengthOf(await listReceipts(client), 2)
  })

  test('a raw COMMIT from the host is a loss too', async ({ assert }) => {
    const client = await prepareLostTransactionFixture()
    const { operation } = makeNoteOperation()
    assertSupportedConnection(client)
    const trx = await client.transaction()
    try {
      await trx.rawQuery('COMMIT')
      const outcome = await trx
        .transaction((child) => executeIn(child, operation, makeAuthorizedCommandInput(1)))
        .catch(readOutcomeCode)
      assert.equal(outcome, 'E_TRANSACTION_LOST')
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.lengthOf(await listReceipts(client), 0)
  })
})

test.group('ordinary query failures do not lose a transaction', () => {
  test('a failed host query that leaves the transaction open is no loss', async ({ assert }) => {
    const client = await prepareLostTransactionFixture()
    const { operation } = makeNoteOperation()
    assertSupportedConnection(client)
    await client.transaction(async (trx) => {
      await trx.rawQuery('SELECT missing FROM nowhere').catch(() => null)
      const outcome = await trx.transaction((child) =>
        executeIn(child, operation, makeAuthorizedCommandInput(1))
      )
      assert.isFalse(outcome.replayed)
    })
    assert.lengthOf(await listReceipts(client), 1)
  })

  test('a failed query outside any transaction marks nothing', async ({ assert }) => {
    const client = await prepareLostTransactionFixture()
    const { operation } = makeNoteOperation()
    assertSupportedConnection(client)
    await client.rawQuery('SELECT missing FROM nowhere').catch(() => null)
    const outcome = await client.transaction((trx) =>
      executeIn(trx, operation, makeAuthorizedCommandInput(1))
    )
    assert.isFalse(outcome.replayed)
  })
})

test.group('annotating the error never skips the rollback', () => {
  test('an error whose cause accessor throws still rolls the command back', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const { operation, hooks } = makeNoteOperation()
    class Hostile extends Error {
      get cause(): unknown {
        throw new Error('cause unavailable')
      }
    }
    const hostile = new Hostile('from work')
    let pending: Promise<unknown> = Promise.resolve()
    hooks.afterWork = ({ trx }) => {
      pending = executeIn(trx, operation, { ...makeAuthorizedCommandInput(2) })
      throw hostile
    }
    await client.transaction(async (trx) => {
      const caught = await executeIn(trx, operation, makeAuthorizedCommandInput(1)).catch(
        (error: unknown) => error
      )
      assert.strictEqual(caught, hostile)
      await trx.table('notes').insert({ scope_id: 's1', body: 'host write' })
    })
    const [child] = await Promise.allSettled([pending])
    assert.equal(child.status === 'rejected' && child.reason.code, 'E_UNAWAITED_NESTED_COMMAND')
    assert.lengthOf(await listReceipts(client), 0)
    assert.equal(await countRows(client, 'notes'), 1)
  })
})
