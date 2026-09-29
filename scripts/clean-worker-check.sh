#!/usr/bin/env bash
# A30: prove a clean worker can reproduce its dependencies and render, from committed files only.
# 1) clone the committed tree (no untracked/ignored files, so no vendor/ or build output)
# 2) install exactly the lockfile (offline from the local pnpm store when network is restricted)
# 3) supply the licensed Redraw tarball explicitly (never committed) and verify its checksum
# 4) run the Skia and Redraw capability proofs (render, repeat/out-of-order seeks, export)
# Usage: scripts/clean-worker-check.sh [dest] ; env REDRAW_TARBALL, REDRAW_SHA256, REDRAW_SCALE
set -euo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
DEST=${1:-/tmp/vs-clean-worker}
rm -rf "$DEST"
git clone --quiet --no-hardlinks "$SRC" "$DEST"
cd "$DEST"
echo "commit: $(git rev-parse HEAD)"
test ! -e vendor/redraw || { echo "vendor/redraw must not be in the clean tree"; exit 1; }
pnpm install --frozen-lockfile --offline --reporter=silent
export REDRAW_TARBALL=${REDRAW_TARBALL:-$SRC/vendor/redraw/redraw-1.3.3.tgz}
export REDRAW_SHA256=${REDRAW_SHA256:-3cb516849efe04076d04b1db4eb4399376a817e860706b502838a7afd757474f}
echo "redraw tarball sha256: $(sha256sum "$REDRAW_TARBALL" | cut -d' ' -f1)"
start=$(date +%s)
(cd packages/graphics && npx tsx spike/capability.ts skia 1)
(cd packages/graphics && npx tsx spike/capability.ts redraw "${REDRAW_SCALE:-0.25}")
echo "clean worker check finished in $(( $(date +%s) - start ))s"
ls -la artifacts/graphics/*/report.json
