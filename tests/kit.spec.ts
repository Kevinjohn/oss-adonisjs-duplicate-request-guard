import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import BetterSqlite3 from 'better-sqlite3'
import { makeNoteOperation } from './helpers.js'
import { bootKit, fixtureGuard, type KitFixture } from './kit_fixture.js'

const { executeIn, execute, RECEIPTS_TABLE, errors } = fixtureGuard

const makeBusyError = () => Object.assign(new Error('simulated busy'), { code: 'SQLITE_BUSY' })

test.group('executeIn inside Account Kit 0.5.1 authentication.withCurrent', (group) => {
  let fixture: KitFixture
  let users = 0
  group.setup(async () => {
    fixture = await bootKit()
    return () => fixture.close()
  })

  async function prepareGuardedNotes() {
    const sequenceNumber = ++users
    const credential = await fixture.signIn(`user-${sequenceNumber}@x.test`)
    const token = `p${sequenceNumber}`
    await fixture.db.table('proofs').insert({ token, user_id: credential.userId })
    const { operation, calls, hooks } = makeNoteOperation()
    const command = {
      actorId: credential.userId,
      scopeId: 's1',
      payload: { body: `kit ${sequenceNumber}` },
      command: { commandId: `kit-c${sequenceNumber}`, requestKey: `kit-k${sequenceNumber}` },
      authorization: { proofToken: token },
    }
    const readKitAndReceiptState = async () => ({
      receipts: await fixture.db
        .from(RECEIPTS_TABLE)
        .where('command_id', command.command.commandId),
      notes: await fixture.db.from('notes').where('body', command.payload.body),
      pending: await fixture.db.from(RECEIPTS_TABLE).where('state', 'pending'),
      proof: await fixture.db.from('proofs').where('token', token).first(),
    })
    return { credential, operation, calls, hooks, command, state: readKitAndReceiptState }
  }

  test('(a) withCurrent has committed when it returns', async ({ assert }) => {
    const { credential, operation, command } = await prepareGuardedNotes()
    const outcome = await fixture.kit.authentication.withCurrent(credential, ({ trx }) =>
      executeIn(trx, operation, command)
    )
    assert.isFalse(outcome.replayed)
    // A separate connection sees only committed data.
    const reader = new BetterSqlite3(fixture.file, { readonly: true })
    try {
      const receipt = reader
        .prepare(`select state from ${RECEIPTS_TABLE} where command_id = ?`)
        .get(command.command.commandId) as { state: string } | undefined
      assert.equal(receipt?.state, 'completed')
      const notes = reader
        .prepare('select count(*) as n from notes where body = ?')
        .get(command.payload.body) as { n: number }
      assert.equal(notes.n, 1)
    } finally {
      reader.close()
    }
    const replay = await fixture.kit.authentication.withCurrent(credential, ({ trx }) =>
      executeIn(trx, operation, { ...command, authorization: 'garbage' })
    )
    assert.deepEqual(replay, { replayed: true, result: outcome.result })
  })

  test('(b) a rerun after a busy error mid-work leaves one receipt and one side effect', async ({
    assert,
  }) => {
    const { credential, operation, calls, hooks, command, state } = await prepareGuardedNotes()
    let runs = 0
    hooks.beforeWork = () => {
      if (calls.work === 1) throw makeBusyError()
    }
    const outcome = await fixture.kit.authentication.withCurrent(credential, ({ trx }) => {
      runs++
      return executeIn(trx, operation, command)
    })
    assert.equal(runs, 2)
    assert.isFalse(outcome.replayed)
    assert.deepInclude(calls, { parse: 2, execute: 2, work: 2, replay: 0 })
    const after = await state()
    assert.lengthOf(after.receipts, 1)
    assert.equal(after.receipts[0].state, 'completed')
    assert.lengthOf(after.notes, 1)
    assert.lengthOf(after.pending, 0)
    assert.equal(after.proof.used, 1)
  })

  test('(b) a rerun after completion but before commit runs fresh, not as a replay', async ({
    assert,
  }) => {
    const { credential, operation, calls, command, state } = await prepareGuardedNotes()
    let runs = 0
    const outcome = await fixture.kit.authentication.withCurrent(credential, async ({ trx }) => {
      const result = await executeIn(trx, operation, command)
      if (++runs === 1) throw makeBusyError()
      return result
    })
    assert.equal(runs, 2)
    assert.isFalse(outcome.replayed)
    assert.deepInclude(calls, { work: 2, replay: 0 })
    const after = await state()
    assert.lengthOf(after.receipts, 1)
    assert.lengthOf(after.notes, 1)
    assert.lengthOf(after.pending, 0)
  })

  test('(b) real lock contention from another connection is waited out by the Kit', async ({
    assert,
  }) => {
    const { credential, operation, calls, command, state } = await prepareGuardedNotes()
    const other = new BetterSqlite3(fixture.file)
    const ownerClient = fixture.db.connection().getWriteClient()
    let runs = 0
    let observeBusy!: () => void
    const observedBusy = new Promise<void>((resolve) => (observeBusy = resolve))
    const onQueryError = (error: { code?: string }, query: { sql?: string }) => {
      if (error.code === 'SQLITE_BUSY' && query.sql?.includes('update account_transaction_lock')) {
        observeBusy()
      }
    }
    let deadline: NodeJS.Timeout | undefined
    let outcome
    other.exec('BEGIN IMMEDIATE')
    ownerClient.on('query-error', onQueryError)
    try {
      const pending = fixture.kit.authentication.withCurrent(credential, ({ trx }) => {
        runs++
        return executeIn(trx, operation, command)
      })
      const waitForBusy = new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Account Kit did not encounter SQLITE_BUSY')),
          3000
        )
      })
      try {
        await Promise.race([
          observedBusy,
          waitForBusy,
          pending.then(() => {
            throw new Error('Account Kit completed while the competing lock was held')
          }),
        ])
      } finally {
        other.exec('ROLLBACK')
        await pending.catch(() => {})
      }
      outcome = await pending
    } finally {
      clearTimeout(deadline)
      ownerClient.off('query-error', onQueryError)
      other.close()
    }
    assert.isFalse(outcome.replayed)
    // The Kit takes its own lock before calling run, so blocked attempts never reach run.
    assert.equal(runs, 1)
    assert.equal(calls.work, 1)
    const after = await state()
    assert.lengthOf(after.receipts, 1)
    assert.lengthOf(after.notes, 1)
  })

  test('(b) the Kit gives up after about 5 seconds of contention and leaves nothing', async ({
    assert,
  }) => {
    const { credential, operation, calls, command, state } = await prepareGuardedNotes()
    const other = new BetterSqlite3(fixture.file)
    other.exec('BEGIN IMMEDIATE')
    const started = performance.now()
    try {
      const error = await fixture.kit.authentication
        .withCurrent(credential, ({ trx }) => executeIn(trx, operation, command))
        .catch((e) => e)
      assert.equal(error.code, 'SQLITE_BUSY')
      assert.closeTo(performance.now() - started, 5000, 500)
    } finally {
      other.exec('ROLLBACK')
      other.close()
    }
    assert.equal(calls.work, 0)
    const after = await state()
    assert.lengthOf(after.receipts, 0)
    assert.lengthOf(after.notes, 0)
  }).timeout(10_000)

  test('a host rollback leaves nothing, then a retry commits once and replay writes nothing', async ({
    assert,
  }) => {
    const { credential, operation, calls, command, state } = await prepareGuardedNotes()
    await assert.rejects(
      () =>
        fixture.kit.authentication.withCurrent(credential, async ({ trx }) => {
          await executeIn(trx, operation, command)
          throw new Error('host rejected the completed command')
        }),
      'host rejected the completed command'
    )
    assert.equal(calls.work, 1)
    const rolledBack = await state()
    assert.lengthOf(rolledBack.receipts, 0)
    assert.lengthOf(rolledBack.notes, 0)
    assert.equal(rolledBack.proof.used, 0)

    const retry = await fixture.kit.authentication.withCurrent(credential, ({ trx }) =>
      executeIn(trx, operation, command)
    )
    assert.isFalse(retry.replayed)

    const replay = await fixture.kit.authentication.withCurrent(credential, ({ trx }) =>
      executeIn(trx, operation, command)
    )
    assert.deepEqual(replay, { replayed: true, result: retry.result })
    assert.equal(calls.work, 2)
    const committed = await state()
    assert.lengthOf(committed.receipts, 1)
    assert.equal(committed.receipts[0].state, 'completed')
    assert.lengthOf(committed.notes, 1)
    assert.equal(committed.proof.used, 1)
  })

  test('execute (managed) refuses the Kit transaction', async ({ assert }) => {
    const { credential, operation, command } = await prepareGuardedNotes()
    await assert.rejects(
      () =>
        fixture.kit.authentication.withCurrent(credential, ({ trx }) =>
          execute(trx as never, operation, command)
        ),
      errors.TransactionOwnerException
    )
  })
})

test('bootKit removes its temporary app when setup fails', async ({ assert, cleanup }) => {
  // Its own parent directory: another run's fixture in the shared temp directory is not a leak.
  const parent = await mkdtemp(join(tmpdir(), 'adonisjs-duplicate-request-guard-leak-'))
  cleanup(() => rm(parent, { recursive: true, force: true }))
  await assert.rejects(
    () =>
      bootKit({
        parent,
        appMigration: `import { BaseSchema } from '@adonisjs/lucid/schema'
export default class extends BaseSchema {
  async up() {
    throw new Error('setup failure')
  }
}
`,
      }),
    /setup failure/
  )
  assert.deepEqual(await readdir(parent), [])
}).timeout(30_000)
