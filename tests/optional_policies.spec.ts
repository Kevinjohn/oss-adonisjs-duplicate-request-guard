import { test } from '@japa/runner'
import { execute, type Operation } from '../index.js'
import { count, createDatabase, input, receipts } from './helpers.js'

test.group('execute: optional policies', () => {
  for (const replay of [false, true]) {
    for (const parse of [false, true]) {
      for (const authorize of [false, true]) {
        test(`replay=${replay}, parse=${parse}, execute=${authorize}`, async ({ assert }) => {
          const { client } = await createDatabase()
          const calls: string[] = []
          const expectedAuthorization = parse ? 'parsed proof' : undefined
          const operation: Operation<{ body: string }, string | undefined, { noteId: number }> = {
            name: 'notes.optional',
            authorizeAccess: () => {
              calls.push('access')
            },
            ...(replay
              ? {
                  authorizeReplay: (_context, result) => {
                    calls.push('replay')
                    assert.deepEqual(result, { noteId: 1 })
                  },
                }
              : {}),
            ...(parse
              ? {
                  parseAuthorization: (raw) => {
                    calls.push('parse')
                    assert.equal(raw, 'opaque proof')
                    return 'parsed proof'
                  },
                }
              : {}),
            ...(authorize
              ? {
                  authorizeExecute: (_context, authorization) => {
                    calls.push('execute')
                    assert.strictEqual(authorization, expectedAuthorization)
                  },
                }
              : {}),
            work: async ({ trx, scopeId, payload }, authorization) => {
              calls.push('work')
              assert.strictEqual(authorization, expectedAuthorization)
              const [noteId] = await trx
                .table('notes')
                .insert({ scope_id: scopeId, body: payload.body })
              return { noteId: Number(noteId) }
            },
          }
          const fresh = await execute(client, operation, {
            ...input(1),
            authorization: 'opaque proof',
          })
          assert.deepEqual(fresh, { replayed: false, result: { noteId: 1 } })
          assert.deepEqual(calls, [
            'access',
            ...(parse ? ['parse'] : []),
            ...(authorize ? ['execute'] : []),
            'work',
          ])
          calls.length = 0
          const again = await execute(client, operation, {
            ...input(1),
            authorization: 'invalid on fresh',
          })
          assert.deepEqual(again, { replayed: true, result: fresh.result })
          assert.deepEqual(calls, ['access', ...(replay ? ['replay'] : [])])
          assert.equal(await count(client, 'notes'), 1)
          const [receipt] = await receipts(client)
          assert.equal(receipt.state, 'completed')
        })
      }
    }
  }

  test('required access still refuses commands without optional policies', async ({ assert }) => {
    const { client } = await createDatabase()
    const denied = new Error('Access denied')
    let workRuns = 0
    const operation: Operation<{ body: string }, undefined, null> = {
      name: 'notes.denied',
      authorizeAccess: () => {
        throw denied
      },
      work: () => {
        workRuns++
        return null
      },
    }
    const failure = await execute(client, operation, input(1)).catch((error) => error)
    assert.strictEqual(failure, denied)
    assert.equal(workRuns, 0)
    assert.lengthOf(await receipts(client), 0)
  })
})
