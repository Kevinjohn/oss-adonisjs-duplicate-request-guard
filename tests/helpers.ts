import { getActiveTest } from '@japa/runner'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Emitter } from '@adonisjs/core/events'
import { Database } from '@adonisjs/lucid/database'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type { BaseSchema } from '@adonisjs/lucid/schema'
import { RECEIPTS_TABLE, errors, type Operation, type OperationContext } from '../index.js'

const packageRoot = new URL('../', import.meta.url)

/** Renders the published migration stub into a TS module under ./tmp and returns its class. */
export async function loadMigration(stubBody?: string): Promise<typeof BaseSchema> {
  const body =
    stubBody ??
    (await readFile(
      new URL('stubs/migrations/create_request_receipts_table.stub', packageRoot),
      'utf8'
    ))
  const source = body.replace(/^\{\{\{.*\}\}\}\n/, '')
  const dir = new URL('tmp/', packageRoot)
  await mkdir(dir, { recursive: true })
  const file = new URL(`migration_${process.pid}_${Math.random().toString(36).slice(2)}.ts`, dir)
  await writeFile(file, source)
  try {
    const module = await import(file.href)
    return module.default
  } finally {
    await rm(file, { force: true })
  }
}

/** A file-backed SQLite database with the receipts table and demo host tables. */
export async function createDatabase(pool?: { min?: number; max?: number }, filename?: string) {
  const test = getActiveTest()
  if (!test) throw new Error('Cannot use "createDatabase" outside of a Japa test')
  const directory = await mkdtemp(join(tmpdir(), 'adonisjs-duplicate-request-guard-'))
  const app = new AppFactory().create(pathToFileURL(`${directory}/`), () => {})
  const db = new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: filename ?? join(directory, 'db.sqlite3') },
          useNullAsDefault: true,
          ...(pool ? { pool } : {}),
        },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app)
  )
  test.cleanup(async () => {
    await db.manager.closeAll()
    await rm(directory, { recursive: true, force: true })
  })

  const client = db.connection()
  await prepareSchema(client)
  return { db, client, file: join(directory, 'db.sqlite3') }
}

/** Receipts table from the published stub, plus the demo host tables and memberships. */
export async function prepareSchema(client: QueryClientContract) {
  const Migration = await loadMigration()
  await new Migration(client, 'receipts', false).execUp()
  await client.schema.createTable('memberships', (table) => {
    table.string('scope_id')
    table.string('user_id')
    table.string('role')
  })
  await client.schema.createTable('proofs', (table) => {
    table.string('token').primary()
    table.string('user_id')
    table.boolean('used').defaultTo(false)
  })
  await client.schema.createTable('notes', (table) => {
    table.increments('id')
    table.string('scope_id')
    table.string('body')
  })
  await client.table('memberships').multiInsert([
    { scope_id: 's1', user_id: 'alice', role: 'owner' },
    { scope_id: 's1', user_id: 'bob', role: 'owner' },
  ])
}

export class DeniedException extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

type Payload = { body: string; at?: Date }
type Auth = { proofToken: string }
type Result = { noteId: number }

/** A demo operation that records every call so tests can see what ran. */
export function noteOperation() {
  const calls = { access: 0, replay: 0, parse: 0, execute: 0, work: 0 }
  type Hook = (context: OperationContext<Payload>) => Promise<void> | void
  const hooks: { afterAccess?: Hook; afterReplay?: Hook; beforeWork?: Hook; afterWork?: Hook } = {}
  const role = async (trx: QueryClientContract, scopeId: string, actorId: string) => {
    const row = await trx.from('memberships').where({ scope_id: scopeId, user_id: actorId }).first()
    return row?.role
  }
  const operation: Operation<Payload, Auth, Result> = {
    name: 'notes.add',
    async authorizeAccess(context) {
      calls.access++
      if (!(await role(context.trx, context.scopeId, context.actorId))) {
        throw new DeniedException('access')
      }
      await hooks.afterAccess?.(context)
    },
    async authorizeReplay(context) {
      calls.replay++
      const { trx, scopeId, actorId } = context
      if ((await role(trx, scopeId, actorId)) !== 'owner') throw new DeniedException('replay')
      await hooks.afterReplay?.(context)
    },
    parseAuthorization(raw) {
      calls.parse++
      const token = (raw as { proofToken?: unknown } | null | undefined)?.proofToken
      if (typeof token !== 'string') throw new DeniedException('parse')
      return { proofToken: token }
    },
    async authorizeExecute({ trx, actorId }, { proofToken }) {
      calls.execute++
      const used = await trx
        .from('proofs')
        .where({ token: proofToken, user_id: actorId, used: false })
        .update({ used: true })
      if (Number(used) !== 1) throw new DeniedException('proof')
    },
    async work(context) {
      calls.work++
      await hooks.beforeWork?.(context)
      const [id] = await context.trx
        .table('notes')
        .insert({ scope_id: context.scopeId, body: context.payload.body })
      await hooks.afterWork?.(context)
      return { noteId: Number(id) }
    },
  }
  return { operation, calls, hooks }
}

export async function addProof(client: QueryClientContract, token: string, userId = 'alice') {
  await client.table('proofs').insert({ token, user_id: userId })
}

export const input = (n: number, extra: Record<string, unknown> = {}) => ({
  actorId: 'alice',
  scopeId: 's1',
  payload: { body: `note ${n}` },
  command: { commandId: `c${n}`, requestKey: `k${n}` },
  ...extra,
})

export const receipts = (client: QueryClientContract) => client.from(RECEIPTS_TABLE).select('*')
export const count = async (client: QueryClientContract, table: string) => {
  const [row] = await client.from(table).count('* as n')
  return Number(row.n)
}

export { errors }

/** Fails a test that would otherwise hang: the promise, or an error after `ms`. */
export async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
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

export function signal() {
  let fire!: () => void
  const fired = new Promise<void>((resolve) => (fire = resolve))
  return { fire, fired }
}

/** Waits for the signal, or gives up after `ms`: a serialized sibling never sends it. */
export const awaitOrSkip = (fired: Promise<void>, ms = 300) =>
  Promise.race([fired, new Promise<void>((resolve) => setTimeout(resolve, ms))])

export function named(name: string) {
  const op = noteOperation()
  return { ...op, operation: { ...op.operation, name } }
}

export const auth = (n: number) => ({ ...input(n), authorization: { proofToken: `p${n}` } })
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The error code a settled call failed with, or 'fulfilled'. */
export const codeOf = (result: PromiseSettledResult<unknown>) =>
  result.status === 'fulfilled'
    ? 'fulfilled'
    : ((result.reason as { code?: string }).code ?? (result.reason as Error).message)

export async function committed(client: Parameters<typeof receipts>[0]) {
  const rows = await receipts(client)
  return rows.map((row) => [row.command_id, row.state]).sort()
}
