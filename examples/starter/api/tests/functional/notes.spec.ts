import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'

test.group('guarded notes', (group) => {
  group.each.setup(() => testUtils.db().migrate())

  test('the same command returns its first note and writes one row', async ({ assert, client }) => {
    const user = await User.create({ email: 'notes@example.test', password: 'secret-password' })
    const input = { body: 'Remember the meeting', commandId: 'notes-1', requestKey: 'attempt-1' }
    const first = await client.post('/api/v1/notes').withGuard('api').loginAs(user).json(input)
    const replay = await client.post('/api/v1/notes').withGuard('api').loginAs(user).json(input)
    first.assertStatus(201)
    replay.assertStatus(201)
    assert.deepEqual(first.body(), { replayed: false, result: { noteId: 1 } })
    assert.deepEqual(replay.body(), { replayed: true, result: first.body().result })
    assert.deepEqual(await db.from('notes').select('body'), [{ body: input.body }])
    const receipts = await db.from('request_receipts').count('* as total')
    assert.equal(receipts[0].total, 1)
  })
})
