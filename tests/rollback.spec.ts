import { test } from '@japa/runner'
import { execute, executeIn } from '../index.js'
import { internalHooks } from '../src/receipts.js'
import {
  addProof,
  makeAuthorizedOperationInput,
  listReceiptStates,
  countRows,
  createDatabase,
  makeOperationInput,
  makeNamedOperation,
  makeNoteOperation,
  listReceipts,
  makeSignal,
  awaitWithDeadline,
} from './helpers.js'

test.group('a failed execute never leaves a pending row', () => {
  test('a host that swallows the error and commits keeps nothing from the attempt', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = makeNoteOperation()
    await addProof(client, 'p1')
    hooks.afterWork = () => {
      throw new Error('after the side effect')
    }
    await client.transaction(async (trx) => {
      const swallowed = await executeIn(trx, operation, {
        ...makeOperationInput(1),
        authorization: { proofToken: 'p1' },
      }).catch(() => null)
      assert.isNull(swallowed)
      await trx.table('notes').insert({ scope_id: 's1', body: 'host write' })
    })
    assert.lengthOf(await listReceipts(client), 0)
    assert.equal(await countRows(client, 'notes'), 1)
    const proof = await client.from('proofs').where('token', 'p1').first()
    assert.equal(proof.used, 0)

    hooks.afterWork = undefined
    const retry = await execute(client, operation, {
      ...makeOperationInput(1),
      authorization: { proofToken: 'p1' },
    })
    assert.isFalse(retry.replayed)
  })

  test('a frozen error from work with an open child still rolls the command back', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = makeNoteOperation()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    let pending: Promise<unknown> = Promise.resolve()
    hooks.afterWork = ({ trx }) => {
      pending = executeIn(trx, operation, {
        ...makeOperationInput(2),
        authorization: { proofToken: 'p2' },
      })
      // A cause cannot be attached to this error; the rollback must still run.
      throw Object.freeze(new Error('frozen'))
    }
    await client.transaction(async (trx) => {
      const error = await executeIn(trx, operation, {
        ...makeOperationInput(1),
        authorization: { proofToken: 'p1' },
      }).then(
        () => 'resolved',
        (reason: Error) => reason.message
      )
      assert.equal(error, 'frozen')
      await trx.table('notes').insert({ scope_id: 's1', body: 'host write' })
    })
    await Promise.allSettled([pending])
    assert.lengthOf(await listReceipts(client), 0)
    assert.equal(await countRows(client, 'notes'), 1)
  })
})

test.group('cleanup never masks the original error', () => {
  test('a transaction SQLite already rolled back rethrows the original error', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    await addProof(client, 'p1')
    await client.table('notes').insert({ id: 99, scope_id: 's1', body: 'existing' })
    const { operation, hooks } = makeNoteOperation()
    hooks.afterWork = async ({ trx }) => {
      await trx.rawQuery(
        `INSERT OR ROLLBACK INTO notes (id, scope_id, body) VALUES (99, 's1', 'x')`
      )
    }
    const trx = await client.transaction()
    let caught: (Error & { code?: string }) | undefined
    try {
      await awaitWithDeadline(executeIn(trx, operation, makeAuthorizedOperationInput(1)))
    } catch (error) {
      caught = error as Error & { code?: string }
    } finally {
      await trx.rollback().catch(() => null)
    }
    assert.match(caught?.code ?? '', /^SQLITE_CONSTRAINT/)
    assert.match(String((caught?.cause as Error | undefined)?.message), /no such savepoint/)
    assert.lengthOf(await listReceipts(client), 0)
  })
})

test.group('an aborted child never commits without its receipt', (group) => {
  group.each.teardown(() => {
    internalHooks.onUnwind = undefined
  })

  /** Releases the barrier once the parent's unwind has marked its open children aborted. */
  function releaseOnUnwind(release: () => void) {
    internalHooks.onUnwind = () => {
      internalHooks.onUnwind = undefined
      release()
    }
  }

  /**
   * Parent work: Promise.all of a child command held in its `work` and a validation that rejects
   * once the child is there. The child resumes, and writes, only after the parent has aborted it.
   */
  function probe() {
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    const next = makeNamedOperation('notes.next')
    const childInWork = makeSignal()
    const release = makeSignal()
    const state = { childSettled: false, childSettledWhenNextRan: false }
    let childRun: Promise<unknown> = Promise.resolve()
    child.hooks.beforeWork = async () => {
      childInWork.fire()
      await release.fired
    }
    next.hooks.afterWork = () => {
      state.childSettledWhenNextRan = state.childSettled
    }
    parent.hooks.afterWork = async ({ trx }) => {
      releaseOnUnwind(release.fire)
      childRun = executeIn(trx, child.operation, makeAuthorizedOperationInput(2))
      const settle = () => {
        state.childSettled = true
      }
      childRun.then(settle, settle)
      await Promise.all([
        childRun,
        childInWork.fired.then(() => {
          throw new Error('validation failed')
        }),
      ])
    }
    return { parent, child, next, state, childSettled: () => Promise.allSettled([childRun]) }
  }

  for (const waits of [true, false]) {
    test(`the host ${waits ? 'waits for the child, then runs' : 'immediately runs'} its next command`, async ({
      assert,
    }) => {
      const { client } = await createDatabase()
      for (const sequenceNumber of [1, 2, 3]) await addProof(client, `p${sequenceNumber}`)
      const { parent, child, next, state, childSettled } = probe()
      let parentError = ''
      let parentCause: unknown
      await awaitWithDeadline(
        client.transaction(async (trx) => {
          parentError = await executeIn(
            trx,
            parent.operation,
            makeAuthorizedOperationInput(1)
          ).then(
            () => 'fulfilled',
            (error: Error) => {
              parentCause = error.cause
              return error.message
            }
          )
          if (waits) await childSettled()
          await executeIn(trx, next.operation, makeAuthorizedOperationInput(3))
        })
      )
      assert.equal(parentError, 'validation failed')
      assert.equal((parentCause as { code?: string }).code, 'E_UNAWAITED_NESTED_COMMAND')
      // The parent waited for the child: it had settled before the next command ran.
      assert.isTrue(state.childSettledWhenNextRan)
      assert.equal(child.calls.work, 1)
      // Only the next command's note and receipt committed: no orphan note from the child.
      assert.deepEqual(await listReceiptStates(client), [['c3', 'completed']])
      assert.equal(await countRows(client, 'notes'), 1)
      const retry = await client.transaction((trx) =>
        executeIn(trx, child.operation, makeAuthorizedOperationInput(2))
      )
      assert.isFalse(retry.replayed)
      assert.equal(child.calls.work, 2)
      assert.equal(await countRows(client, 'notes'), 2)
    })
  }

  test('an aborted child stops before its next policy or work', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    const inAccess = makeSignal()
    const release = makeSignal()
    // The child is inside authorizeAccess when the parent fails, and resumes once it is aborted.
    child.hooks.afterAccess = async () => {
      inAccess.fire()
      await release.fired
    }
    let childCode = ''
    parent.hooks.afterWork = async ({ trx }) => {
      releaseOnUnwind(release.fire)
      const nested = executeIn(trx, child.operation, makeAuthorizedOperationInput(2)).catch(
        (error: { code?: string }) => {
          childCode = error.code ?? 'other'
        }
      )
      await Promise.all([nested, inAccess.fired.then(() => Promise.reject(new Error('invalid')))])
    }
    await awaitWithDeadline(
      client.transaction((trx) =>
        executeIn(trx, parent.operation, makeAuthorizedOperationInput(1)).catch(() => null)
      )
    )
    assert.equal(childCode, 'E_UNAWAITED_NESTED_COMMAND')
    assert.equal(child.calls.access, 1)
    assert.deepEqual(
      [child.calls.parse, child.calls.execute, child.calls.work, child.calls.replay],
      [0, 0, 0, 0]
    )
    assert.deepEqual(await listReceiptStates(client), [])
  })
})
