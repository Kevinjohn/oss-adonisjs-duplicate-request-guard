import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import {
  execute,
  type ExecuteInput,
  type Operation,
} from '@kevinjohn/adonisjs-duplicate-request-guard'
import type { Operation as SubpathOperation } from '@kevinjohn/adonisjs-duplicate-request-guard/types'
import { execute as executeOld, type Operation as OldOperation } from 'old-duplicate-request-guard'

// Compile against both archives' declarations. An inferred parser result must reach work and
// an inferred operation result must reach the caller without falling back to any.
export async function verifyInference(
  client: QueryClientContract,
  input: ExecuteInput<{ body: string }>
) {
  const old = await executeOld(
    client,
    {
      name: 'old.inferred',
      authorizeAccess() {},
      parseAuthorization: () => 'proof',
      work({ payload }, proof) {
        return { text: payload.body + proof.toUpperCase() }
      },
    },
    input
  )
  const current = await execute(
    client,
    {
      name: 'current.inferred',
      authorizeAccess() {},
      parseAuthorization: () => 'proof',
      work({ payload }, proof) {
        return { text: payload.body + proof.toUpperCase() }
      },
    },
    input
  )
  const oldText: string = old.result.text
  const currentText: string = current.result.text
  // @ts-expect-error The result type must not be any.
  const wrong: number = current.result.text
  return [oldText, currentText, wrong]
}

const root = new URL('./', import.meta.url)
const packageName = '@kevinjohn/adonisjs-duplicate-request-guard'
const ignitor = new IgnitorFactory()
  .withCoreProviders()
  .withCoreConfig()
  .merge({ rcFileContents: { providers: [], commands: [async () => new ListLoader([Configure])] } })
  .create(root, { importer: (specifier) => import(specifier) })
const migrations = new URL('database/migrations/', root)
await ignitor.ace().handle(['configure', packageName])
const files = await readdir(migrations)
assert.equal(files.length, 1)
const published = await readFile(new URL(files[0], migrations), 'utf8')
await ignitor.ace().handle(['configure', packageName])
assert.deepEqual(await readdir(migrations), files)
assert.equal(await readFile(new URL(files[0], migrations), 'utf8'), published)

const app = new AppFactory().create(root, () => {})
const db = new Database(
  {
    connection: 'sqlite',
    connections: { sqlite: { client: 'better-sqlite3', connection: { filename: ':memory:' } } },
  },
  new LoggerFactory().create(),
  new Emitter(app)
)
const client = db.connection()
try {
  const { default: Migration } = await import(new URL(files[0], migrations).href)
  await new Migration(client, 'receipts', false).execUp()
  let fresh = 0
  let access = 0
  let replay = 0
  const operation: Operation<{ body: string }, string, { noteId: number }> = {
    name: 'notes.create',
    authorizeAccess() {
      access++
    },
    authorizeReplay() {
      replay++
    },
    parseAuthorization(raw) {
      assert.equal(raw, 'host-validated proof')
      return raw
    },
    authorizeExecute(_context, proof) {
      assert.equal(proof.toUpperCase(), 'HOST-VALIDATED PROOF')
    },
    work(_context, proof) {
      assert.equal(proof, 'host-validated proof')
      return { noteId: ++fresh }
    },
  }
  const oldOperation: OldOperation<{ body: string }, string, { noteId: number }> = operation
  const subpathOperation: SubpathOperation<{ body: string }, string, { noteId: number }> =
    oldOperation
  const input: ExecuteInput<{ body: string }> = {
    actorId: 'authenticated-actor',
    scopeId: 'host-authorized-scope',
    payload: { body: 'note' },
    command: { commandId: 'client-id', requestKey: 'client-key' },
    authorization: 'host-validated proof',
  }
  const initial = await executeOld(client, oldOperation, input)
  assert.deepEqual(initial, { replayed: false, result: { noteId: 1 } })
  const repeated = await execute(client, subpathOperation, { ...input, authorization: undefined })
  assert.deepEqual(repeated, { replayed: true, result: initial.result })
  assert.deepEqual(
    await execute(client, operation, {
      ...input,
      command: { commandId: 'fresh-id', requestKey: 'fresh-key' },
    }),
    { replayed: false, result: { noteId: 2 } }
  )
  assert.equal(access, 3)
  assert.equal(replay, 1)
  assert.equal(fresh, 2)
  assert.equal((await client.from('request_receipts')).length, 2)
  console.log('Packed candidate configured twice, ran its migration and replayed a v0.1.3 receipt.')
} finally {
  await db.manager.closeAll()
}
