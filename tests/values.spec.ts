import { test } from '@japa/runner'
import { execute, RECEIPTS_TABLE } from '../index.js'
import { addProof, createDatabase, errors, input, noteOperation, receipts } from './helpers.js'

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

test.group('schema and value edges', () => {
  test('a receipts table from the old stub gives a typed error, not a TypeError', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    // The phase-3 stub: command_id unique across every actor.
    await client.schema.alterTable(RECEIPTS_TABLE, (table) => table.unique(['command_id']))
    await addProof(client, 'p1')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    await assert.rejects(
      () => execute(client, operation, input(1, { actorId: 'bob' })),
      errors.ReceiptSchemaException
    )
  })

  test('-0 and 0 are the same JSON value', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await execute(client, operation, {
      ...input(1, { payload: { body: 'x', n: -0 } }),
      authorization: { proofToken: 'p1' },
    })
    const replay = await execute(client, operation, input(1, { payload: { body: 'x', n: 0 } }))
    assert.isTrue(replay.replayed)
  })

  test('shared non-cyclic references and null-prototype objects are plain data', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    const shared = { k: 1 }
    const bare = Object.assign(Object.create(null) as object, { k: 1 })
    await execute(client, operation, {
      ...input(1, { payload: { body: 'x', a: shared, b: shared, c: bare } }),
      authorization: { proofToken: 'p1' },
    })
    const replay = await execute(
      client,
      operation,
      input(1, { payload: { body: 'x', a: { k: 1 }, b: { k: 1 }, c: { k: 1 } } })
    )
    assert.isTrue(replay.replayed)
  })

  test('the payload is validated before authorizeAccess runs', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, calls } = noteOperation()
    await assert.rejects(
      () =>
        execute(client, operation, input(1, { actorId: 'mallory', payload: { n: Number.NaN } })),
      errors.InvalidCommandValueException
    )
    assert.equal(calls.access, 0)
  })
})
