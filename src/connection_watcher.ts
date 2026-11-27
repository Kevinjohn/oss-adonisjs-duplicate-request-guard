import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'

/** The driver connection a transaction is bound to: better-sqlite3's Database. */
export interface DriverConnection {
  inTransaction?: boolean
}

/** The knex client behind a Lucid connection: its pool and its query events. */
interface KnexClient {
  pool: { on(event: string, listener: (...args: any[]) => void): void }
  on(event: 'query' | 'query-error' | 'query-response', listener: () => void): void
}

/**
 * Watched knex clients → the connection their single-connection pool last handed out, and whether
 * a statement has started inside a transaction since.
 */
type Watch = { current?: DriverConnection; didStartTransactionQuery?: boolean }

/** Query and transaction clients share the dialect, which holds the query client and its connection. */
function requireKnexClient(client: QueryClientContract | TransactionClientContract) {
  return (
    client.dialect as unknown as { client: { connection: { client: { client: KnexClient } } } }
  ).client.connection.client.client
}

/** A knex transaction always resolves its own bound connection. */
export function acquireBoundDriverConnection(trx: TransactionClientContract) {
  return (
    trx.knexClient as unknown as { client: { acquireConnection(): Promise<DriverConnection> } }
  ).client.acquireConnection()
}

/**
 * Watches connections for transactions ended underneath Lucid (`INSERT OR ROLLBACK`, a busy abort)
 * and tracks which driver connections are lost until the pool hands them to their next owner.
 */
export class ConnectionWatcher {
  /**
   * Connections whose transaction SQLite ended underneath its Lucid client (`INSERT OR ROLLBACK`, a
   * busy abort). The client, and every child transaction made from it, still reports a transaction,
   * but statements now autocommit and a new savepoint is outermost, so its release commits. The mark
   * is on the connection because all of those clients share it, and it lasts until the pool
   * hands the connection to its next owner.
   */
  #lostConnections = new WeakSet<DriverConnection>()
  #watchesByKnexClient = new WeakMap<KnexClient, Watch>()

  /**
   * Watches a connection from its first deduplicated use (or a host's `assertSupportedConnection` at boot).
   * A statement inside a transaction that leaves the driver with no open transaction is the moment
   * the transaction ended, whoever issued it; without this, a child transaction opened next would
   * reopen a transaction that looks healthy. The pool handing the connection out again clears the mark.
   */
  watch(client: QueryClientContract | TransactionClientContract) {
    const knexClient = requireKnexClient(client)
    if (this.#watchesByKnexClient.has(knexClient)) return
    const state: Watch = {}
    this.#watchesByKnexClient.set(knexClient, state)
    // A connection the pool hands out carries no transaction from its previous owner.
    knexClient.pool.on('acquireSuccess', (_id: unknown, connection: DriverConnection) => {
      state.current = connection
      state.didStartTransactionQuery = false
      this.#lostConnections.delete(connection)
    })
    // Only a statement that started inside a transaction can lose one: knex runs its own statements
    // on the connection before BEGIN (`enforceForeignCheck` reads PRAGMA foreign_keys there).
    knexClient.on('query', () => {
      if (state.current?.inTransaction) state.didStartTransactionQuery = true
    })
    // After any statement, failed or not (a raw COMMIT or ROLLBACK from the host succeeds). After
    // the owner's own final COMMIT this also fires, harmlessly: the next acquire clears the mark.
    const markLostTransaction = () => {
      if (state.didStartTransactionQuery && state.current?.inTransaction === false)
        this.#lostConnections.add(state.current)
    }
    knexClient.on('query-error', markLostTransaction)
    knexClient.on('query-response', markLostTransaction)
  }

  trackBoundConnection(trx: TransactionClientContract, connection: DriverConnection) {
    // The watcher may have been installed after the pool handed this connection out.
    this.#watchesByKnexClient.get(requireKnexClient(trx))!.current = connection
    if (connection.inTransaction !== true) this.#lostConnections.add(connection)
  }

  isLost(connection: DriverConnection) {
    return this.#lostConnections.has(connection)
  }
}
