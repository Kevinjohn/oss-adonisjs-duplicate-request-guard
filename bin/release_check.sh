#!/usr/bin/env bash
# Release gate shared by .github/workflows/release.yml and local dry runs.
# Writes the version and tarball name to $GITHUB_OUTPUT when run in Actions.
# Packs the working-tree candidate independently of demo and consumer archives.
set -euo pipefail
VERSION=$(node -p "require('./package.json').version")
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "tag v$VERSION already exists" >&2; exit 1; fi
# Compare the version literally: its dots must not match any character.
awk -v h="## $VERSION - " 'index($0, h) == 1 && substr($0, length(h) + 1) ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ {f=1} END {exit !f}' CHANGELOG.md \
  || { echo "CHANGELOG.md has no '## $VERSION - YYYY-MM-DD' heading" >&2; exit 1; }
# The tarball is built from the working tree, so Unreleased entries would ship undocumented.
if awk '/^## Unreleased$/ {u=1; next} /^## / {u=0} u && NF {found=1} END {exit !found}' CHANGELOG.md; then
  echo "CHANGELOG.md has entries under '## Unreleased'; move them into the $VERSION section or bump the version" >&2
  exit 1; fi
pnpm build
rm -rf tmp/release && mkdir -p tmp/release
pnpm pack --pack-destination tmp/release >/dev/null
TARBALL=$(ls tmp/release/*.tgz)
REPO=${GITHUB_REPOSITORY:-$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')}
awk -v h="## $VERSION - " 'index($0, h) == 1 {p=1; next} /^## / {p=0} p' CHANGELOG.md > tmp/release/notes.md
printf '\n## Install\n\n```sh\npnpm add https://github.com/%s/releases/download/v%s/%s\n```\n\nSHA-256: `%s`\n' \
  "$REPO" "$VERSION" "$(basename "$TARBALL")" "$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)" >> tmp/release/notes.md
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "version=$VERSION"; echo "tarball=$(basename "$TARBALL")"; } >> "$GITHUB_OUTPUT"; fi
echo "ready: v$VERSION $TARBALL"
