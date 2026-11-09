import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  executedTests,
  planChangedChecks,
  type ChangedCheckStep,
  type ChangedFile,
} from './check_changed_plan.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const stepLimitMs = 15 * 60 * 1000
const termGraceMs = 5000
const reapGraceMs = 5000
let active: ChildProcess | undefined
let interruptedBy: NodeJS.Signals | undefined
let interruptionCleanup: Promise<void> | undefined
const signalErrors: unknown[] = []
let abandonActive: ((error: unknown) => void) | undefined

function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...[...error.errors].map(describeError)].join('\n')
  }
  return error instanceof Error ? error.message : String(error)
}

function groupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    if (code === 'ESRCH') return false
    throw error
  }
}

function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return
  }
  if (child.exitCode === null && child.signalCode === null && !child.kill(signal)) {
    throw new Error(`Could not send ${signal} to the owned child process.`)
  }
}

function waitForOwnedProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = setInterval(() => {
      try {
        const exists =
          process.platform !== 'win32' && child.pid
            ? groupExists(child.pid)
            : child.exitCode === null && child.signalCode === null
        if (!exists) {
          clearInterval(poll)
          resolve(true)
        } else if (Date.now() >= deadline) {
          clearInterval(poll)
          resolve(false)
        }
      } catch (error) {
        clearInterval(poll)
        reject(error)
      }
    }, 40)
  })
}

async function terminateOwnedProcess(child: ChildProcess): Promise<void> {
  const failures: unknown[] = []
  try {
    signalOwnedProcess(child, 'SIGTERM')
  } catch (error) {
    failures.push(error)
  }

  let stopped = false
  try {
    stopped = await waitForOwnedProcessExit(child, termGraceMs)
  } catch (error) {
    failures.push(error)
  }
  if (!stopped) {
    try {
      signalOwnedProcess(child, 'SIGKILL')
    } catch (error) {
      failures.push(error)
    }
    try {
      stopped = await waitForOwnedProcessExit(child, reapGraceMs)
    } catch (error) {
      failures.push(error)
    }
    if (!stopped) failures.push(new Error('The owned process group did not exit after SIGKILL.'))
  }
  if (failures.length)
    throw new AggregateError(failures, 'Could not clean up the owned process group.')
}

function interrupt(signal: NodeJS.Signals): void {
  if (!interruptedBy) {
    interruptedBy = signal
    const child = active
    interruptionCleanup = child ? terminateOwnedProcess(child) : Promise.resolve()
    void interruptionCleanup.catch((error) => abandonActive?.(error))
    return
  }

  const child = active
  if (!child) return
  try {
    signalOwnedProcess(child, 'SIGKILL')
  } catch (error) {
    signalErrors.push(error)
  }
}

// Keep the first signal's exit code while cleanup observes the owned process group.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => interrupt(signal))
}

function misuse(message: string): never {
  console.error(`[check:changed] ${message}`)
  process.exit(2)
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) misuse(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

function changedFiles(base: string): ChangedFile[] {
  const mergeBase = git(['merge-base', base, 'HEAD']).trim()
  const tracked = git(['diff', '--name-status', '--no-renames', '-z', mergeBase]).split('\0')
  const changes: ChangedFile[] = []
  for (let index = 0; index + 1 < tracked.length; index += 2) {
    changes.push({ path: tracked[index + 1], deleted: tracked[index] === 'D' })
  }
  for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (path) changes.push({ path, deleted: false })
  }
  return changes
}

/** Run one step in its own process group so an interrupt can stop descendants too. */
function run(
  step: ChangedCheckStep
): Promise<{ status: number | null; output: string; cleanupError?: unknown }> {
  return new Promise((resolve) => {
    const child = spawn(step.command[0], step.command.slice(1), {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    active = child
    let output = ''
    let spawnError: Error | undefined
    let timedOut = false
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => {
      timedOut = true
      output += `\n[check:changed] stopped after ${stepLimitMs / 60000} minutes\n`
      try {
        signalOwnedProcess(child, 'SIGKILL')
      } catch (error) {
        output += `[check:changed] timeout cleanup failed: ${describeError(error)}\n`
      }
    }, stepLimitMs)
    child.once('error', (error) => {
      spawnError = error
    })
    let settled = false
    abandonActive = (error) => {
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      void finish(null, null, error)
    }
    const finish = async (
      status: number | null,
      signal: NodeJS.Signals | null,
      terminalError?: unknown
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let cleanupError: unknown = terminalError
      if (interruptedBy && interruptionCleanup) {
        try {
          await interruptionCleanup
        } catch (error) {
          cleanupError = error
        }
      }
      if (active === child) active = undefined
      abandonActive = undefined
      if (spawnError) output += `\n[check:changed] spawn failed: ${spawnError.message}\n`
      if (cleanupError !== undefined) {
        output += `\n[check:changed] cleanup failed: ${describeError(cleanupError)}\n`
      }
      resolve({ status: timedOut || signal ? null : status, output, cleanupError })
    }
    child.once('close', (status, signal) => void finish(status, signal))
  })
}

const flags = process.argv.slice(2).filter((arg) => arg.startsWith('-'))
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
if (args.length > 1 || flags.some((flag) => flag !== '--static'))
  misuse('Use pnpm check:changed [--static] [base]')
if (Number(process.versions.node.split('.')[0]) !== 24) {
  misuse(`Use Node 24 (found ${process.version}); run nvm use`)
}
const base = args[0] ?? 'origin/main'
if (
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: root }).status
)
  misuse(`Unknown base ref ${base}`)

const changes = changedFiles(base)
console.log(`[check:changed] ${changes.length} changed files since the merge-base with ${base}`)
let failed = false
for (const step of planChangedChecks(changes, { static: flags.includes('--static') })) {
  if (interruptedBy) break
  if ('skip' in step) {
    console.log(`skip ${step.label} (${step.skip})`)
    continue
  }
  const before = step.requiresCleanTree ? git(['status', '--porcelain']) : ''
  const { status, output } = await run(step)
  const tests = step.countsTests ? executedTests(output) : undefined
  const problem =
    status !== 0
      ? `exit ${status ?? 'killed'}`
      : interruptedBy
        ? `interrupted by ${interruptedBy}`
        : step.requiresTests && tests === 0
          ? 'no tests executed'
          : step.requiresCleanTree && git(['status', '--porcelain']) !== before
            ? 'left the worktree dirty'
            : undefined
  if (problem) {
    failed = true
    console.log(`fail ${step.label} (${problem}): ${step.command.join(' ')}`)
    console.log(output.trimEnd().split('\n').slice(-40).join('\n'))
  } else {
    console.log(`pass ${step.label}${tests === undefined ? '' : ` (${tests} tests)`}`)
  }
}
for (const error of signalErrors) {
  failed = true
  console.error(`[check:changed] signal escalation failed: ${describeError(error)}`)
}
if (interruptedBy && interruptionCleanup) {
  try {
    await interruptionCleanup
  } catch (error) {
    failed = true
    console.error(`[check:changed] cleanup failed: ${describeError(error)}`)
  }
}
process.exitCode =
  interruptedBy === 'SIGINT' ? 130 : interruptedBy === 'SIGTERM' ? 143 : failed ? 1 : 0
