import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import { executeIn } from '../../index.ts'
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
  await addProof(client, 'p3')
  const parent = makeNamedOperation('notes.parent')
  const child = makeNamedOperation('notes.child')
  const grandchild = makeNamedOperation('notes.grandchild')
  // Deliberately ignore both nested promises. The parent fails because its child is still open, and
  // the grandchild stops and settles before the child unwinds, so only the parent's abort can
  // observe its rejection.
  parent.hooks.afterWork = async ({ trx }) => {
    void executeIn(trx, child.operation, makeAuthorizedOperationInput(2))
    await sleep(30)
  }
  child.hooks.afterWork = async ({ trx }) => {
    void executeIn(trx, grandchild.operation, makeAuthorizedOperationInput(3))
    await sleep(200)
  }
  grandchild.hooks.beforeWork = () => sleep(80)
  await client.transaction(async (trx) => {
    await assert.rejects(executeIn(trx, parent.operation, makeAuthorizedOperationInput(1)), {
      code: 'E_UNAWAITED_NESTED_COMMAND',
    })
  })
  await setImmediate()
  const receipts = await client.from('request_receipts')
  const notes = await client.from('notes')
  assert.equal(receipts.length, 0)
  assert.equal(notes.length, 0)
  console.log('parent failed, no unhandled nested rejection or committed writes')
} finally {
  await db.manager.closeAll()
}
