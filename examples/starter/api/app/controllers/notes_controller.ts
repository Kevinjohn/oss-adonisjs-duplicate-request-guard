import db from '@adonisjs/lucid/services/db'
import type { HttpContext } from '@adonisjs/core/http'
import { execute, type Operation } from '@kevinjohn/adonisjs-duplicate-request-guard'

const createNote: Operation<{ body: string }, undefined, { noteId: number }> = {
  name: 'notes.create',
  authorizeAccess: async ({ trx, actorId }) => {
    const user = await trx.from('users').where('id', actorId).first()
    if (!user) throw new Error('User no longer exists')
  },
  work: async ({ trx, actorId, payload }) => {
    const [noteId] = await trx.table('notes').insert({ user_id: actorId, body: payload.body })
    return { noteId }
  },
}

export default class NotesController {
  async store({ auth, request, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const body = request.input('body')
    const commandId = request.input('commandId')
    const requestKey = request.input('requestKey')
    if (
      typeof body !== 'string' ||
      !body.trim() ||
      typeof commandId !== 'string' ||
      !commandId ||
      typeof requestKey !== 'string' ||
      !requestKey
    ) {
      return response.badRequest({ error: 'body, commandId, and requestKey are required strings' })
    }
    const result = await execute(db.connection(), createNote, {
      actorId: String(user.id),
      scopeId: String(user.id),
      payload: { body },
      command: { commandId, requestKey },
    })
    return response.created(result)
  }
}
