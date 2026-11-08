import { test } from '@japa/runner'
import { execute } from '../index.js'
import {
  DeniedException,
  addProof,
  count,
  createDatabase,
  errors,
  input,
  noteOperation,
  receipts,
} from './helpers.js'

test.group('execute: reserve, complete, replay', () => {
  test('a fresh command runs once and stores a completed receipt', async ({ assert }) => {
    const { db, client } = await createDatabase()
    const { operation, calls } = noteOperation()
    await addProof(client, 'p1')
    const outcome = await execute(db.connection(), operation, {
      ...input(1),
      authorization: { proofToken: 'p1' },
    })
    assert.deepEqual(outcome, { replayed: false, result: { noteId: 1 } })
    const [row] = await receipts(client)
    assert.equal(row.state, 'completed')
    assert.equal(row.operation, '["notes.add","alice"]')
    assert.deepInclude(calls, { access: 1, parse: 1, execute: 1, work: 1, replay: 0 })
  })

  test('a replay returns the stored result without parsing authorization', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, calls } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    const replay = await execute(client, operation, { ...input(1), authorization: 'garbage' })
    assert.deepEqual(replay, { replayed: true, result: { noteId: 1 } })
    assert.deepInclude(calls, { parse: 1, execute: 1, work: 1, replay: 1, access: 2 })
    assert.equal(await count(client, 'notes'), 1)
  })

  test('replay re-runs authorizeReplay against current state', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    await client.from('memberships').where('user_id', 'alice').update({ role: 'viewer' })
    await assert.rejects(() => execute(client, operation, input(1)), 'replay')
  })

  test('access is checked before reservation', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, calls } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    await client.from('memberships').where('user_id', 'alice').delete()
    const error = await execute(client, operation, input(1)).catch((e) => e)
    assert.instanceOf(error, DeniedException)
    assert.equal(error.reason, 'access')
    assert.equal(calls.replay, 0)
    await assert.rejects(() => execute(client, operation, input(2)), 'access')
    assert.lengthOf(await receipts(client), 1)
  })
})

test.group('execute: conflicts', () => {
  const conflicts = [
    { name: 'same identity, different payload', change: { payload: { body: 'other' } } },
    { name: 'same identity, different scope', change: { scopeId: 's2' } },
    {
      name: 'same command id, different key',
      change: { command: { commandId: 'c1', requestKey: 'other' } },
    },
    {
      name: 'same key, different command id',
      change: { command: { commandId: 'other', requestKey: 'k1' } },
    },
    {
      name: 'command id and key from two different receipts',
      change: { command: { commandId: 'c1', requestKey: 'k2' } },
    },
  ]
  for (const { name, change } of conflicts) {
    test(name, async ({ assert }) => {
      const { client } = await createDatabase()
      await client.table('memberships').insert({ scope_id: 's2', user_id: 'alice', role: 'owner' })
      const { operation } = noteOperation()
      await addProof(client, 'p1')
      await addProof(client, 'p2')
      await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
      await execute(client, operation, { ...input(2), authorization: { proofToken: 'p2' } })
      await assert.rejects(
        () => execute(client, operation, { ...input(1), ...change }),
        errors.DuplicateRequestConflictException
      )
    })
  }
})

test.group('execute: failures roll back the reservation', () => {
  test('bad authorization, rejected proof and failed work leave nothing behind', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = noteOperation()
    await addProof(client, 'p1')
    await assert.rejects(
      () => execute(client, operation, { ...input(1), authorization: {} }),
      'parse'
    )
    await assert.rejects(
      () => execute(client, operation, { ...input(1), authorization: { proofToken: 'nope' } }),
      'proof'
    )
    hooks.beforeWork = () => {
      throw new Error('work failed')
    }
    await assert.rejects(
      () => execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } }),
      'work failed'
    )
    assert.lengthOf(await receipts(client), 0)
    const proof = await client.from('proofs').where('token', 'p1').first()
    assert.equal(proof.used, 0)

    hooks.beforeWork = undefined
    const retried = await execute(client, operation, {
      ...input(1),
      authorization: { proofToken: 'p1' },
    })
    assert.isFalse(retried.replayed)
  })

  test('undefined payload or result values are rejected', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await assert.rejects(
      () => execute(client, operation, input(1, { payload: { body: undefined } })),
      errors.InvalidCommandValueException
    )
    await assert.rejects(
      () =>
        execute(
          client,
          { ...operation, work: () => undefined as never },
          { ...input(1), authorization: { proofToken: 'p1' } }
        ),
      errors.InvalidCommandResultException
    )
    assert.lengthOf(await receipts(client), 0)
  })

  test('results round-trip as JSON, including arrays', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    const listOp = { ...operation, work: () => ({ noteId: 7, tags: ['a', null] }) as never }
    const first = await execute(client, listOp, {
      ...input(1),
      authorization: { proofToken: 'p1' },
    })
    const again = await execute(client, listOp, input(1))
    assert.deepEqual(again.result, first.result)
  })
})
