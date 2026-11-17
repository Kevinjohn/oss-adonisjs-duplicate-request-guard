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
  demo({ request, response }: HttpContext) {
    const csrfToken = JSON.stringify(request.csrfToken)
    return response.type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Guarded note retry</title></head>
<body>
  <main>
    <h1>Guarded note retry</h1>
    <label for="note-body">Note</label>
    <input id="note-body" value="Remember the meeting">
    <button id="create-note" type="button">Create and retry</button>
    <pre id="result" role="status" aria-live="polite"></pre>
  </main>
  <script>
    const token = ${csrfToken};
    document.getElementById('create-note').addEventListener('click', async () => {
      const commandId = crypto.randomUUID();
      const requestKey = crypto.randomUUID();
      const payload = { body: document.getElementById('note-body').value, commandId, requestKey };
      const send = async () => {
        const response = await fetch('/notes', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-csrf-token': token },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
        return result;
      };
      try {
        const first = await send();
        const replay = await send();
        document.getElementById('result').textContent = JSON.stringify({ first, replay }, null, 2);
      } catch (error) {
        document.getElementById('result').textContent = String(error);
      }
    });
  </script>
</body>
</html>`)
  }

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
