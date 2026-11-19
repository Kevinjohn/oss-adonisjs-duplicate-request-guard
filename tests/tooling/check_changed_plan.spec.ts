import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import {
  countExecutedTests,
  planChangedChecks,
  type ChangedFile,
  type PlannedCheckStep,
} from '../../bin/check_changed_plan.js'

const packageJson = new URL('../../package.json', import.meta.url)
const makeChangedPaths = (...paths: string[]): ChangedFile[] =>
  paths.map((path) => ({ path, deleted: false }))

function listRunnableSteps(plan: PlannedCheckStep[]): Record<string, string[]> {
  return Object.fromEntries(
    plan.flatMap((step) => ('command' in step ? [[step.label, step.command]] : []))
  )
}

test('a changed spec runs on its own and requires executed tests', ({ assert }) => {
  const plan = planChangedChecks(makeChangedPaths('tests/execute.spec.ts'))
  const tests = plan.find((step) => step.label === 'tests')

  assert.deepEqual(Object.keys(listRunnableSteps(plan)), ['format', 'lint', 'typecheck', 'tests'])
  assert.deepInclude(tests, {
    command: ['pnpm', 'quick:test', '--files=tests/execute.spec.ts'],
    countsTests: true,
    requiresTests: true,
  })
})

test('package source and manifests run the suite and the build', ({ assert }) => {
  for (const path of ['src/receipts.ts', 'package.json', 'pnpm-lock.yaml']) {
    const commands = listRunnableSteps(
      planChangedChecks(makeChangedPaths(path, 'tests/execute.spec.ts'))
    )
    assert.deepEqual(commands.tests, ['pnpm', 'quick:test'], path)
    assert.deepEqual(commands.build, ['pnpm', 'build'], path)
  }
})

test('files the specs read run the full suite without building the package', ({ assert }) => {
  for (const path of ['tests/helpers.ts', 'CHANGELOG.md', '.github/workflows/checks.yml']) {
    const commands = listRunnableSteps(planChangedChecks(makeChangedPaths(path)))
    assert.deepEqual(commands.tests, ['pnpm', 'quick:test'], path)
    assert.notProperty(commands, 'build', path)
  }
})

test('a story edit is formatted and tested without building the package', ({ assert }) => {
  const commands = listRunnableSteps(
    planChangedChecks(makeChangedPaths('user-stories/nested/REFERENCE.md'))
  )

  assert.deepEqual(commands.format.slice(-2), ['--', 'user-stories/nested/REFERENCE.md'])
  assert.deepEqual(commands.tests, ['pnpm', 'quick:test'])
  assert.notProperty(commands, 'build')
})

test('lockfile and workspace changes run lint and typecheck', ({ assert }) => {
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    assert.properties(
      listRunnableSteps(planChangedChecks(makeChangedPaths(path))),
      ['lint', 'typecheck'],
      path
    )
  }
})

test('deleted files select checks but are never passed to tools', ({ assert }) => {
  const commands = listRunnableSteps(
    planChangedChecks([
      { path: 'src/old_module.ts', deleted: true },
      { path: 'tests/old_module.spec.ts', deleted: true },
    ])
  )

  assert.notProperty(commands, 'format')
  assert.deepEqual(commands.typecheck, ['pnpm', 'typecheck'])
  assert.deepEqual(commands.tests, ['pnpm', 'quick:test'])
  assert.notInclude(commands.lint.join(' '), 'old_module')
  assert.deepEqual(
    listRunnableSteps(planChangedChecks([{ path: 'tests/old_module.spec.ts', deleted: true }]))
      .tests,
    ['pnpm', 'quick:test']
  )
})

test('formats only existing files and leaves the lockfile to pnpm', ({ assert }) => {
  const commands = listRunnableSteps(
    planChangedChecks(makeChangedPaths('README.md', 'pnpm-lock.yaml'))
  )

  assert.deepEqual(commands.format.slice(-2), ['--', 'README.md'])
  assert.include(commands.format, '--ignore-unknown')
  assert.include(commands.format, '--no-error-on-unmatched-pattern')
})

test('changed paths follow an end-of-options marker so a dashed name is a file', ({ assert }) => {
  const { format } = listRunnableSteps(planChangedChecks(makeChangedPaths('-h.md', '--write.md')))

  assert.deepEqual(format.slice(-3), ['--', '-h.md', '--write.md'])
})

test('the real formatter checks dashed filenames as files', async ({ assert, cleanup }) => {
  const directory = await mkdtemp(join(os.tmpdir(), 'duplicate-request-guard-prettier-'))
  cleanup(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, '-h.md'), 'a  b\n')
  await writeFile(join(directory, '--write.md'), 'ok\n')
  const prettier = fileURLToPath(new URL('../../node_modules/.bin/prettier', import.meta.url))
  const { format } = listRunnableSteps(planChangedChecks(makeChangedPaths('-h.md', '--write.md')))
  // Colour off: CI forces it on, and a coloured "[warn]" would not match.
  const result = spawnSync(prettier, format.slice(3), {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })

  assert.equal(result.status, 1, result.stderr)
  assert.include(result.stderr, '[warn] -h.md')
  assert.notInclude(result.stderr, '--write.md')
  assert.equal(await readFile(join(directory, '-h.md'), 'utf8'), 'a  b\n')
})

test('formatter configuration checks the whole tree', ({ assert }) => {
  for (const path of ['.prettierignore', '.editorconfig', 'package.json'])
    assert.deepEqual(
      listRunnableSteps(planChangedChecks(makeChangedPaths(path))).format,
      ['pnpm', 'format:check'],
      path
    )
})

test('lint allows no warnings and skips files ESLint ignores', async ({ assert }) => {
  assert.deepEqual(listRunnableSteps(planChangedChecks(makeChangedPaths('index.ts'))).lint, [
    'pnpm',
    'lint',
  ])
  // The repository's own lint script carries the zero-warning limit for every caller.
  const manifest = JSON.parse(await readFile(packageJson, 'utf8'))
  assert.include(manifest.scripts.lint, '--max-warnings 0')
  assert.notProperty(listRunnableSteps(planChangedChecks(makeChangedPaths('stubs/x.ts'))), 'lint')
})

test('--static names each selected suite in a skip line instead of running it', ({ assert }) => {
  const plan = planChangedChecks(makeChangedPaths('src/receipts.ts', 'package.json', 'README.md'), {
    static: true,
  })

  assert.deepEqual(Object.keys(listRunnableSteps(plan)), ['format', 'lint', 'typecheck'])
  for (const [label, skip] of [
    ['test suite', '--static leaves out pnpm quick:test'],
    ['build', '--static leaves out pnpm build'],
  ])
    assert.deepInclude(plan, { label, skip })
})

test('--static still runs the changed specs on their own', ({ assert }) => {
  const plan = planChangedChecks(makeChangedPaths('src/receipts.ts', 'tests/execute.spec.ts'), {
    static: true,
  })

  assert.deepEqual(listRunnableSteps(plan).tests, [
    'pnpm',
    'quick:test',
    '--files=tests/execute.spec.ts',
  ])
  assert.deepInclude(plan, { label: 'test suite', skip: '--static leaves out pnpm quick:test' })
  assert.deepInclude(planChangedChecks(makeChangedPaths('src/receipts.ts'), { static: true }), {
    label: 'tests',
    skip: 'no test files changed',
  })
})

test('--static plans a spec-only change exactly as the default does', ({ assert }) => {
  assert.deepEqual(
    planChangedChecks(makeChangedPaths('tests/execute.spec.ts'), { static: true }),
    planChangedChecks(makeChangedPaths('tests/execute.spec.ts'))
  )
})

test('counts executed tests from the Japa summary', ({ assert }) => {
  assert.equal(countExecutedTests('\u001b[2mTests\u001b[22m  335 passed, 2 skipped (337)'), 335)
  assert.equal(countExecutedTests('Tests  14 passed, 1 failed (15)'), 15)
  assert.equal(countExecutedTests('Tests  1 regression (1)'), 1)
  assert.equal(countExecutedTests('Tests  2 passed, 1 regression, 3 skipped (6)'), 3)
  assert.equal(countExecutedTests(' NO TESTS EXECUTED '), 0)
})

test('the package script runs the check:changed entry point', async ({ assert }) => {
  const scripts = JSON.parse(await readFile(packageJson, 'utf8')).scripts

  assert.equal(
    scripts['check:changed'],
    'node --import=@poppinss/ts-exec --enable-source-maps bin/check_changed.ts'
  )
})
