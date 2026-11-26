import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import { requestDeduplicator } from '../../index.ts'
import {
  addProof,
  makeAuthorizedOperationInput,
  makeNamedOperation,
  prepareSchema,
  sleep,
} from '../helpers.ts'

const app = new AppFactory().create(new URL('../', import.meta.url), () => {})
const db = new Database(
  {
    connection: 'sqlite',
    connections: { sqlite: { client: 'better-sqlite3', connection: { filename: ':memory:' } } },
  },
  new LoggerFactory().create(),
  new Emitter(app)
)
try {
  const client = db.connection()
  await prepareSchema(client)
  await addProof(client, 'p1')
  await addProof(client, 'p2')
  const parent = makeNamedOperation('notes.parent')
  const child = makeNamedOperation('notes.child')
  child.hooks.beforeWork = () => {
    throw new Error('dropped child failed')
  }
  // Deliberately ignore the child promise. The child fails and settles before the parent finishes,
  // so the parent completes and no parent reports the child's failure.
  parent.hooks.afterWork = async ({ trx }) => {
    void requestDeduplicator.executeIn(trx, child.operation, makeAuthorizedOperationInput(2))
    await sleep(50)
  }
  await client.transaction(async (trx) => {
    const outcome = await requestDeduplicator.executeIn(
      trx,
      parent.operation,
      makeAuthorizedOperationInput(1)
    )
    assert.equal(outcome.replayed, false)
  })
  await setImmediate()
  console.log('parent committed and the dropped child failure reached nobody')
} finally {
  await db.manager.closeAll()
}
