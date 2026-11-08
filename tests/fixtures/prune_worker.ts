import { parentPort, workerData } from 'node:worker_threads'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import { pruneReceipts } from '../../index.js'

/** Another process stand-in: its own connection pruning in a loop until told to stop. */
const { file, stop } = workerData as { file: string; stop: Int32Array }
const app = new AppFactory().create(new URL('file:///tmp/'), () => {})
const db = new Database(
  {
    connection: 'sqlite',
    connections: {
      sqlite: { client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true },
    },
  },
  new LoggerFactory().create(),
  new Emitter(app)
)
let runs = 0
let deleted = 0
while (Atomics.load(stop, 0) === 0) {
  deleted += await pruneReceipts(db.connection(), { olderThan: new Date('2100-01-01T00:00:00Z') })
  if (++runs === 1) parentPort!.postMessage('ready')
}
await db.manager.closeAll()
parentPort!.postMessage({ runs, deleted })
