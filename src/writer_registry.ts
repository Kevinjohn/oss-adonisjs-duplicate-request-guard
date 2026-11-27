import { RuntimeException } from '@adonisjs/core/exceptions'

/** A Lucid connection: `client` is its knex instance, unset once the connection is closed. */
export interface LucidConnection {
  name: string
  client?: unknown
  once(event: 'disconnect', listener: () => void): unknown
}

/**
 * Tracks SQLite files by real path and the open Lucid connections that ran operations against them.
 */
export class WriterRegistry {
  #writersByDatabasePath = new Map<string, Set<LucidConnection>>()

  has(file: string) {
    return this.#writersByDatabasePath.has(file)
  }

  register(file: string, connection: LucidConnection) {
    const writers = this.#writersByDatabasePath.get(file) ?? new Set<LucidConnection>()
    // Fallback for a close that never emitted 'disconnect' (for example a listener removed by the host).
    for (const writer of writers) {
      if (writer.client === undefined) writers.delete(writer)
    }
    const other = [...writers].find((writer) => writer !== connection)
    if (other) {
      throw new RuntimeException(
        `SQLite connections "${other.name}" and "${connection.name}" share ${file}; run guarded commands through one connection`
      )
    }
    if (!writers.has(connection)) {
      writers.add(connection)
      // Lucid emits it once the connection's pool is destroyed (manager.close, closeAll, patch).
      connection.once('disconnect', () => this.#release(file, connection))
    }
    this.#writersByDatabasePath.set(file, writers)
  }

  /** Forgets a closed connection, and its file once no open connection uses it. */
  #release(file: string, connection: LucidConnection) {
    // Lucid unsets `client` and emits 'disconnect' in one synchronous step, so the lazy sweep has not
    // removed this connection yet: its set, and so the key, are still here.
    const writers = this.#writersByDatabasePath.get(file) as Set<LucidConnection>
    writers.delete(connection)
    if (writers.size === 0) this.#writersByDatabasePath.delete(file)
  }
}

/** Exported for tests only; not re-exported from the package entry. */
export const writerRegistry = new WriterRegistry()
