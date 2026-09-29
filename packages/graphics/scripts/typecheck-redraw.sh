#!/usr/bin/env bash
# Type-check the Redraw runtime against the authorized release's own declarations.
# Skips (exit 0) when no tarball is present, e.g. in a public checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
TGZ=$(ls ../../vendor/redraw/redraw-*.tgz 2>/dev/null | sort -V | tail -1 || true)
[[ -z "$TGZ" ]] && { echo "redraw tarball not present; skipping"; exit 0; }
TMP=$(mktemp -d); tar xzf "$TGZ" -C "$TMP"
cat > "$TMP/tsconfig.json" <<JSON
{ "extends": "$(pwd)/../../tsconfig.base.json",
  "compilerOptions": { "types": ["@webgpu/types"], "typeRoots": ["$(pwd)/node_modules/@types", "$(pwd)/node_modules"], "baseUrl": ".", "paths": { "redraw": ["$TMP/package/dist/index.d.ts"], "typegpu": ["$(pwd)/node_modules/typegpu"] } },
  "files": ["$(pwd)/src/runtime/redraw-runtime.ts"] }
JSON
npx tsc -p "$TMP/tsconfig.json"
echo "redraw runtime typechecks against $(basename "$TGZ")"
