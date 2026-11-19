import { test } from '@japa/runner'
import { executeIn } from '../index.js'
import { internalHooks } from '../src/receipts.js'
import {
  addProof,
  makeAuthorizedCommandInput,
  awaitOrSkip,
  readOutcomeCode,
  listReceiptStates,
  countRows,
  createDatabase,
  makeCommandInput,
  makeNamedOperation,
  makeNoteOperation,
  listReceipts,
  makeSignal,
  sleep,
  awaitWithDeadline,
} from './helpers.js'

test.group('commands compose on the outer transaction', () => {
  test('executeIn on the outer trx from inside work runs a nested command', async ({ assert }) => {
    const { client } = await createDatabase()
    const outerOp = makeNoteOperation()
    const innerOp = makeNoteOperation()
    const inner = { ...innerOp.operation, name: 'notes.inner' }
    await addProof(client, 'p1')
    await addProof(client, 'p2')
    const outcome = await awaitWithDeadline(
      client.transaction(async (trx) => {
        outerOp.hooks.beforeWork = async () => {
          const nested = await executeIn(trx, inner, {
            ...makeCommandInput(2),
            authorization: { proofToken: 'p2' },
          })
          assert.isFalse(nested.replayed)
        }
        return executeIn(trx, outerOp.operation, {
          ...makeCommandInput(1),
          authorization: { proofToken: 'p1' },
        })
      })
    )
    assert.isFalse(outcome.replayed)
    const rows = await listReceipts(client)
    assert.deepEqual(rows.map((row) => row.state).sort(), ['completed', 'completed'])
    assert.equal(await countRows(client, 'notes'), 2)
  })

  test('a nested failure caught by work rolls back only the nested command', async ({ assert }) => {
    const { client } = await createDatabase()
    const outerOp = makeNoteOperation()
    const innerOp = makeNoteOperation()
    const inner = { ...innerOp.operation, name: 'notes.inner' }
    await addProof(client, 'p1')
    await addProof(client, 'p2')
    innerOp.hooks.afterWork = () => {
      throw new Error('inner failed after its side effect')
    }
    await awaitWithDeadline(
      client.transaction(async (trx) => {
        outerOp.hooks.beforeWork = async () => {
          await executeIn(trx, inner, {
            ...makeCommandInput(2),
            authorization: { proofToken: 'p2' },
          }).catch(() => null)
        }
        return executeIn(trx, outerOp.operation, {
          ...makeCommandInput(1),
          authorization: { proofToken: 'p1' },
        })
      })
    )
    const rows = await listReceipts(client)
    assert.deepEqual(
      rows.map((row) => [row.command_id, row.state]),
      [['c1', 'completed']]
    )
    assert.equal(await countRows(client, 'notes'), 1)
    const proof = await client.from('proofs').where('token', 'p2').first()
    assert.equal(proof.used, 0)
  })

  test('an outer failure rolls back the nested command too', async ({ assert }) => {
    const { client } = await createDatabase()
    const outerOp = makeNoteOperation()
    const innerOp = makeNoteOperation()
    const inner = { ...innerOp.operation, name: 'notes.inner' }
    await addProof(client, 'p1')
    await addProof(client, 'p2')
    await awaitWithDeadline(
      client.transaction(async (trx) => {
        outerOp.hooks.afterWork = async () => {
          await executeIn(trx, inner, {
            ...makeCommandInput(2),
            authorization: { proofToken: 'p2' },
          })
          throw new Error('outer failed after the nested command')
        }
        await executeIn(trx, outerOp.operation, {
          ...makeCommandInput(1),
          authorization: { proofToken: 'p1' },
        }).catch(() => null)
      })
    )
    assert.lengthOf(await listReceipts(client), 0)
    assert.equal(await countRows(client, 'notes'), 0)
  })

  test('outerTrx.transaction() from inside work completes', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = makeNoteOperation()
    await addProof(client, 'p1')
    await awaitWithDeadline(
      client.transaction(async (trx) => {
        hooks.beforeWork = async () => {
          await trx.transaction(async (child) => {
            await child.table('notes').insert({ scope_id: 's1', body: 'child transaction' })
          })
        }
        return executeIn(trx, operation, {
          ...makeCommandInput(1),
          authorization: { proofToken: 'p1' },
        })
      })
    )
    assert.equal(await countRows(client, 'notes'), 2)
  })

  test('plain queries on the outer trx from inside work complete', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation, hooks } = makeNoteOperation()
    await addProof(client, 'p1')
    await awaitWithDeadline(
      client.transaction(async (trx) => {
        hooks.beforeWork = async () => {
          await trx.table('notes').insert({ scope_id: 's1', body: 'outer query' })
        }
        return executeIn(trx, operation, {
          ...makeCommandInput(1),
          authorization: { proofToken: 'p1' },
        })
      })
    )
    assert.equal(await countRows(client, 'notes'), 2)
  })
})

test.group('siblings on one transaction are refused, never queued', () => {
  test('(a) a sibling started while a command is open is refused at once', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const a = makeNamedOperation('notes.a')
    const b = makeNamedOperation('notes.b')
    const bSettled = makeSignal()
    a.hooks.afterWork = async () => {
      await awaitOrSkip(bSettled.fired)
      throw new Error('A failed')
    }
    const [first, second] = await awaitWithDeadline(
      client.transaction((trx) =>
        Promise.allSettled([
          executeIn(trx, a.operation, makeAuthorizedCommandInput(1)),
          executeIn(trx, b.operation, makeAuthorizedCommandInput(2)).finally(bSettled.fire),
        ])
      )
    )
    assert.equal(readOutcomeCode(first), 'A failed')
    assert.equal(readOutcomeCode(second), 'E_CONCURRENT_COMMAND')
    assert.equal(b.calls.access, 0)
    assert.deepEqual(await listReceiptStates(client), [])
  })

  test('(b) a sibling cannot release or mask a failing command', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const a = makeNamedOperation('notes.a')
    const b = makeNamedOperation('notes.b')
    const [first, second] = await awaitWithDeadline(
      client.transaction((trx) =>
        Promise.allSettled([
          executeIn(trx, a.operation, makeAuthorizedCommandInput(1)),
          executeIn(trx, b.operation, makeAuthorizedCommandInput(2)),
        ])
      )
    )
    assert.equal(readOutcomeCode(first), 'fulfilled')
    assert.equal(readOutcomeCode(second), 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await listReceiptStates(client), [['c1', 'completed']])
  })

  test("a sibling never authorizes against another command's uncommitted write", async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    await addProof(client, 'p1')
    await addProof(client, 'p2', 'carol')
    const a = makeNamedOperation('notes.a')
    const b = makeNamedOperation('notes.b')
    const aInWork = makeSignal()
    const bSettled = makeSignal()
    a.hooks.beforeWork = async ({ trx }) => {
      await trx.table('memberships').insert({ scope_id: 's1', user_id: 'carol', role: 'owner' })
      aInWork.fire()
      await awaitOrSkip(bSettled.fired, 1000)
      throw new Error('A failed')
    }
    const [first, second] = await awaitWithDeadline(
      client.transaction(async (trx) => {
        const pendingA = executeIn(trx, a.operation, makeAuthorizedCommandInput(1))
        await aInWork.fired
        const pendingB = executeIn(trx, b.operation, {
          ...makeCommandInput(2, { actorId: 'carol' }),
          authorization: { proofToken: 'p2' },
        }).finally(bSettled.fire)
        return Promise.allSettled([pendingA, pendingB])
      })
    )
    assert.equal(readOutcomeCode(first), 'A failed')
    assert.equal(readOutcomeCode(second), 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await listReceiptStates(client), [])
    assert.lengthOf(await client.from('memberships').where('user_id', 'carol'), 0)
  })

  test("a call that lost the command's async context is refused, not hung", async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const lost = makeNamedOperation('notes.lost')
    const gate = makeSignal()
    let detachedOutcomeCode = ''
    const outcome = await awaitWithDeadline(
      client.transaction((trx) => {
        // Registered in the host's context, run when the parent's work opens the gate.
        const call = gate.fired.then(() =>
          executeIn(trx, lost.operation, makeAuthorizedCommandInput(2))
        )
        parent.hooks.afterWork = async () => {
          gate.fire()
          detachedOutcomeCode = await call.then(
            () => 'fulfilled',
            (error: { code?: string }) => error.code ?? 'other'
          )
        }
        return executeIn(trx, parent.operation, makeAuthorizedCommandInput(1))
      })
    )
    assert.isFalse(outcome.replayed)
    assert.equal(detachedOutcomeCode, 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await listReceiptStates(client), [['c1', 'completed']])
  })

  test('awaiting a sibling called later is refused, not hung', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const a = makeNamedOperation('notes.a')
    const b = makeNamedOperation('notes.b')
    let later: Promise<unknown> = Promise.resolve()
    a.hooks.afterWork = async () => {
      await later
    }
    const [first, second] = await awaitWithDeadline(
      client.transaction((trx) => {
        const pendingA = executeIn(trx, a.operation, makeAuthorizedCommandInput(1))
        later = executeIn(trx, b.operation, makeAuthorizedCommandInput(2))
        return Promise.allSettled([pendingA, later])
      })
    )
    assert.equal(readOutcomeCode(first), 'E_CONCURRENT_COMMAND')
    assert.equal(readOutcomeCode(second), 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await listReceiptStates(client), [])
  })
})

test.group('nested commands must be awaited', () => {
  test('nested commands awaited one after another inside work compose', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2, 3]) await addProof(client, `p${sequenceNumber}`)
    const outer = makeNamedOperation('notes.outer')
    const a = makeNamedOperation('notes.a')
    const b = makeNamedOperation('notes.b')
    outer.hooks.afterWork = async ({ trx }) => {
      await executeIn(trx, a.operation, makeAuthorizedCommandInput(1))
      await executeIn(trx, b.operation, makeAuthorizedCommandInput(2))
    }
    await awaitWithDeadline(
      client.transaction((trx) => executeIn(trx, outer.operation, makeAuthorizedCommandInput(3)))
    )
    assert.deepEqual(await listReceiptStates(client), [
      ['c1', 'completed'],
      ['c2', 'completed'],
      ['c3', 'completed'],
    ])
  })

  test('parallel nested commands inside work: the second is refused', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2, 3]) await addProof(client, `p${sequenceNumber}`)
    const outer = makeNamedOperation('notes.outer')
    const a = makeNamedOperation('notes.a')
    const b = makeNamedOperation('notes.b')
    let nested: PromiseSettledResult<unknown>[] = []
    outer.hooks.afterWork = async ({ trx }) => {
      nested = await Promise.allSettled([
        executeIn(trx, a.operation, makeAuthorizedCommandInput(1)),
        executeIn(trx, b.operation, makeAuthorizedCommandInput(2)),
      ])
    }
    await awaitWithDeadline(
      client.transaction((trx) => executeIn(trx, outer.operation, makeAuthorizedCommandInput(3)))
    )
    assert.deepEqual(nested.map(readOutcomeCode), ['fulfilled', 'E_CONCURRENT_COMMAND'])
    assert.deepEqual(await listReceiptStates(client), [
      ['c1', 'completed'],
      ['c3', 'completed'],
    ])
  })

  test('a parent that returns before its child fails loudly and commits nothing', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    let pending: Promise<unknown> = Promise.resolve()
    parent.hooks.afterWork = ({ trx }) => {
      pending = executeIn(trx, child.operation, makeAuthorizedCommandInput(2))
    }
    const [outcome, nested] = await awaitWithDeadline(
      client
        .transaction((trx) => executeIn(trx, parent.operation, makeAuthorizedCommandInput(1)))
        .then(
          (value) => ({ status: 'fulfilled', value }) as const,
          (reason: unknown) => ({ status: 'rejected', reason }) as const
        )
        .then(async (result) => {
          const [nestedResult] = await Promise.allSettled([pending])
          return [result, nestedResult] as const
        })
    )
    assert.equal(readOutcomeCode(outcome), 'E_UNAWAITED_NESTED_COMMAND')
    assert.equal(readOutcomeCode(nested), 'E_UNAWAITED_NESTED_COMMAND')
    assert.deepEqual(await listReceiptStates(client), [])
    assert.equal(await countRows(client, 'notes'), 0)
  })

  test("an unawaited child cannot erase the parent's write behind a success", async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    let pending: Promise<unknown> = Promise.resolve()
    parent.hooks.afterWork = async ({ trx }) => {
      pending = executeIn(trx, child.operation, makeAuthorizedCommandInput(2))
      await trx.table('notes').insert({ scope_id: 's1', body: 'parent write' })
    }
    child.hooks.afterWork = async () => {
      await sleep(50)
      throw new Error('child failed')
    }
    const host = await awaitWithDeadline(
      client.transaction(async (trx) => {
        const result = await Promise.allSettled([
          executeIn(trx, parent.operation, makeAuthorizedCommandInput(1)),
        ])
        return [...result, ...(await Promise.allSettled([pending]))]
      })
    )
    assert.equal(readOutcomeCode(host[0]), 'E_UNAWAITED_NESTED_COMMAND')
    assert.include(['E_UNAWAITED_NESTED_COMMAND', 'child failed'], readOutcomeCode(host[1]))
    assert.deepEqual(await listReceiptStates(client), [])
    assert.equal(await countRows(client, 'notes'), 0)
  })

  test('a failing parent with an open child rethrows its own error and keeps nothing', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    const childInWork = makeSignal()
    let pending: Promise<unknown> = Promise.resolve()
    parent.hooks.afterWork = async ({ trx }) => {
      pending = executeIn(trx, child.operation, makeAuthorizedCommandInput(2))
      await awaitOrSkip(childInWork.fired, 1000)
      throw new Error('parent failed')
    }
    child.hooks.afterWork = async () => {
      childInWork.fire()
      await sleep(50)
      throw new Error('child failed after the abort')
    }
    const host = await awaitWithDeadline(
      client.transaction(async (trx) => {
        const result = await Promise.allSettled([
          executeIn(trx, parent.operation, makeAuthorizedCommandInput(1)),
        ])
        return [...result, ...(await Promise.allSettled([pending]))]
      })
    )
    assert.equal(readOutcomeCode(host[0]), 'parent failed')
    assert.equal(readOutcomeCode(host[1]), 'E_UNAWAITED_NESTED_COMMAND')
    assert.deepEqual(await listReceiptStates(client), [])
    assert.equal(await countRows(client, 'notes'), 0)
  })

  test('a nested command from authorizeAccess is rolled back with its parent', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    parent.hooks.afterAccess = async ({ trx }) => {
      await executeIn(trx, child.operation, makeAuthorizedCommandInput(2))
    }
    parent.hooks.afterWork = () => {
      throw new Error('parent failed')
    }
    await awaitWithDeadline(
      client.transaction((trx) =>
        executeIn(trx, parent.operation, makeAuthorizedCommandInput(1)).catch(() => null)
      )
    )
    assert.deepEqual(await listReceiptStates(client), [])
    assert.equal(await countRows(client, 'notes'), 0)
  })

  test('a replay whose policy left a child open fails loudly', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    await client.transaction((trx) =>
      executeIn(trx, parent.operation, makeAuthorizedCommandInput(1))
    )
    let pending: Promise<unknown> = Promise.resolve()
    parent.hooks.afterReplay = ({ trx }) => {
      pending = executeIn(trx, child.operation, makeAuthorizedCommandInput(2))
    }
    const host = await awaitWithDeadline(
      client.transaction(async (trx) => {
        const result = await Promise.allSettled([
          executeIn(trx, parent.operation, makeCommandInput(1)),
        ])
        return [...result, ...(await Promise.allSettled([pending]))]
      })
    )
    assert.equal(readOutcomeCode(host[0]), 'E_UNAWAITED_NESTED_COMMAND')
    assert.equal(readOutcomeCode(host[1]), 'E_UNAWAITED_NESTED_COMMAND')
    assert.deepEqual(await listReceiptStates(client), [['c1', 'completed']])
  })

  test('a call from a parent that already finished is refused', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    let late: () => Promise<unknown> = () => Promise.resolve()
    parent.hooks.afterWork = ({ trx }) => {
      const later = makeSignal()
      const call = later.fired.then(() =>
        executeIn(trx, child.operation, makeAuthorizedCommandInput(2))
      )
      late = () => {
        later.fire()
        return call
      }
    }
    const [settled] = await awaitWithDeadline(
      client.transaction(async (trx) => {
        await executeIn(trx, parent.operation, makeAuthorizedCommandInput(1))
        return Promise.allSettled([late()])
      })
    )
    assert.equal(readOutcomeCode(settled), 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await listReceiptStates(client), [['c1', 'completed']])
  })
})

test.group('host queries while a command is open (documented rule)', () => {
  test('a host write issued while an unawaited command is open is lost when it fails', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    await addProof(client, 'p1')
    const a = makeNamedOperation('notes.a')
    const aInWork = makeSignal()
    const hostWrote = makeSignal()
    // A is open, inside its work, until the host's write has run.
    a.hooks.afterWork = async () => {
      aInWork.fire()
      await hostWrote.fired
      throw new Error('A failed')
    }
    await awaitWithDeadline(
      client.transaction(async (trx) => {
        const pendingA = executeIn(trx, a.operation, makeAuthorizedCommandInput(1)).catch(
          () => null
        )
        await aInWork.fired
        await trx.table('notes').insert({ scope_id: 's1', body: 'host write' })
        hostWrote.fire()
        await pendingA
      })
    )
    // The README rule: await executeIn before issuing any other query on that transaction.
    assert.equal(await countRows(client, 'notes'), 0)
  })
})

test.group('savepoint names', () => {
  test('a savepoint the host left open inside work does not capture the rollback', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    await addProof(client, 'p1')
    const { operation, hooks } = makeNoteOperation()
    hooks.afterWork = async ({ trx }) => {
      await trx.rawQuery('SAVEPOINT drg')
      throw new Error('work failed')
    }
    await awaitWithDeadline(
      client.transaction((trx) =>
        executeIn(trx, operation, makeAuthorizedCommandInput(1)).catch(() => null)
      )
    )
    assert.lengthOf(await listReceipts(client), 0)
  })
})

test.group('no new children once a command is closing', (group) => {
  group.each.teardown(() => {
    internalHooks.onUnwind = undefined
    internalHooks.onClosing = undefined
  })

  test('a child started while its parent unwinds is refused and nothing commits', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    let late: Promise<unknown> = Promise.resolve()
    parent.hooks.afterWork = ({ trx }) => {
      // Runs in the parent's async context once its failure path has taken its list of children.
      internalHooks.onUnwind = () => {
        internalHooks.onUnwind = undefined
        late = executeIn(trx, child.operation, makeAuthorizedCommandInput(2))
      }
      throw new Error('parent failed')
    }
    const [settled] = await awaitWithDeadline(
      client.transaction(async (trx) => {
        await executeIn(trx, parent.operation, makeAuthorizedCommandInput(1)).catch(() => null)
        return Promise.allSettled([late])
      })
    )
    assert.equal(readOutcomeCode(settled), 'E_UNAWAITED_NESTED_COMMAND')
    assert.deepEqual(await listReceiptStates(client), [])
    assert.equal(await countRows(client, 'notes'), 0)
  })

  for (const replay of [false, true]) {
    test(`a child started once its parent ${replay ? 'replays' : 'completes'} is refused`, async ({
      assert,
    }) => {
      const { client } = await createDatabase()
      for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
      const parent = makeNamedOperation('notes.parent')
      const child = makeNamedOperation('notes.child')
      if (replay)
        await client.transaction((trx) =>
          executeIn(trx, parent.operation, makeAuthorizedCommandInput(1))
        )
      let late: Promise<unknown> = Promise.resolve()
      const outcome = await awaitWithDeadline(
        client.transaction((trx) => {
          // Runs in the parent's async context once it has started to complete or replay.
          internalHooks.onClosing = () => {
            internalHooks.onClosing = undefined
            late = executeIn(trx, child.operation, makeAuthorizedCommandInput(2))
          }
          return executeIn(
            trx,
            parent.operation,
            replay ? makeCommandInput(1) : makeAuthorizedCommandInput(1)
          )
        })
      )
      const [settled] = await Promise.allSettled([late])
      assert.equal(outcome.replayed, replay)
      assert.equal(readOutcomeCode(settled), 'E_UNAWAITED_NESTED_COMMAND')
      assert.deepEqual(await listReceiptStates(client), [['c1', 'completed']])
    })
  }
})

test.group('an aborted branch admits and continues nothing', (group) => {
  group.each.teardown(() => {
    internalHooks.onUnwind = undefined
  })

  /**
   * Parent work starts a child and fails once `ready` fires. The parent's unwind, after it has
   * marked its open children aborted, releases the child's barrier.
   */
  function branch() {
    const parent = makeNamedOperation('notes.parent')
    const child = makeNamedOperation('notes.child')
    const grandchild = makeNamedOperation('notes.grandchild')
    const ready = makeSignal()
    const release = makeSignal()
    let pending: Promise<unknown> = Promise.resolve()
    parent.hooks.afterWork = async ({ trx }) => {
      pending = executeIn(trx, child.operation, makeAuthorizedCommandInput(2))
      internalHooks.onUnwind = () => {
        internalHooks.onUnwind = undefined
        release.fire()
      }
      await ready.fired
      throw new Error('parent failed')
    }
    const run = async (client: Awaited<ReturnType<typeof createDatabase>>['client']) => {
      for (const sequenceNumber of [1, 2, 3]) await addProof(client, `p${sequenceNumber}`)
      const host = await awaitWithDeadline(
        client.transaction(async (trx) => {
          const result = await Promise.allSettled([
            executeIn(trx, parent.operation, makeAuthorizedCommandInput(1)),
          ])
          return [...result, ...(await Promise.allSettled([pending]))]
        })
      )
      return host
    }
    return { child, grandchild, ready, release, run }
  }

  test('a grandchild started after the unwind is refused before any policy', async ({ assert }) => {
    const { client } = await createDatabase()
    const { child, grandchild, ready, release, run } = branch()
    let grandCode = ''
    child.hooks.beforeWork = async ({ trx }) => {
      ready.fire()
      await release.fired
      grandCode = await executeIn(trx, grandchild.operation, makeAuthorizedCommandInput(3)).then(
        () => 'fulfilled',
        (error: { code?: string }) => error.code ?? 'other'
      )
    }
    const host = await run(client)
    assert.deepEqual(host.map(readOutcomeCode), ['parent failed', 'E_UNAWAITED_NESTED_COMMAND'])
    assert.equal(grandCode, 'E_UNAWAITED_NESTED_COMMAND')
    assert.equal(grandchild.calls.access, 0)
    assert.deepEqual(await listReceiptStates(client), [])
    assert.equal(await countRows(client, 'notes'), 0)
  })

  test('an already-open grandchild stops at its next checkpoint', async ({ assert }) => {
    const { client } = await createDatabase()
    const { child, grandchild, ready, release, run } = branch()
    let grandCode = ''
    child.hooks.beforeWork = async ({ trx }) => {
      grandCode = await executeIn(trx, grandchild.operation, makeAuthorizedCommandInput(3)).then(
        () => 'fulfilled',
        (error: { code?: string }) => error.code ?? 'other'
      )
    }
    grandchild.hooks.afterAccess = async () => {
      ready.fire()
      await release.fired
    }
    const host = await run(client)
    assert.deepEqual(host.map(readOutcomeCode), ['parent failed', 'E_UNAWAITED_NESTED_COMMAND'])
    assert.equal(grandCode, 'E_UNAWAITED_NESTED_COMMAND')
    assert.equal(grandchild.calls.access, 1)
    assert.deepEqual(
      [grandchild.calls.parse, grandchild.calls.execute, grandchild.calls.work],
      [0, 0, 0]
    )
    assert.deepEqual(await listReceiptStates(client), [])
    assert.equal(await countRows(client, 'notes'), 0)
  })

  test("the parent's cause is the child's own rejection when the child's callback throws", async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { child, ready, release, run } = branch()
    const interrupted = new Error('work interrupted')
    child.hooks.beforeWork = async () => {
      ready.fire()
      await release.fired
      throw interrupted
    }
    const [parentResult, childResult] = await run(client)
    assert.equal(parentResult.status, 'rejected')
    assert.equal(childResult.status, 'rejected')
    const parentError = (parentResult as PromiseRejectedResult).reason as Error
    const childError = (childResult as PromiseRejectedResult).reason as Error & { code?: string }
    assert.equal(parentError.message, 'parent failed')
    assert.equal(childError.code, 'E_UNAWAITED_NESTED_COMMAND')
    assert.strictEqual(parentError.cause, childError)
    assert.strictEqual(childError.cause, interrupted)
    assert.deepEqual(await listReceiptStates(client), [])
    assert.equal(await countRows(client, 'notes'), 0)
  })
})
