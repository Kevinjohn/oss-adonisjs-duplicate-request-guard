import { test } from '@japa/runner'
import { requestDeduplicator } from '../index.ts'
import { internalHooks } from '../src/receipts.ts'
import {
  addProof,
  countRows,
  createDatabase,
  makeOperationInput as makeBaseCommandInput,
  makeNoteOperation,
  listReceipts,
} from './helpers.ts'

test('a child aborted during reservation never parses authorization and retries fresh', async ({
  assert,
}) => {
  const { client } = await createDatabase()
  for (const sequenceNumber of [1, 2]) await addProof(client, `p${sequenceNumber}`)
  const parent = makeNoteOperation()
  const child = makeNoteOperation()
  child.operation.name = 'notes.child'
  const reserved = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const parentError = new Error('parent failed')
  let childResult: Promise<unknown> = Promise.resolve()
  const makeOperationInput = (sequenceNumber: number) => ({
    ...makeBaseCommandInput(sequenceNumber),
    authorization: { proofToken: `p${sequenceNumber}` },
  })

  const error = await client.transaction(async (trx) => {
    const rawQuery = trx.rawQuery.bind(trx)
    // Keep real SQL; only delay delivery of the child's reservation result to executeIn.
    trx.rawQuery = new Proxy(rawQuery, {
      apply(target, receiver, args) {
        const query = Reflect.apply(target, receiver, args)
        if (args[0].includes('ON CONFLICT') && args[1][3] === '["notes.child","alice"]') {
          return Promise.resolve(query).then(async (result) => {
            reserved.resolve()
            await release.promise
            return result
          })
        }
        return query
      },
    })
    parent.hooks.afterWork = async () => {
      childResult = requestDeduplicator
        .executeIn(trx, child.operation, makeOperationInput(2))
        .catch((failure) => failure)
      await Promise.race([
        reserved.promise,
        childResult.then((outcome) => {
          throw new Error('Child settled before reservation readiness', { cause: outcome })
        }),
      ])
      throw parentError
    }
    internalHooks.onUnwind = () => {
      internalHooks.onUnwind = undefined
      release.resolve()
    }
    try {
      const failure = await requestDeduplicator
        .executeIn(trx, parent.operation, makeOperationInput(1))
        .catch((caught) => caught)
      const childError = await childResult
      assert.equal((childError as { code?: string }).code, 'E_UNAWAITED_NESTED_OPERATION')
      return failure
    } finally {
      trx.rawQuery = rawQuery
      internalHooks.onUnwind = undefined
      release.resolve()
    }
  })

  assert.strictEqual(error, parentError)
  assert.equal((error.cause as { code?: string }).code, 'E_UNAWAITED_NESTED_OPERATION')
  assert.deepEqual(child.calls, { access: 1, parse: 0, execute: 0, work: 0, replay: 0 })
  assert.equal(await countRows(client, 'notes'), 0)
  assert.lengthOf(await listReceipts(client), 0)
  const proofs = await client.from('proofs').orderBy('token')
  assert.deepEqual(
    proofs.map((row) => row.used),
    [0, 0]
  )

  const retry = await client.transaction((trx) =>
    requestDeduplicator.executeIn(trx, child.operation, makeOperationInput(2))
  )
  assert.isFalse(retry.replayed)
  assert.deepEqual(child.calls, { access: 2, parse: 1, execute: 1, work: 1, replay: 0 })
  assert.equal(await countRows(client, 'notes'), 1)
  assert.lengthOf(await listReceipts(client), 1)
})
