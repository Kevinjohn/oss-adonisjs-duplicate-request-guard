#!/usr/bin/env bash
# Test the archive in a clean installed consumer, without Assembler.
set -euo pipefail

fixture=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../tests/fixtures/release_consumer" && pwd)
consumer=$(mktemp -d)
trap 'rm -rf -- "$consumer"' EXIT
cp -- "$fixture/"{consumer.ts,adonisrc.ts,package.json,pnpm-workspace.yaml,tsconfig.json} "$consumer/"
cp -- "${1:?Pass the path to the packed release candidate}" "$consumer/candidate.tgz"
cd -- "$consumer"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
if (process.env.CORE_VERSION) manifest.dependencies['@adonisjs/core'] = process.env.CORE_VERSION
if (process.env.LUCID_VERSION) manifest.dependencies['@adonisjs/lucid'] = process.env.LUCID_VERSION
writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n')
JS
pnpm install --no-frozen-lockfile
pnpm smoke
