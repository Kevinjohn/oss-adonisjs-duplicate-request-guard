import { test } from '@japa/runner'
import { Worker } from 'node:worker_threads'
import { execute, pruneReceipts, RECEIPTS_TABLE } from '../index.js'
import { addProof, count, createDatabase, input, noteOperation, receipts } from './helpers.js'

const N = 30
async function seed(client: Parameters<typeof addProof>[0]) {
  for (let i = 1; i <= N; i++) await addProof(client, `p${i}`)
}
const runAll = (client: any, operation: any) =>
  Promise.all(
    Array.from({ length: N }, (_, i) =>
      execute(client, operation, { ...input(i + 1), authorization: { proofToken: `p${i + 1}` } })
    )
  )

test.group('pruneReceipts', () => {
  test('deletes completed receipts older than the cutoff only', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await addProof(client, 'p1')
    await addProof(client, 'p2')
    await addProof(client, 'p3')
    await execute(client, operation, { ...input(1), authorization: { proofToken: 'p1' } })
    await execute(client, operation, { ...input(2), authorization: { proofToken: 'p2' } })
    await client
      .from(RECEIPTS_TABLE)
      .where('command_id', 'c1')
      .update({ updated_at: '2020-01-01T00:00:00.000Z' })
    await client.table(RECEIPTS_TABLE).insert({
      id: 'stray',
      scope_id: 's1',
      command_id: 'stray',
      operation: 'x',
      request_key: 'stray',
      payload_hash: 'x',
      state: 'pending',
      result: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    })

    assert.equal(await pruneReceipts(client, { olderThan: new Date('2025-01-01T00:00:00Z') }), 1)
    const left = await receipts(client)
    assert.sameMembers(
      left.map((row) => row.command_id),
      ['c2', 'stray']
    )
    // A pruned identity is fresh again.
    const rerun = await execute(client, operation, {
      ...input(1),
      authorization: { proofToken: 'p3' },
    })
    assert.isFalse(rerun.replayed)
  })

  test('prune racing in-flight executes on the same pool never removes a pending row', async ({
    assert,
  }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await seed(client)
    const everything = { olderThan: new Date('2100-01-01T00:00:00Z') }
    const executes = runAll(client, operation)
    const prunes = Promise.all(Array.from({ length: N }, () => pruneReceipts(client, everything)))
    // A deleted pending row would make completion throw E_RECEIPT_NOT_PENDING.
    const outcomes = await executes
    await prunes
    assert.isTrue(outcomes.every((outcome) => !outcome.replayed))
    assert.lengthOf(await client.from(RECEIPTS_TABLE).where('state', 'pending'), 0)
    assert.equal(await count(client, 'notes'), N)
  })

  test('prune with a past cutoff racing executes keeps every fresh receipt', async ({ assert }) => {
    const { client } = await createDatabase()
    const { operation } = noteOperation()
    await seed(client)
    const cutoff = { olderThan: new Date(Date.now() - 1) }
    const [outcomes, deleted] = await Promise.all([
      runAll(client, operation),
      Promise.all(Array.from({ length: N }, () => pruneReceipts(client, cutoff))),
    ])
    assert.isTrue(outcomes.every((outcome) => !outcome.replayed))
    assert.equal(
      deleted.reduce((a, b) => a + b, 0),
      0
    )
    assert.lengthOf(await receipts(client), N)
  })

  test('prune from another connection (worker thread) racing executes', async ({ assert }) => {
    const { client, file } = await createDatabase()
    const { operation } = noteOperation()
    await seed(client)
    const stop = new Int32Array(new SharedArrayBuffer(4))
    const worker = new Worker(new URL('fixtures/prune_worker.ts', import.meta.url), {
      workerData: { file, stop },
      execArgv: ['--import=@poppinss/ts-exec'],
    })
    const messages: unknown[] = []
    let ready!: () => void
    const isReady = new Promise<void>((resolve) => (ready = resolve))
    const report = new Promise<{ runs: number; deleted: number }>((resolve, reject) => {
      worker.on('message', (message) => {
        messages.push(message)
        if (message === 'ready') ready()
        else resolve(message)
      })
      worker.once('error', reject)
    })
    await isReady
    let outcomes: Awaited<ReturnType<typeof runAll>>
    try {
      outcomes = await runAll(client, operation)
    } finally {
      Atomics.store(stop, 0, 1)
    }
    const { runs, deleted } = await report
    // The worker kept pruning for the whole run, so it interleaved with the executes.
    assert.isAbove(runs, 1)
    assert.isTrue(outcomes.every((outcome) => !outcome.replayed))
    assert.lengthOf(await client.from(RECEIPTS_TABLE).where('state', 'pending'), 0)
    assert.equal(await count(client, 'notes'), N)
    assert.isAtMost(deleted, N)
  }).timeout(30_000)
})
