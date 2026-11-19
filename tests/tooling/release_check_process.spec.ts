import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { collectExit, outputOf } from './child_process.js'

const releaseScript = new URL('../../bin/release_check.sh', import.meta.url)
const digest = 'a'.repeat(64)

for (const hash of ['missing', 'failed', 'invalid', 'valid'] as const) {
  test(`release gate with digest command state ${hash}`, async ({ assert, cleanup }) => {
    const root = await mkdtemp(join(tmpdir(), 'duplicate-request-guard-release-'))
    cleanup(() => rm(root, { recursive: true, force: true }))
    const commands = join(root, 'commands')
    const output = join(root, 'github-output')
    await mkdir(commands)
    await mkdir(join(root, 'bin'))
    await symlink(process.execPath, join(commands, 'node'))
    for (const name of ['awk', 'basename', 'cut', 'ls', 'mkdir', 'rm', 'bash']) {
      const executable = execFileSync('/bin/sh', ['-c', 'command -v "$1"', '--', name], {
        encoding: 'utf8',
      }).trim()
      await symlink(executable, join(commands, name))
    }
    const writeCommand = (name: string, body: string) =>
      writeFile(join(commands, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })

    // Stub the preflight and build commands. Run the real gate with only these declared
    // executables on PATH so the missing-command case really has no shasum binary.
    await writeCommand('git', 'exit 1')
    await writeCommand(
      'pnpm',
      `case "$*" in
        build) printf 'build\\n' >> stages ;;
        'pack --pack-destination tmp/release')
          printf 'pack\\n' >> stages
          printf 'archive' > tmp/release/package.tgz ;;
        *) exit 2 ;;
      esac`
    )
    if (hash !== 'missing') {
      const body = {
        failed: `printf '%s  %s\\n' '${digest}' "$3"; exit 2`,
        invalid: "printf 'short-digest\\n'",
        valid: `printf '%s  %s\\n' '${digest}' "$3"`,
      }[hash]
      await writeCommand('shasum', body)
    }

    await writeFile(join(root, 'package.json'), '{"version":"0.1.0"}')
    await writeFile(join(root, 'CHANGELOG.md'), '## 0.1.0 - 2026-11-16\n\nRelease notes.\n')
    await writeFile(
      join(root, 'bin/smoke_packed.sh'),
      'test "$1" = tmp/release/package.tgz && printf "smoke\\n" >> stages'
    )
    await writeFile(output, '')
    await writeFile(join(root, 'stages'), '')
    const child = spawn('/bin/bash', [fileURLToPath(releaseScript)], {
      cwd: root,
      env: { PATH: commands, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'example/repo' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const result = await collectExit(child, await outputOf(child))
    const notes = join(root, 'tmp/release/notes.md')
    assert.equal(await readFile(join(root, 'stages'), 'utf8'), 'build\npack\nsmoke\n', result.text)

    if (hash === 'valid') {
      assert.equal(result.code, 0, result.text)
      assert.include(await readFile(notes, 'utf8'), `SHA-256: \`${digest}\``)
      assert.equal(await readFile(output, 'utf8'), 'version=0.1.0\ntarball=package.tgz\n')
    } else {
      assert.equal(result.code, 1, result.text)
      assert.match(result.text, /Could not calculate a valid SHA-256 digest/)
      assert.equal(await readFile(output, 'utf8'), '')
      await assert.rejects(() => readFile(notes), /ENOENT/)
    }
  })
}
