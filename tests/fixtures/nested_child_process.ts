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
  // Deliberately ignore the child promise. Its still-open work forces the parent to fail.
  parent.hooks.afterWork = ({ trx }) => {
    void executeIn(trx, child.operation, makeAuthorizedOperationInput(2))
  }
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
  console.log('parent failed, no unhandled child rejection or committed writes')
} finally {
  await db.manager.closeAll()
}
