import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import {
  executedTests,
  planChangedChecks,
  type ChangedFile,
  type PlannedCheckStep,
} from '../../bin/check_changed_plan.js'

const packageJson = new URL('../../package.json', import.meta.url)
const changed = (...paths: string[]): ChangedFile[] =>
  paths.map((path) => ({ path, deleted: false }))

function ran(plan: PlannedCheckStep[]): Record<string, string[]> {
  return Object.fromEntries(
    plan.flatMap((step) => ('command' in step ? [[step.label, step.command]] : []))
  )
}

test('a changed spec runs on its own and requires executed tests', ({ assert }) => {
  const plan = planChangedChecks(changed('tests/execute.spec.ts'))
  const tests = plan.find((step) => step.label === 'tests')

  assert.deepEqual(Object.keys(ran(plan)), ['format', 'lint', 'typecheck', 'tests'])
  assert.deepInclude(tests, {
    command: ['pnpm', 'quick:test', '--files=tests/execute.spec.ts'],
    countsTests: true,
    requiresTests: true,
  })
})

test('package source and manifests run the suite and the build', ({ assert }) => {
  for (const path of ['src/receipts.ts', 'package.json', 'pnpm-lock.yaml']) {
    const commands = ran(planChangedChecks(changed(path, 'tests/execute.spec.ts')))
    assert.deepEqual(commands.tests, ['pnpm', 'quick:test'], path)
    assert.deepEqual(commands.build, ['pnpm', 'build'], path)
  }
})

test('files the specs read run the full suite without building the package', ({ assert }) => {
  for (const path of ['tests/helpers.ts', 'CHANGELOG.md', '.github/workflows/checks.yml']) {
    const commands = ran(planChangedChecks(changed(path)))
    assert.deepEqual(commands.tests, ['pnpm', 'quick:test'], path)
    assert.notProperty(commands, 'build', path)
  }
})

test('lockfile and workspace changes run lint and typecheck', ({ assert }) => {
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    assert.properties(ran(planChangedChecks(changed(path))), ['lint', 'typecheck'], path)
  }
})

test('deleted files select checks but are never passed to tools', ({ assert }) => {
  const commands = ran(
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
    ran(planChangedChecks([{ path: 'tests/old_module.spec.ts', deleted: true }])).tests,
    ['pnpm', 'quick:test']
  )
})

test('formats only existing files and leaves the lockfile to pnpm', ({ assert }) => {
  const commands = ran(planChangedChecks(changed('README.md', 'pnpm-lock.yaml')))

  assert.deepEqual(commands.format.slice(-1), ['README.md'])
  assert.include(commands.format, '--ignore-unknown')
  assert.include(commands.format, '--no-error-on-unmatched-pattern')
})

test('formatter configuration checks the whole tree', ({ assert }) => {
  for (const path of ['.prettierignore', '.editorconfig', 'package.json'])
    assert.deepEqual(ran(planChangedChecks(changed(path))).format, ['pnpm', 'format:check'], path)
})

test('lint allows no warnings and skips files ESLint ignores', async ({ assert }) => {
  assert.deepEqual(ran(planChangedChecks(changed('index.ts'))).lint, ['pnpm', 'lint'])
  // The repository's own lint script carries the zero-warning limit for every caller.
  const manifest = JSON.parse(await readFile(packageJson, 'utf8'))
  assert.include(manifest.scripts.lint, '--max-warnings 0')
  assert.notProperty(ran(planChangedChecks(changed('stubs/x.ts'))), 'lint')
})

test('--static names each selected suite in a skip line instead of running it', ({ assert }) => {
  const plan = planChangedChecks(changed('src/receipts.ts', 'package.json', 'README.md'), {
    static: true,
  })

  assert.deepEqual(Object.keys(ran(plan)), ['format', 'lint', 'typecheck'])
  for (const [label, skip] of [
    ['test suite', '--static leaves out pnpm quick:test'],
    ['build', '--static leaves out pnpm build'],
  ])
    assert.deepInclude(plan, { label, skip })
})

test('--static still runs the changed specs on their own', ({ assert }) => {
  const plan = planChangedChecks(changed('src/receipts.ts', 'tests/execute.spec.ts'), {
    static: true,
  })

  assert.deepEqual(ran(plan).tests, ['pnpm', 'quick:test', '--files=tests/execute.spec.ts'])
  assert.deepInclude(plan, { label: 'test suite', skip: '--static leaves out pnpm quick:test' })
  assert.deepInclude(planChangedChecks(changed('src/receipts.ts'), { static: true }), {
    label: 'tests',
    skip: 'no test files changed',
  })
})

test('--static plans a spec-only change exactly as the default does', ({ assert }) => {
  assert.deepEqual(
    planChangedChecks(changed('tests/execute.spec.ts'), { static: true }),
    planChangedChecks(changed('tests/execute.spec.ts'))
  )
})

test('counts executed tests from the Japa summary', ({ assert }) => {
  assert.equal(executedTests('\u001b[2mTests\u001b[22m  335 passed, 2 skipped (337)'), 335)
  assert.equal(executedTests('Tests  14 passed, 1 failed (15)'), 15)
  assert.equal(executedTests('Tests  1 regression (1)'), 1)
  assert.equal(executedTests('Tests  2 passed, 1 regression, 3 skipped (6)'), 3)
  assert.equal(executedTests(' NO TESTS EXECUTED '), 0)
})

test('the package script runs the check:changed entry point', async ({ assert }) => {
  const scripts = JSON.parse(await readFile(packageJson, 'utf8')).scripts

  assert.equal(
    scripts['check:changed'],
    'node --import=@poppinss/ts-exec --enable-source-maps bin/check_changed.ts'
  )
})
