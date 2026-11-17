import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'

test.group('guarded notes', (group) => {
  group.each.setup(() => testUtils.db().migrate())

  test('the same command returns its first note and writes one row', async ({ assert, client }) => {
    const user = await User.create({ email: 'notes@example.test', password: 'secret-password' })
    const demo = await client.get('/notes/demo').withGuard('web').loginAs(user)
    demo.assertStatus(200)
    assert.include(demo.text(), "fetch('/notes'")
    assert.match(demo.text(), /const token = "[^"]+";/)
    const input = { body: 'Remember the meeting', commandId: 'notes-1', requestKey: 'attempt-1' }
    const first = await client
      .post('/notes')
      .withGuard('web')
      .loginAs(user)
      .withCsrfToken()
      .json(input)
    const replay = await client
      .post('/notes')
      .withGuard('web')
      .loginAs(user)
      .withCsrfToken()
      .json(input)
    first.assertStatus(201)
    replay.assertStatus(201)
    assert.equal(first.body().replayed, false)
    assert.isAbove(first.body().result.noteId, 0)
    assert.deepEqual(replay.body(), { replayed: true, result: first.body().result })
    const notes = await db.from('notes').select('id', 'user_id', 'body')
    assert.deepEqual(notes, [
      { id: first.body().result.noteId, user_id: user.id, body: input.body },
    ])
    const receipts = await db.from('request_receipts').count('* as total')
    assert.equal(receipts[0].total, 1)
  })
})
