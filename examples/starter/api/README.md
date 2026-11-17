# API guarded notes example

This is a standalone AdonisJS starter copied from `adonisjs/starter-kits` at `46d235932e3eb6472a16b740fa0b47b5f69fc6fc` (`api`). It adds `@kevinjohn/adonisjs-duplicate-request-guard` from its v0.1.0 GitHub release archive. The example uses the starter's existing authentication; API requests keep the starter's bearer token default.

## Run

Use Node 24 and pnpm. From this directory:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm exec node ace migration:run
pnpm dev
```

Use a new `APP_KEY` in `.env` before sharing or deploying an app. The database is SQLite in `tmp/db.sqlite3` with one connection, as required by the guard.

## Create a note

Sign up or sign in at `/api/v1/auth/signup` or `/api/v1/auth/login`, then send the returned bearer token in `Authorization: Bearer <token>`.

Send `POST /api/v1/notes` with JSON body:

```json
{ "body": "Remember the meeting", "commandId": "note-42", "requestKey": "attempt-42" }
```

The response is `201` with `{ "replayed": false, "result": { "noteId": 1 } }`. If a response is lost, retry the same body and identifiers. The response then has `replayed: true` and the original `noteId`; the note is not inserted again. Reusing an identifier with a different payload conflicts. Generate unique identifiers per intended write and retain them through retries. The authenticated user supplies the actor and scope; clients cannot choose them.

Run the route-level replay test with `pnpm test`. The test migrates the schema, sends two authenticated requests, and checks one note and one receipt.
