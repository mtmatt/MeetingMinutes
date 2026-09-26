#!/usr/bin/env bash
# Run the web server (API + built frontend) in the foreground.
#
# After `git pull`, this brings JavaScript dependencies and the built web
# interface up to date before starting, so the browser never gets a stale UI.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"

# Dependencies: reinstall when the lockfile changed since the last install.
if [ ! -f node_modules/.mm-installed ] || [ bun.lock -nt node_modules/.mm-installed ]; then
  echo "==> Installing JavaScript dependencies (first start, or bun.lock changed)"
  bun install --frozen-lockfile
  touch node_modules/.mm-installed
fi

# Web interface: rebuild when any of its sources is newer than the last build.
if [ ! -f frontend/dist/index.html ] ||
  [ -n "$(find frontend/src frontend/public frontend/index.html frontend/package.json frontend/vite.config.ts frontend/tsconfig.json bun.lock \
    -newer frontend/dist/index.html -print -quit 2>/dev/null)" ]; then
  echo "==> Building the web interface (sources changed)"
  bun run build
fi

exec bun backend/src/index.ts
