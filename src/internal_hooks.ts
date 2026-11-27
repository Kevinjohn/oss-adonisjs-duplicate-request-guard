/**
 * Test-only seams, not exported from the package entry: `onClosing` runs when an operation starts to
 * complete or replay, `onUnwind` once an unwinding operation has taken its list of children.
 */
export class InternalHooks {
  #onClosing?: () => void
  #onUnwind?: () => void

  set onClosing(hook: (() => void) | undefined) {
    this.#onClosing = hook
  }

  set onUnwind(hook: (() => void) | undefined) {
    this.#onUnwind = hook
  }

  emitClosing() {
    this.#onClosing?.()
  }

  emitUnwind() {
    this.#onUnwind?.()
  }
}

export const internalHooks = new InternalHooks()
