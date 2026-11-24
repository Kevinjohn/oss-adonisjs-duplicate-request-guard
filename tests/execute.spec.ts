import { test } from '@japa/runner'
import { execute } from '../index.js'
import {
  DeniedException,
  addProof,
  countRows,
  createDatabase,
  errors,
  makeOperationInput,
  makeNoteOperation,
  listReceipts,
} from './helpers.js'

test.group('execute: reserve, complete, replay', () => {
  test('a fresh operation runs once and stores a completed receipt', async ({ assert }) => {
    const { db, client } = await createDatabase()
    const { operation, calls } = makeNoteOperation()
    await addProof(client, 'p1')
    const outcome = await execute(db.connection(), operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    assert.deepEqual(outcome, { replayed: false, result: { noteId: 1 } })
    const [row] = await listReceipts(client)
    assert.equal(row.state, 'completed')
    assert.equal(row.operation, '["notes.add","alice"]')
    assert.deepInclude(calls, { access: 1, parse: 1, execute: 1, work: 1, replay: 0 })
  })

  test('a replay returns the stored result without parsing authorization', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, calls } = makeNoteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    const replay = await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: 'garbage',
    })
    assert.deepEqual(replay, { replayed: true, result: { noteId: 1 } })
    assert.deepInclude(calls, { parse: 1, execute: 1, work: 1, replay: 1, access: 2 })
    assert.equal(await countRows(client, 'notes'), 1)
  })

  test('replay re-runs authorizeReplay against current state', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    await client.from('memberships').where('user_id', 'alice').update({ role: 'viewer' })
    await assert.rejects(() => execute(client, operation, makeOperationInput(1)), 'replay')
  })

  test('access is checked before reservation', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, calls } = makeNoteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    await client.from('memberships').where('user_id', 'alice').delete()
    const error = await execute(client, operation, makeOperationInput(1)).catch((e) => e)
    assert.instanceOf(error, DeniedException)
    assert.equal(error.reason, 'access')
    assert.equal(calls.replay, 0)
    await assert.rejects(() => execute(client, operation, makeOperationInput(2)), 'access')
    assert.lengthOf(await listReceipts(client), 1)
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
      const { operation } = makeNoteOperation()
      await addProof(client, 'p1')
      await addProof(client, 'p2')
      await execute(client, operation, {
        ...makeOperationInput(1),
        authorization: { proofToken: 'p1' },
      })
      await execute(client, operation, {
        ...makeOperationInput(2),
        authorization: { proofToken: 'p2' },
      })
      await assert.rejects(
        () => execute(client, operation, { ...makeOperationInput(1), ...change }),
        errors.E_DUPLICATE_REQUEST_CONFLICT
      )
    })
  }
})

test.group('execute: failures roll back the reservation', () => {
  test('bad authorization, rejected proof and failed work leave nothing behind', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = makeNoteOperation()
    await addProof(client, 'p1')
    await assert.rejects(
      () => execute(client, operation, { ...makeOperationInput(1), authorization: {} }),
      'parse'
    )
    await assert.rejects(
      () =>
        execute(client, operation, {
          ...makeOperationInput(1),
          authorization: { proofToken: 'nope' },
        }),
      'proof'
    )
    hooks.beforeWork = () => {
      throw new Error('work failed')
    }
    await assert.rejects(
      () =>
        execute(client, operation, {
          ...makeOperationInput(1),
          authorization: { proofToken: 'p1' },
        }),
      'work failed'
    )
    assert.lengthOf(await listReceipts(client), 0)
    const proof = await client.from('proofs').where('token', 'p1').first()
    assert.equal(proof.used, 0)

    hooks.beforeWork = undefined
    const retried = await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    assert.isFalse(retried.replayed)
  })

  test('undefined payload or result values are rejected', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    await assert.rejects(
      () => execute(client, operation, makeOperationInput(1, { payload: { body: undefined } })),
      errors.E_INVALID_COMMAND_VALUE
    )
    await assert.rejects(
      () =>
        execute(
          client,
          { ...operation, work: () => undefined as never },
          { ...makeOperationInput(1), authorization: { proofToken: 'p1' } }
        ),
      errors.E_INVALID_COMMAND_RESULT
    )
    assert.lengthOf(await listReceipts(client), 0)
  })

  test('results round-trip as JSON, including arrays', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    const listOp = { ...operation, work: () => ({ noteId: 7, tags: ['a', null] }) as never }
    const first = await execute(client, listOp, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    const again = await execute(client, listOp, makeOperationInput(1))
    assert.deepEqual(again.result, first.result)
  })
})

test.group('what a callback mutates does not change the operation', () => {
  test('work that rewrites the input identity still completes the reserved receipt', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = makeNoteOperation()
    await addProof(client, 'p1')
    const request = { ...makeOperationInput(1), authorization: { proofToken: 'p1' } }
    hooks.afterWork = () => {
      request.command.commandId = 'rewritten'
      request.command.requestKey = 'rewritten'
      request.actorId = 'bob'
      request.scopeId = 's2'
    }
    const fresh = await execute(client, operation, request)
    assert.isFalse(fresh.replayed)
    const rows = await listReceipts(client)
    assert.deepEqual(
      rows.map((row) => [row.command_id, row.request_key, row.scope_id, row.state]),
      [['c1', 'k1', 's1', 'completed']]
    )
    const retry = await execute(client, operation, makeOperationInput(1))
    assert.deepEqual(retry, { replayed: true, result: fresh.result })
  })

  test('a replay authorisation callback that rewrites its result does not change what the caller gets', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    const fresh = await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    const replayedResults: unknown[] = []
    const redacting = {
      ...operation,
      authorizeReplay: (_context: unknown, result: { noteId: number }) => {
        replayedResults.push({ ...result })
        result.noteId = -1
      },
    }
    const retry = await execute(client, redacting, makeOperationInput(1))
    assert.deepEqual(replayedResults, [fresh.result])
    assert.deepEqual(retry, { replayed: true, result: fresh.result })
  })
})
