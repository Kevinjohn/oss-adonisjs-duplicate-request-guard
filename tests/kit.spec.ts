import { test } from '@japa/runner'
import BetterSqlite3 from 'better-sqlite3'
import { executeIn, execute, RECEIPTS_TABLE } from '../index.js'
import { errors, noteOperation } from './helpers.js'
import { bootKit, type KitFixture } from './kit_fixture.js'

const busy = () => Object.assign(new Error('simulated busy'), { code: 'SQLITE_BUSY' })

test.group('executeIn inside Account Kit 0.3.2 authentication.withCurrent', (group) => {
  let fixture: KitFixture
  let users = 0
  group.setup(async () => {
    fixture = await bootKit()
    return () => fixture.close()
  })

  async function setup() {
    const n = ++users
    const credential = await fixture.signIn(`user-${n}@x.test`)
    const token = `p${n}`
    await fixture.db.table('proofs').insert({ token, user_id: credential.userId })
    const { operation, calls, hooks } = noteOperation()
    const command = {
      actorId: credential.userId,
      scopeId: 's1',
      payload: { body: `kit ${n}` },
      command: { commandId: `kit-c${n}`, requestKey: `kit-k${n}` },
      authorization: { proofToken: token },
    }
    const state = async () => ({
      receipts: await fixture.db
        .from(RECEIPTS_TABLE)
        .where('command_id', command.command.commandId),
      notes: await fixture.db.from('notes').where('body', command.payload.body),
      pending: await fixture.db.from(RECEIPTS_TABLE).where('state', 'pending'),
      proof: await fixture.db.from('proofs').where('token', token).first(),
    })
    return { credential, operation, calls, hooks, command, state }
  }

  test('(a) withCurrent has committed when it returns', async ({ assert }) => {
    const { credential, operation, command } = await setup()
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
    const { credential, operation, calls, hooks, command, state } = await setup()
    let runs = 0
    hooks.beforeWork = () => {
      if (calls.work === 1) throw busy()
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
    const { credential, operation, calls, command, state } = await setup()
    let runs = 0
    const outcome = await fixture.kit.authentication.withCurrent(credential, async ({ trx }) => {
      const result = await executeIn(trx, operation, command)
      if (++runs === 1) throw busy()
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
    const { credential, operation, calls, command, state } = await setup()
    const other = new BetterSqlite3(fixture.file)
    other.exec('BEGIN IMMEDIATE')
    let runs = 0
    const started = performance.now()
    const pending = fixture.kit.authentication.withCurrent(credential, ({ trx }) => {
      runs++
      return executeIn(trx, operation, command)
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    other.exec('COMMIT')
    other.close()
    const outcome = await pending
    assert.isAbove(performance.now() - started, 140)
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
    const { credential, operation, calls, command, state } = await setup()
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

  test('a non-busy failure is not retried and rolls everything back', async ({ assert }) => {
    const { credential, operation, calls, hooks, command, state } = await setup()
    hooks.beforeWork = () => {
      throw new Error('work failed')
    }
    await assert.rejects(
      () =>
        fixture.kit.authentication.withCurrent(credential, ({ trx }) =>
          executeIn(trx, operation, command)
        ),
      'work failed'
    )
    assert.equal(calls.work, 1)
    const after = await state()
    assert.lengthOf(after.receipts, 0)
    assert.equal(after.proof.used, 0)
  })

  test('execute (managed) refuses the Kit transaction', async ({ assert }) => {
    const { credential, operation, command } = await setup()
    await assert.rejects(
      () =>
        fixture.kit.authentication.withCurrent(credential, ({ trx }) =>
          execute(trx as never, operation, command)
        ),
      errors.TransactionOwnerException
    )
  })
})
