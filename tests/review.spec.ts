import { test } from '@japa/runner'
import * as api from '../index.js'
import { execute, executeIn, pruneReceipts, RECEIPTS_TABLE } from '../index.js'
import {
  addProof,
  count,
  createDatabase,
  errors,
  input,
  noteOperation,
  receipts,
} from './helpers.js'

/** Package contracts: value rules, the dialect, rollback, identity scope and the API surface. */

class Point {
  constructor(
    readonly x: number,
    readonly y: number
  ) {}
}
const cyclic: Record<string, unknown> = { a: 1 }
cyclic.self = cyclic
// eslint-disable-next-line no-sparse-arrays -- the hole is the point of this fixture
const sparse = [1, , 3]

test.group('only plain JSON data is accepted', () => {
  test('a function or symbol in the result is refused and nothing commits', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    for (const bad of [
      { noteId: 1, toString() {} },
      { noteId: 1, tag: Symbol('x') },
    ]) {
      const op = { ...operation, work: () => bad as never }
      await assert.rejects(
        () => execute(client, op, { ...input(1), authorization: { proofToken: 'p1' } }),
        errors.InvalidCommandResultException
      )
    }
    assert.lengthOf(await receipts(client), 0)
    const ok = await execute(client, operation, {
      ...input(1),
      authorization: { proofToken: 'p1' },
    })
    assert.isFalse(ok.replayed)
    const replay = await execute(client, operation, input(1))
    assert.deepEqual(replay.result, ok.result)
  })

  test('an array with a hole is refused even when another property pads its key count', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    for (const bad of [
      Object.assign(Array(3), [1], { 2: 3, extra: true }),
      Object.assign(Array(1), { extra: 1 }),
    ]) {
      const op = { ...operation, work: () => bad as never }
      await assert.rejects(
        () => execute(client, op, { ...input(1), authorization: { proofToken: 'p1' } }),
        errors.InvalidCommandResultException
      )
    }
    assert.lengthOf(await receipts(client), 0)
  })

  test('an undefined result is a server error, distinct from a bad payload', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    const error = await execute(
      client,
      { ...operation, work: () => undefined as never },
      { ...input(1), authorization: { proofToken: 'p1' } }
    ).catch((e) => e)
    assert.instanceOf(error, errors.InvalidCommandResultException)
    assert.equal(error.status, 500)
    assert.equal(error.code, 'E_INVALID_COMMAND_RESULT')
  })

  const invalidPayloads: Array<[string, unknown]> = [
    ['function', () => 1],
    ['symbol', Symbol('s')],
    ['BigInt', 10n],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['valid Date', new Date('2026-01-01T00:00:00Z')],
    ['invalid Date', new Date('nope')],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['Uint8Array', new Uint8Array([1, 2])],
    ['class instance', new Point(1, 2)],
    ['sparse array', sparse],
    ['symbol-keyed object', { [Symbol('k')]: 1 }],
    ['cycle', cyclic],
    ['undefined property', { a: undefined }],
  ]
  for (const [name, value] of invalidPayloads) {
    test(`payload containing a ${name} is refused with E_INVALID_COMMAND_VALUE`, async ({
      assert,
    }) => {
      const { client } = await createDatabase()
      const { operation, calls } = noteOperation()
      const error = await execute(
        client,
        operation,
        input(1, { payload: { body: 'x', extra: value } })
      ).catch((e) => e)
      assert.instanceOf(error, errors.InvalidCommandValueException)
      assert.equal(error.status, 400)
      assert.equal(calls.work, 0)
      assert.lengthOf(await receipts(client), 0)
    })
  }

  test('plain JSON payloads that differ never share a receipt', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...input(1, { payload: { body: 'x', extra: null } }),
      authorization: { proofToken: 'p1' },
    })
    for (const extra of [{}, [], 0, '', false, 'null']) {
      await assert.rejects(
        () => execute(client, operation, input(1, { payload: { body: 'x', extra } })),
        errors.DuplicateRequestConflictException
      )
    }
  })

  test('key order does not change the payload identity', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...input(1, { payload: { body: 'x', meta: { a: 1, b: 2 } } }),
      authorization: { proofToken: 'p1' },
    })
    const replay = await execute(
      client,
      operation,
      input(1, { payload: { meta: { b: 2, a: 1 }, body: 'x' } })
    )
    assert.isTrue(replay.replayed)
  })
})

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

test.group('a failed execute never leaves a pending row', () => {
  test('a host that swallows the error and commits keeps nothing from the attempt', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = noteOperation()
    await addProof(client, 'p1')
    hooks.afterWork = () => {
      throw new Error('after the side effect')
    }
    await client.transaction(async (trx) => {
      const swallowed = await executeIn(trx, operation, {
        ...input(1),
        authorization: { proofToken: 'p1' },
      }).catch(() => null)
      assert.isNull(swallowed)
      await trx.table('notes').insert({ scope_id: 's1', body: 'host write' })
    })
    assert.lengthOf(await receipts(client), 0)
    assert.equal(await count(client, 'notes'), 1)
    const proof = await client.from('proofs').where('token', 'p1').first()
    assert.equal(proof.used, 0)

    hooks.afterWork = undefined
    const retry = await execute(client, operation, {
      ...input(1),
      authorization: { proofToken: 'p1' },
    })
    assert.isFalse(retry.replayed)
  })

  test('a frozen error from work with an open child still rolls the command back', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = noteOperation()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    let pending: Promise<unknown> = Promise.resolve()
    hooks.afterWork = ({ trx }) => {
      pending = executeIn(trx, operation, { ...input(2), authorization: { proofToken: 'p2' } })
      // A cause cannot be attached to this error; the rollback must still run.
      throw Object.freeze(new Error('frozen'))
    }
    await client.transaction(async (trx) => {
      const error = await executeIn(trx, operation, {
        ...input(1),
        authorization: { proofToken: 'p1' },
      }).then(
        () => 'resolved',
        (reason: Error) => reason.message
      )
      assert.equal(error, 'frozen')
      await trx.table('notes').insert({ scope_id: 's1', body: 'host write' })
    })
    await Promise.allSettled([pending])
    assert.lengthOf(await receipts(client), 0)
    assert.equal(await count(client, 'notes'), 1)
  })
})

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
