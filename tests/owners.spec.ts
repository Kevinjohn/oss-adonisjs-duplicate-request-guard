import { test } from '@japa/runner'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { execute, executeIn } from '../index.js'
import { completeReceipt } from '../src/receipts.js'
import {
  addProof,
  count,
  createDatabase,
  errors,
  input,
  noteOperation,
  receipts,
} from './helpers.js'

test.group('transaction owners', () => {
  test('executeIn runs inside a host-owned transaction', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    const outcome = await client.transaction((trx) =>
      executeIn(trx, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    )
    assert.isFalse(outcome.replayed)
  })

  test('executeIn refuses a non-transaction client', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await assert.rejects(
      () => executeIn(client as never, operation, input(1)),
      errors.TransactionOwnerException
    )
  })

  test('execute refuses to run inside another owner', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, calls } = noteOperation()
    await assert.rejects(
      () => client.transaction((trx) => execute(trx as never, operation, input(1))),
      errors.TransactionOwnerException
    )
    assert.equal(calls.access, 0)
  })

  test('an owner that reruns the callback starts clean: no pending row survives', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, calls, hooks } = noteOperation()
    await addProof(client, 'p1')
    // Stand-in for Account Kit withCurrent: roll back the first attempt, then rerun the callback.
    let attempt = 0
    hooks.beforeWork = () => {
      if (++attempt === 1) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })
    }
    const callback = (trx: TransactionClientContract) =>
      executeIn(trx, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    await assert.rejects(() => client.transaction(callback), 'busy')
    const outcome = await client.transaction(callback)
    assert.isFalse(outcome.replayed)
    assert.deepInclude(calls, { parse: 2, execute: 2, work: 2 })
    assert.equal(await count(client, 'notes'), 1)
    const rows = await receipts(client)
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].state, 'completed')
  })

  test('re-entering a command from its own work (context.trx) is in progress', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = noteOperation()
    await addProof(client, 'p1')
    await client.transaction(async (trx) => {
      hooks.beforeWork = async (context) => {
        hooks.beforeWork = undefined
        await assert.rejects(
          () => executeIn(context.trx, operation, input(1)),
          errors.DuplicateRequestInProgressException
        )
      }
      await executeIn(trx, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    })
    assert.plan(1)
  })
})

test.group('completion', () => {
  test('completing an already completed receipt throws', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    await assert.rejects(
      () =>
        client.transaction((trx) =>
          completeReceipt(trx, JSON.stringify(['notes.add', 'alice']), 'c1', '{"noteId":99}')
        ),
      errors.ReceiptNotPendingException
    )
    const replay = await execute(client, operation, input(1))
    assert.deepEqual(replay.result, { noteId: 1 })
  })

  test('completing a missing receipt throws', async ({ assert }) => {
    const { client } = await createDatabase()
    await assert.rejects(
      () =>
        client.transaction((trx) =>
          completeReceipt(trx, JSON.stringify(['notes.add', 'alice']), 'missing', '{}')
        ),
      errors.ReceiptNotPendingException
    )
  })
})
