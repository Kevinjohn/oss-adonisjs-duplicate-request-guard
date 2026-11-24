import { test } from '@japa/runner'
import {
  execute,
  executeIn,
  pruneReceipts,
  RECEIPTS_TABLE,
  type ExecuteInput,
  type Operation,
} from '../index.js'
import {
  addProof,
  createDatabase,
  errors,
  makeOperationInput,
  makeNoteOperation,
  listReceipts,
} from './helpers.js'

test.group('identity, ordering and retention rules', () => {
  for (const owner of ['managed', 'host'] as const) {
    test(`${owner} execution keeps the dispatch identity through commit and retry`, async ({
      assert,
    }) => {
      const { client } = await createDatabase()
      let authorizationReads = 0
      const original = {
        ...makeOperationInput(1),
        get authorization() {
          authorizationReads++
          return undefined
        },
      }
      const input = {
        actorId: original.actorId,
        scopeId: original.scopeId,
        payload: original.payload,
        command: { ...original.command },
        get authorization() {
          return original.authorization
        },
      }
      const accessIdentities: { actorId: string; scopeId: string }[] = []
      const operation: Operation<
        typeof original.payload,
        undefined,
        { actorId: string; scopeId: string }
      > = {
        name: 'notes.dispatch',
        parseAuthorization: () => undefined,
        authorizeAccess({ actorId, scopeId }) {
          accessIdentities.push({ actorId, scopeId })
        },
        work({ actorId, scopeId }) {
          return { actorId, scopeId }
        },
      }
      const mutate = () => {
        input.actorId = 'bob'
        input.scopeId = 's2'
        input.command.commandId = 'c2'
        input.command.requestKey = 'k2'
      }

      const mutateAfterDispatch = <Result>(pending: Promise<Result>) => {
        assert.equal(authorizationReads, 0)
        mutate()
        return pending
      }
      const fresh =
        owner === 'managed'
          ? await mutateAfterDispatch(execute(client, operation, input))
          : await client.transaction((trx) => mutateAfterDispatch(executeIn(trx, operation, input)))

      const identity = { actorId: original.actorId, scopeId: original.scopeId }
      assert.deepEqual(fresh, { replayed: false, result: identity })
      const receipts = await listReceipts(client)
      assert.lengthOf(receipts, 1)
      assert.include(receipts[0], {
        operation: JSON.stringify([operation.name, original.actorId]),
        scope_id: original.scopeId,
        command_id: original.command.commandId,
        request_key: original.command.requestKey,
        state: 'completed',
      })
      const replay =
        owner === 'managed'
          ? await execute(client, operation, original)
          : await client.transaction((trx) => executeIn(trx, operation, original))
      assert.deepEqual(replay, { replayed: true, result: identity })
      assert.deepEqual(accessIdentities, [identity, identity])
      assert.equal(authorizationReads, 1)
      assert.lengthOf(await listReceipts(client), 1)
    })
  }

  test('a throwing input getter releases the host transaction claim', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    const failure = new Error('host payload unavailable')
    await client.transaction(async (trx) => {
      const rejected = await executeIn(trx, operation, {
        ...makeOperationInput(1),
        get payload(): { body: string } {
          throw failure
        },
      }).catch((error) => error)
      assert.strictEqual(rejected, failure)
      assert.lengthOf(await listReceipts(trx), 0)

      const outcome = await executeIn(trx, operation, {
        ...makeOperationInput(1),
        authorization: { proofToken: 'p1' },
      })
      assert.isFalse(outcome.replayed)
      assert.lengthOf(await listReceipts(trx), 1)
    })
  })

  test('getter-backed input and command work for fresh execution and replay', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    const command = makeOperationInput(1).command
    class Command {
      get commandId() {
        return command.commandId
      }
      get requestKey() {
        return command.requestKey
      }
    }

    let authorizationReads = 0
    const source = makeOperationInput(1)
    class HostInput implements ExecuteInput<{ body: string }> {
      get actorId() {
        return source.actorId
      }
      get scopeId() {
        return source.scopeId
      }
      get payload() {
        return source.payload
      }
      get command() {
        return new Command()
      }
    }
    const adapter = Object.defineProperty(new HostInput(), 'authorization', {
      enumerable: true,
      get() {
        authorizationReads++
        return { proofToken: 'p1' }
      },
    })

    await client.transaction(async (trx) => {
      const fresh = await executeIn(trx, operation, adapter)
      assert.isFalse(fresh.replayed)
      assert.equal(authorizationReads, 1)
      const replay = await executeIn(trx, operation, adapter)
      assert.deepEqual(replay, { replayed: true, result: fresh.result })
      assert.equal(authorizationReads, 1)

      const withoutParser = await executeIn(
        trx,
        {
          name: 'notes.without-parser',
          authorizeAccess: operation.authorizeAccess,
          work: () => null,
        },
        adapter
      )
      assert.deepEqual(withoutParser, { replayed: false, result: null })
      assert.equal(authorizationReads, 1)
    })
  })

  test('authorizeAccess runs before the reservation exists', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = makeNoteOperation()
    await addProof(client, 'p1')
    let receiptCountBeforeReservation = -1
    hooks.afterAccess = async ({ trx }) => {
      const rows = await trx.from(RECEIPTS_TABLE).where('command_id', 'c1')
      receiptCountBeforeReservation = rows.length
    }
    await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    assert.equal(receiptCountBeforeReservation, 0)
  })

  test('a conflict never parses the authorization', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, calls } = makeNoteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    await assert.rejects(
      () =>
        execute(client, operation, {
          ...makeOperationInput(1, { payload: { body: 'other' } }),
          authorization: 'garbage',
        }),
      errors.E_DUPLICATE_REQUEST_CONFLICT
    )
    assert.equal(calls.parse, 1)
  })

  test('a mismatched re-entry inside the reserving transaction is a conflict, not in progress', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = makeNoteOperation()
    await addProof(client, 'p1')
    let reentry: unknown
    hooks.beforeWork = async ({ trx }) => {
      hooks.beforeWork = undefined
      reentry = await executeIn(
        trx,
        operation,
        makeOperationInput(1, { payload: { body: 'other' } })
      ).catch((e) => e)
    }
    await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    assert.instanceOf(reentry, errors.E_DUPLICATE_REQUEST_CONFLICT)
    assert.deepInclude(reentry, {
      code: 'E_DUPLICATE_REQUEST_CONFLICT',
      status: 409,
      message: 'Command identity already used',
    })
  })

  test('the same identity under another actor or operation is a separate receipt', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    await addProof(client, 'p2', 'bob')
    await addProof(client, 'p3')
    const a = await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    const b = await execute(client, operation, {
      ...makeOperationInput(1, { actorId: 'bob' }),
      authorization: { proofToken: 'p2' },
    })
    const c = await execute(
      client,
      { ...operation, name: 'notes.other' },
      { ...makeOperationInput(1), authorization: { proofToken: 'p3' } }
    )
    assert.deepEqual([a.replayed, b.replayed, c.replayed], [false, false, false])
    assert.lengthOf(await listReceipts(client), 3)
  })

  test('operation and actor names cannot be confused through the separator', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await client
      .table('memberships')
      .insert({ scope_id: 's1', user_id: 'b:actor:c', role: 'owner' })
    await client.table('memberships').insert({ scope_id: 's1', user_id: 'c', role: 'owner' })
    await addProof(client, 'p1', 'c')
    await addProof(client, 'p2', 'b:actor:c')
    const first = await execute(
      client,
      { ...operation, name: 'a:actor:b' },
      { ...makeOperationInput(1, { actorId: 'c' }), authorization: { proofToken: 'p1' } }
    )
    const second = await execute(
      client,
      { ...operation, name: 'a' },
      { ...makeOperationInput(1, { actorId: 'b:actor:c' }), authorization: { proofToken: 'p2' } }
    )
    assert.deepEqual([first.replayed, second.replayed], [false, false])
  })

  test("a replay returns this actor's receipt, never another actor's with the same ids", async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'pb', 'bob')
    await addProof(client, 'pa')
    const bob = await execute(client, operation, {
      ...makeOperationInput(1, { actorId: 'bob' }),
      authorization: { proofToken: 'pb' },
    })
    const alice = await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'pa' },
    })
    assert.notDeepEqual(alice.result, bob.result)
    const replay = await execute(client, operation, makeOperationInput(1))
    assert.deepEqual(replay, { replayed: true, result: alice.result })
  })

  test('retention counts from completion, not from reservation', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = makeNoteOperation()
    await addProof(client, 'p1')
    let cutoff = new Date(0)
    hooks.beforeWork = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      cutoff = new Date()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    assert.equal(await pruneReceipts(client, { olderThan: cutoff }), 0)
  })

  test('prune keeps a receipt updated exactly at the cutoff', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    const [row] = await listReceipts(client)
    assert.equal(await pruneReceipts(client, { olderThan: new Date(row.updated_at) }), 0)
    assert.equal(
      await pruneReceipts(client, { olderThan: new Date(Date.parse(row.updated_at) + 1) }),
      1
    )
  })

  test('prune with a cutoff beyond year 9999 deletes every completed receipt', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = makeNoteOperation()
    const farthest = new Date(8.64e15)
    const bce = new Date(Date.UTC(-1, 0, 1))
    assert.match(farthest.toISOString(), /^\+275760-/)
    assert.match(bce.toISOString(), /^-000001-/)
    for (const [n, cutoff] of [
      [1, new Date(Date.UTC(10000, 0, 1))],
      [2, farthest],
    ] as const) {
      await addProof(client, `p${n}`)
      await execute(client, operation, {
        ...makeOperationInput(n),
        authorization: { proofToken: `p${n}` },
      })
      assert.equal(await pruneReceipts(client, { olderThan: bce }), 0)
      await assert.rejects(() => pruneReceipts(client, { olderThan: new Date('nope') }), RangeError)
      assert.lengthOf(await listReceipts(client), 1)
      assert.equal(await pruneReceipts(client, { olderThan: cutoff }), 1)
      assert.lengthOf(await listReceipts(client), 0)
    }
  })
})

test.group('identity strings', () => {
  // A lone surrogate: SQLite stores TEXT as UTF-8, so it would come back as U+FFFD.
  const lone = 'c\uD800'
  const refused = [
    ['an ill-formed', lone],
    ['a numeric', 123],
    ['a missing', undefined],
  ] as const
  for (const field of ['commandId', 'requestKey'] as const) {
    for (const [label, value] of refused) {
      test(`${label} ${field} is refused before authorizeAccess, nothing written`, async ({
        assert,
      }) => {
        const { client } = await createDatabase()
        const { operation, calls } = makeNoteOperation()
        await addProof(client, 'p1')
        const request = {
          ...makeOperationInput(1),
          command: { ...makeOperationInput(1).command, [field]: value },
          authorization: { proofToken: 'p1' },
        } as ReturnType<typeof makeOperationInput> & { authorization: unknown }
        const error = await execute(client, operation, request).catch((e) => e)
        assert.instanceOf(error, errors.E_INVALID_COMMAND_VALUE)
        assert.equal(error.status, 400)
        assert.match(error.message, /well-formed/)
        assert.equal(calls.access, 0)
        assert.lengthOf(await listReceipts(client), 0)
      })
    }
  }

  test('lone surrogates in the actor, scope and payload replay rather than conflict', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    let works = 0
    const operation = {
      name: 'ids.\uDC00',
      authorizeAccess() {},
      work: () => ({ n: ++works, echo: 'r\uDBFF' }),
    }
    const request = {
      actorId: 'a\uD800',
      scopeId: 's\uDFFF',
      payload: { body: 'p\uD801', ['k\uDC01']: 1 },
      command: { commandId: 'c1', requestKey: 'k1' },
    }
    const fresh = await execute(client, operation, request)
    const replay = await execute(client, operation, request)
    assert.isFalse(fresh.replayed)
    assert.deepEqual(replay, { replayed: true, result: fresh.result })
    assert.equal(works, 1)
  })
})
