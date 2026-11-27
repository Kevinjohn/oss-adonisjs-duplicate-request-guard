/** A file changed since the merge-base. Deleted files select checks but are never passed to tools. */
export interface ChangedFile {
  path: string
  deleted: boolean
}

/** One `pnpm` command run by `pnpm check:changed`. */
export interface ChangedCheckStep {
  label: string
  command: string[]
  /** Report the number of tests the step executed. */
  countsTests?: boolean
  /** Fail when the step executes no tests: its file filter is wrong. */
  requiresTests?: boolean
}

export interface SkippedCheckStep {
  label: string
  skip: string
}

export type PlannedCheckStep = ChangedCheckStep | SkippedCheckStep

const dependencyFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
// Formatter configuration (and package.json, which pins Prettier) can change any file's format.
const formatterInputs = [
  /^\.prettierrc/,
  /^\.prettierignore$/,
  /^\.editorconfig$/,
  /^package\.json$/,
]

const isSpec = (path: string) => /^tests\/.+\.spec\.ts$/.test(path)
const isTypeScript = (path: string) => /\.[cm]?tsx?$/.test(path)
const isEslintIgnored = (path: string) => /^(stubs|tests\/fixtures|tmp)\//.test(path)
const isLintable = (path: string) =>
  (/\.[cm]?[jt]sx?$/.test(path) && !isEslintIgnored(path)) || dependencyFiles.includes(path)

/** Files that cannot change the built package. */
function isOutsidePackage(path: string): boolean {
  return /^(tests|user-stories|\.github)\//.test(path) || /^[^/]+\.md$/.test(path)
}

export interface PlanOptions {
  /** Leave out every whole suite and the package build: one shared run covers them for a batch. */
  static?: boolean
}

/** Map the changed files to the repository scripts that check them. */
export function planChangedChecks(
  changes: ChangedFile[],
  { static: staticOnly = false }: PlanOptions = {}
): PlannedCheckStep[] {
  const paths = changes.map((change) => change.path)
  const present = changes.filter((change) => !change.deleted).map((change) => change.path)
  const formattable = present.filter((path) => path !== 'pnpm-lock.yaml')
  const specs = present.filter(isSpec)
  const shouldRunFullSuite = specs.length < changes.length
  const packageChanged = paths.some((path) => !isOutsidePackage(path))
  const formatAll = paths.some((path) => formatterInputs.some((input) => input.test(path)))

  const buildCheckStep = (
    when: boolean,
    reason: string,
    label: string,
    command: string[],
    options: Omit<ChangedCheckStep, 'label' | 'command'> = {}
  ): PlannedCheckStep => (when ? { label, command, ...options } : { label, skip: reason })
  // Under --static a suite the files select is named in a skip line instead of run.
  const buildSuiteStep = (
    when: boolean,
    reason: string,
    label: string,
    command: string[],
    stepOptions: Omit<ChangedCheckStep, 'label' | 'command'> = {}
  ): PlannedCheckStep =>
    when && staticOnly
      ? { label, skip: `--static leaves out ${command.join(' ')}` }
      : buildCheckStep(when, reason, label, command, stepOptions)
  const specsOnly = buildCheckStep(
    specs.length > 0,
    changes.length > 0 ? 'no test files changed' : 'no files changed',
    'tests',
    ['pnpm', 'quick:test', ...specs.map((path) => `--files=${path}`)],
    { countsTests: true, requiresTests: true }
  )

  return [
    formatAll
      ? { label: 'format', command: ['pnpm', 'format:check'] }
      : buildCheckStep(formattable.length > 0, 'no changed files to format', 'format', [
          'pnpm',
          'exec',
          'prettier',
          '--check',
          '--ignore-unknown',
          '--no-error-on-unmatched-pattern',
          // Without `--`, a file named like `-h.md` is parsed as an option.
          '--',
          ...formattable,
        ]),
    // The repository's own lint script carries the zero-warning limit for every caller.
    buildCheckStep(paths.some(isLintable), 'no lintable files changed', 'lint', ['pnpm', 'lint']),
    buildCheckStep(
      paths.some(
        (path) =>
          (isTypeScript(path) && !isEslintIgnored(path)) ||
          path === 'tsconfig.json' ||
          dependencyFiles.includes(path)
      ),
      'no TypeScript or type configuration changed',
      'typecheck',
      ['pnpm', 'typecheck']
    ),
    ...(!shouldRunFullSuite
      ? [specsOnly]
      : staticOnly
        ? [{ label: 'test suite', skip: '--static leaves out pnpm quick:test' }, specsOnly]
        : [
            {
              label: 'tests',
              command: ['pnpm', 'quick:test'],
              countsTests: true,
              requiresTests: true,
            },
          ]),
    buildSuiteStep(packageChanged, 'no package source changed', 'build', ['pnpm', 'build']),
  ]
}

/** Count the tests a Japa run executed from its summary line; 0 when none ran. */
export function countExecutedTests(output: string): number {
  // eslint-disable-next-line no-control-regex
  const summary = output.replace(/\u001b\[[0-9;]*m/g, '').match(/^\s*Tests\s+(.+)$/m)?.[1] ?? ''
  return [...summary.matchAll(/(\d+) (passed|failed|regression)/g)].reduce(
    (total, match) => total + Number(match[1]),
    0
  )
}
/** Bounded diagnostic tail, with test markers collected independently of retained output. */
export class CheckOutput {
  private tail = ''
  private readonly partial = { stdout: '', stderr: '' }
  private readonly oversized = { stdout: false, stderr: false }
  private count: number | undefined

  append(text: string, stream?: 'stdout' | 'stderr'): void {
    // Diagnostics retain at most 256 Ki characters, even if a child emits one enormous line.
    this.tail = (this.tail + text).slice(-256 * 1024)
    if (!stream) return
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!this.oversized[stream]) {
        if (this.partial[stream].length + line.length <= 16 * 1024) {
          this.partial[stream] += line
        } else {
          this.partial[stream] = ''
          this.oversized[stream] = true
        }
      }
      if (i < lines.length - 1) {
        if (!this.oversized[stream]) this.capture(this.partial[stream])
        this.partial[stream] = ''
        this.oversized[stream] = false
      }
    }
  }

  private capture(line: string): void {
    if (this.count === undefined && countExecutedTests(line) > 0) {
      this.count = countExecutedTests(line)
    }
  }

  finish(): { output: string; testCount: number } {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (!this.oversized[stream]) this.capture(this.partial[stream])
    }
    return { output: this.tail, testCount: this.count ?? 0 }
  }
}
