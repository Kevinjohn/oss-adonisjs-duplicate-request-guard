import { AsyncLocalStorage } from 'node:async_hooks'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { DriverConnection } from './connection_watcher.ts'
import { E_CONCURRENT_OPERATION, E_UNAWAITED_NESTED_OPERATION } from './errors.ts'

/** An open operation on a transaction. Its savepoint is on top of the trx's savepoint stack. */
export interface Frame {
  trx: TransactionClientContract
  /** Set when the enclosing operation started unwinding while this one was still open. */
  aborted: boolean
  /** Set once the operation completes, replays or unwinds: from then on it accepts no new child. */
  closing: boolean
  /** Only active nested operations, so a parent can wait for them before rolling back. */
  children: Set<Frame>
  parent?: Frame
  /** The trx's driver connection, known from the operation's first checkpoint on. */
  connection?: DriverConnection
  /** This operation's run, settled before its parent may roll back. */
  run?: Promise<unknown>
  /** The promise a nested `executeIn` returned to its caller, observed once its parent reports it. */
  returned?: Promise<unknown>
}

/**
 * Tracks active operation frames per transaction and carries the current operation through its
 * authorisation callbacks and `work` via AsyncLocalStorage.
 */
export class OperationFrameTracker {
  #operationFrame = new AsyncLocalStorage<Frame>()
  /** Open operations per transaction, outermost first. */
  #openFramesByTransaction = new WeakMap<TransactionClientContract, Frame[]>()

  /**
   * Claims the transaction synchronously, before the first await. Savepoints on one connection are a
   * stack, so an operation may start only when none is open on this trx, or when the innermost open
   * operation is the caller itself (a nested call from its authorisation callbacks or `work`). Anything else (a
   * sibling, a call that lost its async context, a call from an operation that already returned) is
   * refused at once rather than queued, so it can neither corrupt the stack nor wait forever.
   */
  claim(trx: TransactionClientContract): Frame {
    const stack = this.#openFramesByTransaction.get(trx) ?? []
    const caller = this.#operationFrame.getStore()
    const innermost = stack.at(-1)
    if (innermost !== (caller?.trx === trx ? caller : undefined)) {
      throw new E_CONCURRENT_OPERATION()
    }
    // A child that arrives after its parent stopped waiting for children would outlive it; one from an
    // aborted operation would run work that is about to be rolled back.
    if (innermost?.closing || innermost?.aborted) throw new E_UNAWAITED_NESTED_OPERATION()
    const frame: Frame = {
      trx,
      aborted: false,
      closing: false,
      children: new Set(),
      parent: innermost,
    }
    innermost?.children.add(frame)
    stack.push(frame)
    this.#openFramesByTransaction.set(trx, stack)
    return frame
  }

  /** Takes the frame off the stack once its run has settled. */
  release(frame: Frame) {
    // claim() created the stack, and entries are never deleted.
    const stack = this.#openFramesByTransaction.get(frame.trx) as Frame[]
    const index = stack.indexOf(frame)
    if (index !== -1) stack.splice(index, 1)
    frame.parent?.children.delete(frame)
    frame.parent = undefined
  }

  run<T>(frame: Frame, callback: () => Promise<T>) {
    return this.#operationFrame.run(frame, callback)
  }

  isInnermost(frame: Frame) {
    return this.#openFramesByTransaction.get(frame.trx)?.at(-1) === frame
  }
}
