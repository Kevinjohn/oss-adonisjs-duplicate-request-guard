import { test } from '@japa/runner'
import { execute, executeIn } from '../index.js'
import {
  addProof,
  auth,
  committed,
  count,
  createDatabase,
  input,
  named,
  noteOperation,
  receipts,
  sleep,
  within,
} from './helpers.js'

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

test.group('cleanup never masks the original error', () => {
  test('a transaction SQLite already rolled back rethrows the original error', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    await addProof(client, 'p1')
    await client.table('notes').insert({ id: 99, scope_id: 's1', body: 'existing' })
    const { operation, hooks } = noteOperation()
    hooks.afterWork = async ({ trx }) => {
      await trx.rawQuery(
        `INSERT OR ROLLBACK INTO notes (id, scope_id, body) VALUES (99, 's1', 'x')`
      )
    }
    const trx = await client.transaction()
    let caught: (Error & { code?: string }) | undefined
    try {
      await within(executeIn(trx, operation, auth(1)))
    } catch (error) {
      caught = error as Error & { code?: string }
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.match(caught?.code ?? '', /^SQLITE_CONSTRAINT/)
    assert.match(String((caught?.cause as Error | undefined)?.message), /no such savepoint/)
    assert.lengthOf(await receipts(client), 0)
  })
})

test.group('an aborted child never commits without its receipt', () => {
  /** Parent work: Promise.all of a slow child command and a validation that rejects first. */
  function probe() {
    const parent = named('notes.parent')
    const child = named('notes.child')
    const next = named('notes.next')
    child.hooks.beforeWork = () => sleep(50)
    // The host's next command is still open when the child would write.
    next.hooks.afterWork = () => sleep(100)
    parent.hooks.afterWork = async ({ trx }) => {
      await Promise.all([
        executeIn(trx, child.operation, auth(2)),
        sleep(5).then(() => {
          throw new Error('validation failed')
        }),
      ])
    }
    return { parent, child, next }
  }

  for (const waits of [true, false]) {
    test(`the host ${waits ? 'waits, then runs' : 'immediately runs'} its next command`, async ({
      assert,
    }) => {
      const { client } = await createDatabase()
      for (const n of [1, 2, 3]) await addProof(client, `p${n}`)
      const { parent, child, next } = probe()
      let parentError = ''
      let parentCause: unknown
      await within(
        client.transaction(async (trx) => {
          parentError = await executeIn(trx, parent.operation, auth(1)).then(
            () => 'fulfilled',
            (error: Error) => {
              parentCause = error.cause
              return error.message
            }
          )
          if (waits) await sleep(150)
          await executeIn(trx, next.operation, auth(3))
        })
      )
      assert.equal(parentError, 'validation failed')
      assert.equal((parentCause as { code?: string }).code, 'E_UNAWAITED_NESTED_COMMAND')
      // Only the next command's note and receipt committed: no orphan note from the child.
      assert.deepEqual(await committed(client), [['c3', 'completed']])
      assert.equal(await count(client, 'notes'), 1)
      const retry = await client.transaction((trx) => executeIn(trx, child.operation, auth(2)))
      assert.isFalse(retry.replayed)
      assert.equal(child.calls.work, 2)
      assert.equal(await count(client, 'notes'), 2)
    })
  }

  test('an aborted child stops before its next policy or work', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const child = named('notes.child')
    child.hooks.afterAccess = () => sleep(50)
    let childCode = ''
    parent.hooks.afterWork = async ({ trx }) => {
      const nested = executeIn(trx, child.operation, auth(2)).catch((error: { code?: string }) => {
        childCode = error.code ?? 'other'
      })
      await Promise.all([nested, sleep(5).then(() => Promise.reject(new Error('invalid')))])
    }
    await within(
      client.transaction((trx) => executeIn(trx, parent.operation, auth(1)).catch(() => null))
    )
    assert.equal(childCode, 'E_UNAWAITED_NESTED_COMMAND')
    assert.deepEqual([child.calls.execute, child.calls.work, child.calls.replay], [0, 0, 0])
    assert.deepEqual(await committed(client), [])
  })
})
