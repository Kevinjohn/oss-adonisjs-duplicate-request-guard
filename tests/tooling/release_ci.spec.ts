import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from '@japa/runner'

const workflowPath = new URL('../../.github/workflows/release.yml', import.meta.url)
const commit = 'a'.repeat(40)
const repo = 'owner/package'
const requiredJobs = ['checks']

// Validate the arguments as well as the order of calls. The fixture never reaches GitHub.
const ghStub = String.raw`#!/bin/bash
set -euo pipefail
case "$*" in
  "run list --repo $GITHUB_REPOSITORY --workflow checks.yml --branch main --commit $GITHUB_SHA --limit 1 --json databaseId,headSha,event")
    echo list >> "$CALLS"
    printf '%s\n' "$RUNS"
    exit "$LIST_STATUS";;
  "run watch 123 --repo $GITHUB_REPOSITORY --interval 30 --exit-status")
    echo watch >> "$CALLS"
    exit "$WATCH_STATUS";;
  "api repos/$GITHUB_REPOSITORY/actions/runs/123/jobs?filter=latest&per_page=100")
    echo jobs >> "$CALLS"
    printf '%s\n' "$JOBS"
    exit "$JOBS_STATUS";;
  *)
    echo "Unexpected gh command: $*" >&2
    exit 99;;
esac
`

const scenarios = [
  ['successful checks', 'list\nwatch\njobs\n', 0, 'true'],
  ['successful manual checks', 'list\nwatch\njobs\n', 0, 'true'],
  ['non-main dispatch', '', 1, 'release runs on main only'],
  ['missing run', 'list\n', 1, 'No checks.yml push or manual run found'],
  ['wrong event', 'list\n', 1, 'No checks.yml push or manual run found'],
  ['wrong SHA', 'list\n', 1, 'No checks.yml push or manual run found'],
  ['run list error', 'list\n', 1, 'No checks.yml push or manual run found'],
  ['failed run', 'list\nwatch\n', 1, ''],
  ['cancelled run', 'list\nwatch\n', 2, ''],
  ['jobs API error', 'list\nwatch\njobs\n', 1, 'Required checks.yml jobs'],
  ['missing required job', 'list\nwatch\njobs\n', 1, 'Required checks.yml jobs'],
  ['skipped required job', 'list\nwatch\njobs\n', 1, 'Required checks.yml jobs'],
  ['failed required job', 'list\nwatch\njobs\n', 1, 'Required checks.yml jobs'],
] as const

for (const [scenario, expectedCalls, status, message] of scenarios) {
  test(`release CI gate handles ${scenario}`, async ({ assert, cleanup }) => {
    const workflow = await readFile(workflowPath, 'utf8')
    const gate = /^ {2}ci:\n[\s\S]*?^ {8}run: \|\n((?:^ {10}[^\n]*\n)+)/m.exec(workflow)?.[1]
    if (!gate) throw new Error('Missing CI gate script in the release workflow')
    const directory = await mkdtemp(join(tmpdir(), 'release-ci-'))
    cleanup(() => rm(directory, { recursive: true, force: true }))
    const calls = join(directory, 'calls')
    await writeFile(calls, '')
    await writeFile(join(directory, 'gh'), ghStub, { mode: 0o755 })

    const runs =
      scenario === 'missing run'
        ? []
        : [
            {
              databaseId: 123,
              headSha: scenario === 'wrong SHA' ? 'b'.repeat(40) : commit,
              event:
                scenario === 'wrong event'
                  ? 'pull_request'
                  : scenario === 'successful manual checks'
                    ? 'workflow_dispatch'
                    : 'push',
            },
          ]
    const jobs = requiredJobs.map((name) => ({ name, status: 'completed', conclusion: 'success' }))
    if (scenario === 'missing required job') jobs.splice(0, 1)
    if (scenario === 'skipped required job') jobs[0].conclusion = 'skipped'
    if (scenario === 'failed required job') jobs[0].conclusion = 'failure'
    const result = spawnSync('bash', ['-s'], {
      input: gate.replace(/^ {10}/gm, ''),
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: directory + delimiter + process.env.PATH,
        CALLS: calls,
        GITHUB_REF: scenario === 'non-main dispatch' ? 'refs/heads/topic' : 'refs/heads/main',
        GITHUB_REPOSITORY: repo,
        GITHUB_SHA: commit,
        RUNS: JSON.stringify(runs),
        LIST_STATUS: scenario === 'run list error' ? '1' : '0',
        WATCH_STATUS: scenario === 'failed run' ? '1' : scenario === 'cancelled run' ? '2' : '0',
        JOBS: JSON.stringify({ jobs }),
        JOBS_STATUS: scenario === 'jobs API error' ? '1' : '0',
      },
    })

    assert.equal(result.status, status, result.stderr)
    assert.equal(await readFile(calls, 'utf8'), expectedCalls)
    if (message) assert.include(result.stdout, message)
  })
}
