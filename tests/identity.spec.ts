import { test } from '@japa/runner'
import { execute, executeIn, pruneReceipts, RECEIPTS_TABLE } from '../index.js'
import { addProof, createDatabase, errors, input, noteOperation, receipts } from './helpers.js'

test.group('identity, ordering and retention rules', () => {
  test('authorizeAccess runs before the reservation exists', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = noteOperation()
    await addProof(client, 'p1')
    let seen = -1
    hooks.afterAccess = async ({ trx }) => {
      const rows = await trx.from(RECEIPTS_TABLE).where('command_id', 'c1')
      seen = rows.length
    }
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    assert.equal(seen, 0)
  })

  test('a conflict never parses the authorization', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, calls } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    await assert.rejects(
      () =>
        execute(client, operation, {
          ...input(1, { payload: { body: 'other' } }),
          authorization: 'garbage',
        }),
      errors.DuplicateRequestConflictException
    )
    assert.equal(calls.parse, 1)
  })

  test('a mismatched re-entry inside the reserving transaction is a conflict, not in progress', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = noteOperation()
    await addProof(client, 'p1')
    let reentry: unknown
    hooks.beforeWork = async ({ trx }) => {
      hooks.beforeWork = undefined
      reentry = await executeIn(trx, operation, input(1, { payload: { body: 'other' } })).catch(
        (e) => e
      )
    }
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    assert.instanceOf(reentry, errors.DuplicateRequestConflictException)
  })

  test('the same identity under another actor or operation is a separate command', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await addProof(client, 'p2', 'bob')
    await addProof(client, 'p3')
    const a = await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    const b = await execute(client, operation, {
      ...input(1, { actorId: 'bob' }),
      authorization: { proofToken: 'p2' },
    })
    const c = await execute(
      client,
      { ...operation, name: 'notes.other' },
      { ...input(1), authorization: { proofToken: 'p3' } }
    )
    assert.deepEqual([a.replayed, b.replayed, c.replayed], [false, false, false])
    assert.lengthOf(await receipts(client), 3)
  })

  test('operation and actor names cannot be confused through the separator', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await client
      .table('memberships')
      .insert({ scope_id: 's1', user_id: 'b:actor:c', role: 'owner' })
    await client.table('memberships').insert({ scope_id: 's1', user_id: 'c', role: 'owner' })
    await addProof(client, 'p1', 'c')
    await addProof(client, 'p2', 'b:actor:c')
    const first = await execute(
      client,
      { ...operation, name: 'a:actor:b' },
      { ...input(1, { actorId: 'c' }), authorization: { proofToken: 'p1' } }
    )
    const second = await execute(
      client,
      { ...operation, name: 'a' },
      { ...input(1, { actorId: 'b:actor:c' }), authorization: { proofToken: 'p2' } }
    )
    assert.deepEqual([first.replayed, second.replayed], [false, false])
  })

  test("a replay returns this actor's receipt, never another actor's with the same ids", async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'pb', 'bob')
    await addProof(client, 'pa')
    const bob = await execute(client, operation, {
      ...input(1, { actorId: 'bob' }),
      authorization: { proofToken: 'pb' },
    })
    const alice = await execute(client, operation, {
      ...input(1),
      authorization: { proofToken: 'pa' },
    })
    assert.notDeepEqual(alice.result, bob.result)
    const replay = await execute(client, operation, input(1))
    assert.deepEqual(replay, { replayed: true, result: alice.result })
  })

  test('retention counts from completion, not from reservation', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = noteOperation()
    await addProof(client, 'p1')
    let cutoff = new Date(0)
    hooks.beforeWork = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      cutoff = new Date()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    assert.equal(await pruneReceipts(client, { olderThan: cutoff }), 0)
  })

  test('prune keeps a receipt updated exactly at the cutoff', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    const [row] = await receipts(client)
    assert.equal(await pruneReceipts(client, { olderThan: new Date(row.updated_at) }), 0)
    assert.equal(
      await pruneReceipts(client, { olderThan: new Date(Date.parse(row.updated_at) + 1) }),
      1
    )
  })
})
