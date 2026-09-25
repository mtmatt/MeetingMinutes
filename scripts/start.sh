#!/usr/bin/env bash
# Run the web server (API + built frontend) in the foreground.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
[ -f frontend/dist/index.html ] || bun run build
exec bun backend/src/index.ts
