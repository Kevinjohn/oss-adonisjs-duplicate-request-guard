import { test } from '@japa/runner'
import { executeIn } from '../index.js'
import { internalHooks } from '../src/receipts.js'
import { addProof, count, createDatabase, input, noteOperation, receipts } from './helpers.js'

/** Sibling, nested and aborted commands on one transaction. A hang becomes a failure here. */
async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hung for ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, hung])
  } finally {
    clearTimeout(timer)
  }
}

function signal() {
  let fire!: () => void
  const fired = new Promise<void>((resolve) => (fire = resolve))
  return { fire, fired }
}

/** Waits for the signal, or gives up after `ms`: a serialized sibling never sends it. */
const awaitOrSkip = (fired: Promise<void>, ms = 300) =>
  Promise.race([fired, new Promise<void>((resolve) => setTimeout(resolve, ms))])

function named(name: string) {
  const op = noteOperation()
  return { ...op, operation: { ...op.operation, name } }
}

const auth = (n: number) => ({ ...input(n), authorization: { proofToken: `p${n}` } })
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The error code a settled call failed with, or 'fulfilled'. */
const codeOf = (result: PromiseSettledResult<unknown>) =>
  result.status === 'fulfilled'
    ? 'fulfilled'
    : ((result.reason as { code?: string }).code ?? (result.reason as Error).message)

async function committed(client: Parameters<typeof receipts>[0]) {
  const rows = await receipts(client)
  return rows.map((row) => [row.command_id, row.state]).sort()
}

test.group('siblings on one transaction are refused, never queued', () => {
  test('(a) a sibling started while a command is open is refused at once', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const a = named('notes.a')
    const b = named('notes.b')
    const bSettled = signal()
    a.hooks.afterWork = async () => {
      await awaitOrSkip(bSettled.fired)
      throw new Error('A failed')
    }
    const [first, second] = await within(
      client.transaction((trx) =>
        Promise.allSettled([
          executeIn(trx, a.operation, auth(1)),
          executeIn(trx, b.operation, auth(2)).finally(bSettled.fire),
        ])
      )
    )
    assert.equal(codeOf(first), 'A failed')
    assert.equal(codeOf(second), 'E_CONCURRENT_COMMAND')
    assert.equal(b.calls.access, 0)
    assert.deepEqual(await committed(client), [])
  })

  test('(b) a sibling cannot release or mask a failing command', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const a = named('notes.a')
    const b = named('notes.b')
    const [first, second] = await within(
      client.transaction((trx) =>
        Promise.allSettled([
          executeIn(trx, a.operation, auth(1)),
          executeIn(trx, b.operation, auth(2)),
        ])
      )
    )
    assert.equal(codeOf(first), 'fulfilled')
    assert.equal(codeOf(second), 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await committed(client), [['c1', 'completed']])
  })

  test("a sibling never authorizes against another command's uncommitted write", async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    await addProof(client, 'p1')
    await addProof(client, 'p2', 'carol')
    const a = named('notes.a')
    const b = named('notes.b')
    const aInWork = signal()
    const bSettled = signal()
    a.hooks.beforeWork = async ({ trx }) => {
      await trx.table('memberships').insert({ scope_id: 's1', user_id: 'carol', role: 'owner' })
      aInWork.fire()
      await awaitOrSkip(bSettled.fired, 1000)
      throw new Error('A failed')
    }
    const [first, second] = await within(
      client.transaction(async (trx) => {
        const pendingA = executeIn(trx, a.operation, auth(1))
        await aInWork.fired
        const pendingB = executeIn(trx, b.operation, {
          ...input(2, { actorId: 'carol' }),
          authorization: { proofToken: 'p2' },
        }).finally(bSettled.fire)
        return Promise.allSettled([pendingA, pendingB])
      })
    )
    assert.equal(codeOf(first), 'A failed')
    assert.equal(codeOf(second), 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await committed(client), [])
    assert.lengthOf(await client.from('memberships').where('user_id', 'carol'), 0)
  })

  test("a call that lost the command's async context is refused, not hung", async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const lost = named('notes.lost')
    const gate = signal()
    let seen = ''
    const outcome = await within(
      client.transaction((trx) => {
        // Registered in the host's context, run when the parent's work opens the gate.
        const call = gate.fired.then(() => executeIn(trx, lost.operation, auth(2)))
        parent.hooks.afterWork = async () => {
          gate.fire()
          seen = await call.then(
            () => 'fulfilled',
            (error: { code?: string }) => error.code ?? 'other'
          )
        }
        return executeIn(trx, parent.operation, auth(1))
      })
    )
    assert.isFalse(outcome.replayed)
    assert.equal(seen, 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await committed(client), [['c1', 'completed']])
  })

  test('awaiting a sibling called later is refused, not hung', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const a = named('notes.a')
    const b = named('notes.b')
    let later: Promise<unknown> = Promise.resolve()
    a.hooks.afterWork = async () => {
      await later
    }
    const [first, second] = await within(
      client.transaction((trx) => {
        const pendingA = executeIn(trx, a.operation, auth(1))
        later = executeIn(trx, b.operation, auth(2))
        return Promise.allSettled([pendingA, later])
      })
    )
    assert.equal(codeOf(first), 'E_CONCURRENT_COMMAND')
    assert.equal(codeOf(second), 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await committed(client), [])
  })
})

test.group('nested commands must be awaited', () => {
  test('nested commands awaited one after another inside work compose', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2, 3]) await addProof(client, `p${n}`)
    const outer = named('notes.outer')
    const a = named('notes.a')
    const b = named('notes.b')
    outer.hooks.afterWork = async ({ trx }) => {
      await executeIn(trx, a.operation, auth(1))
      await executeIn(trx, b.operation, auth(2))
    }
    await within(client.transaction((trx) => executeIn(trx, outer.operation, auth(3))))
    assert.deepEqual(await committed(client), [
      ['c1', 'completed'],
      ['c2', 'completed'],
      ['c3', 'completed'],
    ])
  })

  test('parallel nested commands inside work: the second is refused', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2, 3]) await addProof(client, `p${n}`)
    const outer = named('notes.outer')
    const a = named('notes.a')
    const b = named('notes.b')
    let nested: PromiseSettledResult<unknown>[] = []
    outer.hooks.afterWork = async ({ trx }) => {
      nested = await Promise.allSettled([
        executeIn(trx, a.operation, auth(1)),
        executeIn(trx, b.operation, auth(2)),
      ])
    }
    await within(client.transaction((trx) => executeIn(trx, outer.operation, auth(3))))
    assert.deepEqual(nested.map(codeOf), ['fulfilled', 'E_CONCURRENT_COMMAND'])
    assert.deepEqual(await committed(client), [
      ['c1', 'completed'],
      ['c3', 'completed'],
    ])
  })

  test('a parent that returns before its child fails loudly and commits nothing', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const child = named('notes.child')
    let pending: Promise<unknown> = Promise.resolve()
    parent.hooks.afterWork = ({ trx }) => {
      pending = executeIn(trx, child.operation, auth(2))
    }
    const [outcome, nested] = await within(
      client
        .transaction((trx) => executeIn(trx, parent.operation, auth(1)))
        .then(
          (value) => ({ status: 'fulfilled', value }) as const,
          (reason: unknown) => ({ status: 'rejected', reason }) as const
        )
        .then(async (result) => {
          const [nestedResult] = await Promise.allSettled([pending])
          return [result, nestedResult] as const
        })
    )
    assert.equal(codeOf(outcome), 'E_UNAWAITED_NESTED_COMMAND')
    assert.equal(codeOf(nested), 'E_UNAWAITED_NESTED_COMMAND')
    assert.deepEqual(await committed(client), [])
    assert.equal(await count(client, 'notes'), 0)
  })

  test("an unawaited child cannot erase the parent's write behind a success", async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const child = named('notes.child')
    let pending: Promise<unknown> = Promise.resolve()
    parent.hooks.afterWork = async ({ trx }) => {
      pending = executeIn(trx, child.operation, auth(2))
      await trx.table('notes').insert({ scope_id: 's1', body: 'parent write' })
    }
    child.hooks.afterWork = async () => {
      await sleep(50)
      throw new Error('child failed')
    }
    const host = await within(
      client.transaction(async (trx) => {
        const result = await Promise.allSettled([executeIn(trx, parent.operation, auth(1))])
        return [...result, ...(await Promise.allSettled([pending]))]
      })
    )
    assert.equal(codeOf(host[0]), 'E_UNAWAITED_NESTED_COMMAND')
    assert.include(['E_UNAWAITED_NESTED_COMMAND', 'child failed'], codeOf(host[1]))
    assert.deepEqual(await committed(client), [])
    assert.equal(await count(client, 'notes'), 0)
  })

  test('a failing parent with an open child rethrows its own error and keeps nothing', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const child = named('notes.child')
    const childInWork = signal()
    let pending: Promise<unknown> = Promise.resolve()
    parent.hooks.afterWork = async ({ trx }) => {
      pending = executeIn(trx, child.operation, auth(2))
      await awaitOrSkip(childInWork.fired, 1000)
      throw new Error('parent failed')
    }
    child.hooks.afterWork = async () => {
      childInWork.fire()
      await sleep(50)
      throw new Error('child failed after the abort')
    }
    const host = await within(
      client.transaction(async (trx) => {
        const result = await Promise.allSettled([executeIn(trx, parent.operation, auth(1))])
        return [...result, ...(await Promise.allSettled([pending]))]
      })
    )
    assert.equal(codeOf(host[0]), 'parent failed')
    assert.equal(codeOf(host[1]), 'E_UNAWAITED_NESTED_COMMAND')
    assert.deepEqual(await committed(client), [])
    assert.equal(await count(client, 'notes'), 0)
  })

  test('a nested command from authorizeAccess is rolled back with its parent', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const child = named('notes.child')
    parent.hooks.afterAccess = async ({ trx }) => {
      await executeIn(trx, child.operation, auth(2))
    }
    parent.hooks.afterWork = () => {
      throw new Error('parent failed')
    }
    await within(
      client.transaction((trx) => executeIn(trx, parent.operation, auth(1)).catch(() => null))
    )
    assert.deepEqual(await committed(client), [])
    assert.equal(await count(client, 'notes'), 0)
  })

  test('a replay whose policy left a child open fails loudly', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const child = named('notes.child')
    await client.transaction((trx) => executeIn(trx, parent.operation, auth(1)))
    let pending: Promise<unknown> = Promise.resolve()
    parent.hooks.afterReplay = ({ trx }) => {
      pending = executeIn(trx, child.operation, auth(2))
    }
    const host = await within(
      client.transaction(async (trx) => {
        const result = await Promise.allSettled([executeIn(trx, parent.operation, input(1))])
        return [...result, ...(await Promise.allSettled([pending]))]
      })
    )
    assert.equal(codeOf(host[0]), 'E_UNAWAITED_NESTED_COMMAND')
    assert.equal(codeOf(host[1]), 'E_UNAWAITED_NESTED_COMMAND')
    assert.deepEqual(await committed(client), [['c1', 'completed']])
  })

  test('a call from a parent that already finished is refused', async ({ assert }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const child = named('notes.child')
    let late: () => Promise<unknown> = () => Promise.resolve()
    parent.hooks.afterWork = ({ trx }) => {
      const later = signal()
      const call = later.fired.then(() => executeIn(trx, child.operation, auth(2)))
      late = () => {
        later.fire()
        return call
      }
    }
    const [settled] = await within(
      client.transaction(async (trx) => {
        await executeIn(trx, parent.operation, auth(1))
        return Promise.allSettled([late()])
      })
    )
    assert.equal(codeOf(settled), 'E_CONCURRENT_COMMAND')
    assert.deepEqual(await committed(client), [['c1', 'completed']])
  })
})

test.group('host queries while a command is open (documented rule)', () => {
  test('a host write issued while an unawaited command is open is lost when it fails', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    await addProof(client, 'p1')
    const a = named('notes.a')
    a.hooks.afterWork = async () => {
      await sleep(50)
      throw new Error('A failed')
    }
    await within(
      client.transaction(async (trx) => {
        const pendingA = executeIn(trx, a.operation, auth(1)).catch(() => null)
        await sleep(10)
        await trx.table('notes').insert({ scope_id: 's1', body: 'host write' })
        await pendingA
      })
    )
    // The README rule: await executeIn before issuing any other query on that transaction.
    assert.equal(await count(client, 'notes'), 0)
  })
})

test.group('savepoint names', () => {
  test('a savepoint the host left open inside work does not capture the rollback', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    await addProof(client, 'p1')
    const { operation, hooks } = noteOperation()
    hooks.afterWork = async ({ trx }) => {
      await trx.rawQuery('SAVEPOINT drg')
      throw new Error('work failed')
    }
    await within(client.transaction((trx) => executeIn(trx, operation, auth(1)).catch(() => null)))
    assert.lengthOf(await receipts(client), 0)
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

test.group('no new children once a command is closing', (group) => {
  group.each.teardown(() => {
    internalHooks.onUnwind = undefined
    internalHooks.onClosing = undefined
  })

  test('a child started while its parent unwinds is refused and nothing commits', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    for (const n of [1, 2]) await addProof(client, `p${n}`)
    const parent = named('notes.parent')
    const child = named('notes.child')
    let late: Promise<unknown> = Promise.resolve()
    parent.hooks.afterWork = ({ trx }) => {
      // Runs in the parent's async context once its failure path has taken its list of children.
      internalHooks.onUnwind = () => {
        internalHooks.onUnwind = undefined
        late = executeIn(trx, child.operation, auth(2))
      }
      throw new Error('parent failed')
    }
    const [settled] = await within(
      client.transaction(async (trx) => {
        await executeIn(trx, parent.operation, auth(1)).catch(() => null)
        return Promise.allSettled([late])
      })
    )
    assert.equal(codeOf(settled), 'E_UNAWAITED_NESTED_COMMAND')
    assert.deepEqual(await committed(client), [])
    assert.equal(await count(client, 'notes'), 0)
  })

  for (const replay of [false, true]) {
    test(`a child started once its parent ${replay ? 'replays' : 'completes'} is refused`, async ({
      assert,
    }) => {
      const { client } = await createDatabase()
      for (const n of [1, 2]) await addProof(client, `p${n}`)
      const parent = named('notes.parent')
      const child = named('notes.child')
      if (replay) await client.transaction((trx) => executeIn(trx, parent.operation, auth(1)))
      let late: Promise<unknown> = Promise.resolve()
      const outcome = await within(
        client.transaction((trx) => {
          // Runs in the parent's async context once it has started to complete or replay.
          internalHooks.onClosing = () => {
            internalHooks.onClosing = undefined
            late = executeIn(trx, child.operation, auth(2))
          }
          return executeIn(trx, parent.operation, replay ? input(1) : auth(1))
        })
      )
      const [settled] = await Promise.allSettled([late])
      assert.equal(outcome.replayed, replay)
      assert.equal(codeOf(settled), 'E_UNAWAITED_NESTED_COMMAND')
      assert.deepEqual(await committed(client), [['c1', 'completed']])
    })
  }
})
