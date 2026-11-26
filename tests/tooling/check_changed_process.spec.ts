import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { test } from '@japa/runner'
import {
  collectExit,
  isGone,
  captureChildOutput,
  waitForFile,
  waitForPid,
} from './child_process.ts'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runnerPath = path.join(repoRoot, 'bin/check_changed.ts')
const plannerPath = path.join(repoRoot, 'bin/check_changed_plan.ts')

type FixtureOptions = {
  command?: 'normal' | 'hang' | 'missing'
  hook?: 'record-term' | 'fail-reap'
}

type Fixture = {
  directory: string
  root: string
  bin: string
  log: string
  ready: string
  termSent: string
  base: string
  env: NodeJS.ProcessEnv
  /** Runners this fixture launched; teardown kills any still running. */
  children: ChildProcess[]
}

/** Kill what a test launched, then remove its directory, whatever state the test reached. */
async function teardown(fixture: Fixture): Promise<void> {
  const text = await readFile(fixture.ready, 'utf8').catch(() => '')
  const pid = Number(text.trim())
  if (pid > 0) {
    try {
      const group = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString())
      if (group > 1) process.kill(-group, 'SIGKILL')
    } catch {}
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  for (const child of fixture.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await rm(fixture.directory, { recursive: true, force: true })
}

async function makeCheckProcessFixture(
  cleanup: (callback: () => Promise<void>) => void,
  options: FixtureOptions = {}
): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'duplicate-request-guard-check-changed-'))
  const root = path.join(directory, 'checkout')
  const bin = path.join(directory, 'bin')
  const supportBin = path.join(directory, 'support-bin')
  await mkdir(path.join(root, 'bin'), { recursive: true })
  await mkdir(bin)
  await mkdir(supportBin)
  await writeFile(path.join(root, 'bin/check_changed.ts'), await readFile(runnerPath))
  await writeFile(path.join(root, 'bin/check_changed_plan.ts'), await readFile(plannerPath))
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(path.join(root, 'README.md'), 'fixture baseline\n')
  await symlink(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir')

  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  await symlink(git, path.join(supportBin, 'git'))
  const runGit = (args: string[]) => execFileSync(git, args, { cwd: root, stdio: 'ignore' })
  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'fixture@example.test'])
  runGit(['config', 'user.name', 'Fixture'])
  runGit(['add', '.'])
  runGit(['commit', '-qm', 'fixture baseline'])
  const base = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  await writeFile(path.join(root, 'src-trigger.ts'), 'export const changed = true\n')
  runGit(['add', 'src-trigger.ts'])
  runGit(['commit', '-qm', 'select static checks'])
  const log = path.join(directory, 'commands.log')
  const ready = path.join(directory, 'descendant.pid')
  const termSent = path.join(directory, 'term-sent')
  await writeFile(log, '')

  await writeFile(
    path.join(root, 'worker.js'),
    `import { rename, writeFile } from 'node:fs/promises'\nprocess.on('SIGTERM', () => {})\nawait writeFile(${JSON.stringify(ready + '.tmp')}, String(process.pid))\nawait rename(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)})\nsetInterval(() => {}, 1000)\n`
  )
  if (options.command !== 'missing') {
    const commandPath = path.join(bin, 'pnpm')
    await writeFile(
      commandPath,
      `#!${process.execPath}\nimport { spawn } from 'node:child_process'\nimport { readFile, writeFile } from 'node:fs/promises'\nconst args = process.argv.slice(2)\nawait writeFile(${JSON.stringify(log)}, (await readFile(${JSON.stringify(log)}, 'utf8')) + args.join(' ') + '\\n')\nif (process.env.CHECK_CHANGED_HANG === '1') {\n  spawn(process.execPath, ['worker.js'], { cwd: process.cwd(), stdio: 'ignore' })\n  for (let attempt = 0; attempt < 250; attempt++) {\n    if (await readFile(${JSON.stringify(ready)}, 'utf8').catch(() => '')) break\n    await new Promise((resolve) => setTimeout(resolve, 20))\n  }\n  setInterval(() => {}, 1000)\n}\n`,
      { mode: 0o755 }
    )
  }

  if (options.hook) {
    const hookPath = path.join(directory, 'process-hook.cjs')
    const recordTerm = options.hook === 'record-term'
    await writeFile(
      hookPath,
      `const original = process.kill.bind(process)\nlet killedGroup = null\nprocess.kill = (pid, signal) => {\n  if (pid < 0 && signal === 'SIGTERM') require('node:fs').writeFileSync(${JSON.stringify(termSent)}, 'yes')\n  if (pid < 0 && signal === 'SIGKILL') { killedGroup = pid; return original(pid, signal) }\n  if (${recordTerm ? 'false' : 'true'} && pid === killedGroup && signal === 0) return true\n  return original(pid, signal)\n}\n`
    )
  }

  await chmod(directory, 0o755)
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${supportBin}`,
  }
  delete environment.CHECK_CHANGED_HANG
  if (options.command === 'hang') environment.CHECK_CHANGED_HANG = '1'
  if (options.hook) {
    environment.NODE_OPTIONS =
      `${environment.NODE_OPTIONS ?? ''} --require=${path.join(directory, 'process-hook.cjs')}`.trim()
  }
  const fixture: Fixture = {
    directory,
    root,
    bin,
    log,
    ready,
    termSent,
    base,
    env: environment,
    children: [],
  }
  cleanup(() => teardown(fixture))
  return fixture
}

function launch(fixture: Fixture): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      '--import=@poppinss/ts-exec',
      path.join(fixture.root, 'bin/check_changed.ts'),
      '--static',
      fixture.base,
    ],
    { cwd: fixture.root, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  fixture.children.push(child)
  return child
}

test('runs selected static checks normally and observes a missing command spawn error', async ({
  cleanup,
}) => {
  const normal = await makeCheckProcessFixture(cleanup)
  const normalChild = launch(normal)
  const normalOutput = await captureChildOutput(normalChild)
  const normalResult = await collectExit(normalChild, normalOutput)
  assert.equal(normalResult.code, 0, normalResult.text)
  assert.match(normalResult.text, /pass format/)
  assert.match(await readFile(normal.log, 'utf8'), /exec prettier --check/)

  const missing = await makeCheckProcessFixture(cleanup, { command: 'missing' })
  const missingChild = launch(missing)
  const missingOutput = await captureChildOutput(missingChild)
  const missingResult = await collectExit(missingChild, missingOutput)
  assert.equal(missingResult.code, 1, missingResult.text)
  assert.match(missingResult.text, /spawn failed: spawn pnpm ENOENT/)
  assert.doesNotMatch(missingResult.text, /UnhandledPromiseRejection|unhandledRejection/)
}).timeout(30_000)

test('TERM-resistant descendants receive KILL, are reaped, and block later selected checks', async ({
  cleanup,
}) => {
  const fixture = await makeCheckProcessFixture(cleanup, { command: 'hang' })
  const child = launch(fixture)
  const output = await captureChildOutput(child)
  const descendantPid = await waitForPid(fixture.ready)
  child.kill('SIGTERM')
  const result = await collectExit(child, output)
  assert.equal(result.code, 143, result.text)
  assert.match(result.text, /fail format \(exit killed\)/)
  assert.doesNotMatch(await readFile(fixture.log, 'utf8'), /^(lint|typecheck)$/m)
  assert.equal(await isGone(descendantPid), true)
  assert.doesNotMatch(result.text, /UnhandledPromiseRejection|unhandledRejection/)
}).timeout(20_000)

test('a second signal escalates immediately while the first signal determines the exit code', async ({
  cleanup,
}) => {
  const fixture = await makeCheckProcessFixture(cleanup, { command: 'hang', hook: 'record-term' })
  const child = launch(fixture)
  const output = await captureChildOutput(child)
  const descendantPid = await waitForPid(fixture.ready)
  child.kill('SIGTERM')
  await waitForFile(fixture.termSent)
  const secondSignalAt = Date.now()
  child.kill('SIGINT')
  const result = await collectExit(child, output)
  // Without escalation the first signal's own SIGKILL only arrives after the 5s grace period.
  const elapsed = Date.now() - secondSignalAt
  assert.ok(elapsed < 3000, `exit took ${elapsed}ms after the second signal`)
  assert.equal(result.code, 143, result.text)
  assert.equal(await isGone(descendantPid), true)
  assert.doesNotMatch(await readFile(fixture.log, 'utf8'), /^(lint|typecheck)$/m)
}).timeout(15_000)

test('reports failed final reap and retains the first signal result', async ({ cleanup }) => {
  const fixture = await makeCheckProcessFixture(cleanup, { command: 'hang', hook: 'fail-reap' })
  const child = launch(fixture)
  const output = await captureChildOutput(child)
  await waitForPid(fixture.ready)
  child.kill('SIGTERM')
  const result = await collectExit(child, output)
  assert.equal(result.code, 143, result.text)
  assert.match(result.text, /cleanup failed:.*did not exit after SIGKILL/s)
  assert.doesNotMatch(await readFile(fixture.log, 'utf8'), /^(lint|typecheck)$/m)
  assert.doesNotMatch(result.text, /UnhandledPromiseRejection|unhandledRejection/)
}).timeout(20_000)

test('interrupt settles a never-closing owned child and releases its live local handles', async ({
  cleanup,
}) => {
  const fixture = await makeCheckProcessFixture(cleanup)
  const hook = path.join(fixture.directory, 'never-close.cjs')
  await writeFile(
    hook,
    `
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
cp.spawn = () => {
 const child = new EventEmitter(); child.pid = 99999999; child.exitCode = child.signalCode = null
 child.stdout = new PassThrough(); child.stderr = new PassThrough()
 const liveHandle = setInterval(() => {}, 1000)
 child.unref = () => { clearInterval(liveHandle); console.log('LOCAL_HANDLE_RELEASED') }
 setImmediate(() => { child.stdout.write('partial output'); process.emit('SIGTERM') })
 return child
}
process.kill = () => true
let clock = 0; Date.now = () => (clock += 6000)
require('node:module').syncBuiltinESMExports()
`
  )
  fixture.env.NODE_OPTIONS = `${fixture.env.NODE_OPTIONS ?? ''} --require=${hook}`
  const child = launch(fixture)
  const output = await captureChildOutput(child)
  const result = await collectExit(child, output)
  assert.equal(result.code, 143, result.text)
  assert.match(result.text, /did not exit after SIGKILL/)
  assert.match(result.text, /partial output/)
  assert.match(result.text, /LOCAL_HANDLE_RELEASED/)
  assert.equal(await readFile(fixture.log, 'utf8'), '')
}).timeout(10_000)

test('a timed-out child that never closes still settles with a timeout failure', async ({
  cleanup,
}) => {
  const fixture = await makeCheckProcessFixture(cleanup)
  const hook = path.join(fixture.directory, 'timeout-never-close.cjs')
  await writeFile(
    hook,
    `
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
cp.spawn = () => {
 const child = new EventEmitter(); child.pid = 99999999; child.exitCode = child.signalCode = null
 child.stdout = new PassThrough(); child.stderr = new PassThrough()
 const liveHandle = setInterval(() => {}, 1000)
 child.unref = () => { clearInterval(liveHandle); console.log('LOCAL_HANDLE_RELEASED') }
 setImmediate(() => child.stdout.write('partial output'))
 return child
}
process.kill = () => true
// Deliver the step timeout and advance the clock past the cleanup deadline.
let clock = 0; Date.now = () => (clock += 6000)
const realSetTimeout = global.setTimeout
global.setTimeout = (callback, delay, ...rest) => realSetTimeout(callback, delay >= 5000 ? 5 : delay, ...rest)
require('node:module').syncBuiltinESMExports()
`
  )
  fixture.env.NODE_OPTIONS = `${fixture.env.NODE_OPTIONS ?? ''} --require=${hook}`
  const child = launch(fixture)
  const output = await captureChildOutput(child)
  const result = await collectExit(child, output)
  assert.equal(result.code, 1, result.text)
  assert.match(result.text, /fail format \(exit killed\)/)
  assert.match(result.text, /stopped after 15 minutes/)
  assert.match(result.text, /cleanup failed:.*did not exit after SIGKILL/s)
  assert.match(result.text, /partial output/)
  assert.match(result.text, /LOCAL_HANDLE_RELEASED/)
  assert.equal(await readFile(fixture.log, 'utf8'), '')
}).timeout(10_000)

for (const groupExits of [true, false]) {
  test(`timeout waits for group cleanup after the child closes (group exits: ${groupExits})`, async ({
    cleanup,
  }) => {
    const fixture = await makeCheckProcessFixture(cleanup)
    const hook = path.join(fixture.directory, 'timeout-close-hook.cjs')
    await writeFile(
      hook,
      `
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const originalTimeout = global.setTimeout
const originalInterval = global.setInterval
const originalSpawn = cp.spawn
const now = Date.now
let child
let groupProbes = 0
let groupExitConfirmed = false
let timeoutArmed = false
global.setTimeout = (callback, ms, ...args) => {
  if (ms === 900000 && !timeoutArmed) {
    timeoutArmed = true
    return originalTimeout(callback, 0, ...args)
  }
  return originalTimeout(callback, ms, ...args)
}
global.setInterval = (callback, ms, ...args) => ms === 40
  ? originalInterval(() => {
      if (!${groupExits}) Date.now = () => now() + 6000
      try { callback() } finally { Date.now = now }
    }, ms, ...args)
  : originalInterval(callback, ms, ...args)
cp.spawn = (...args) => {
  if (child) {
    console.log(groupExitConfirmed ? 'LATER_STEP_AFTER_GROUP_EXIT' : 'LATER_STEP_BEFORE_GROUP_EXIT')
    return originalSpawn(...args)
  }
  child = new EventEmitter()
  child.pid = 99999999
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.unref = () => {}
  return child
}
process.kill = (_pid, signal) => {
  if (signal === 'SIGKILL') { child.emit('close', null, 'SIGKILL'); return true }
  if (signal === 0) {
    groupProbes++
    console.log('GROUP_CHECKED')
    if (!${groupExits} || groupProbes === 1) return true
    groupExitConfirmed = true
    console.log('GROUP_EXIT_CONFIRMED')
    const error = new Error('gone'); error.code = 'ESRCH'; throw error
  }
  throw new Error('unexpected signal: ' + signal)
}
require('node:module').syncBuiltinESMExports()
`
    )
    fixture.env.NODE_OPTIONS = `--require=${hook}`
    const child = launch(fixture)
    const result = await collectExit(child, await captureChildOutput(child))
    assert.equal(result.code, 1, result.text)
    assert.match(result.text, /fail format \(exit killed\)/)
    assert.match(result.text, /GROUP_CHECKED/)
    assert.doesNotMatch(result.text, /LATER_STEP_BEFORE_GROUP_EXIT/)
    if (groupExits) {
      assert.match(
        result.text,
        /GROUP_CHECKED[\s\S]*GROUP_EXIT_CONFIRMED[\s\S]*LATER_STEP_AFTER_GROUP_EXIT/
      )
      assert.match(result.text, /pass lint/)
    } else {
      assert.match(
        result.text,
        /cleanup failed: The owned process group did not exit after SIGKILL/
      )
      assert.doesNotMatch(result.text, /LATER_STEP_AFTER_GROUP_EXIT/)
      assert.equal(await readFile(fixture.log, 'utf8'), '')
    }
  }).timeout(10_000)
}
