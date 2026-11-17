#!/usr/bin/env bash
# Smoke-test the packed tarball: unpack it and import what package.json `exports` promises.
# Usage: bin/smoke_packed.sh <path-to-tarball>
#
# Peer dependencies resolve by symlinking the repo's node_modules into the unpacked package.
# That also means this cannot catch a missing `dependencies` entry: anything installed in the
# repo resolves, whether or not the package declares it.
set -euo pipefail
TARBALL=${1:?usage: smoke_packed.sh <tarball>}
[ -f "$TARBALL" ] || { echo "smoke: no such tarball: $TARBALL" >&2; exit 1; }
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SMOKE=$(mktemp -d)
trap 'rm -rf "$SMOKE"' EXIT
tar -xzf "$TARBALL" -C "$SMOKE"
PKG="$SMOKE/package"
[ -f "$PKG/package.json" ] || { echo "smoke: tarball has no package/package.json" >&2; exit 1; }
ln -s "$REPO/node_modules" "$PKG/node_modules"
node --input-type=module - "$PKG" <<'JS'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pkgDir = process.argv[2]
const fail = (message) => {
  console.error(`smoke: ${message}`)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const entries = Object.entries(pkg.exports ?? {})
if (entries.length === 0) fail('package.json has no exports')

const modules = {}
for (const [key, target] of entries) {
  if (typeof target !== 'string') {
    fail(`exports["${key}"] is not a plain path: ${JSON.stringify(target)}`)
  }
  const file = join(pkgDir, target)
  if (!existsSync(file)) fail(`exports["${key}"] -> ${target} is not in the tarball`)
  try {
    modules[key] = await import(pathToFileURL(file).href)
  } catch (error) {
    fail(`exports["${key}"] -> ${target} failed to import: ${error.message}`)
  }
  // package.json has no "types" field: TypeScript finds the .d.ts next to the .js entry.
  if (!existsSync(file.replace(/\.js$/, '.d.ts'))) fail(`no type declarations next to ${target}`)
}

const root = modules['.']
if (!root) fail('exports has no "." entry')
const names = [
  'execute',
  'executeIn',
  'pruneReceipts',
  'configure',
  'assertSupportedConnection',
  'RECEIPTS_TABLE',
  'errors',
]
for (const name of names) {
  if (!(name in root)) fail(`root entry is missing export "${name}"`)
}

const { stubsRoot } = await import(pathToFileURL(join(pkgDir, 'build/configure.js')).href)
const stub = join(stubsRoot, 'migrations/create_request_receipts_table.stub')
if (!existsSync(stub)) fail(`stub not packed: ${stub}`)
console.log(`smoke: ok (${entries.length} exports, stub present)`)
JS
