/** The slice of better-sqlite3 the tests use directly; the package itself only talks to Lucid. */
declare module 'better-sqlite3' {
  interface Statement {
    run(...params: unknown[]): { changes: number }
    get(...params: unknown[]): unknown
  }
  export default class Database {
    constructor(filename: string, options?: { timeout?: number; readonly?: boolean })
    prepare(sql: string): Statement
    exec(sql: string): this
    close(): void
  }
}
