#!/usr/bin/env bash
# Sign the bundled Codex CLI in with the ChatGPT account whose quota pays for
# summaries. --device-auth works over SSH: open the printed URL on any device.
set -euo pipefail
cd "$(dirname "$0")/.."
CODEX=${CODEX_BIN:-backend/node_modules/.bin/codex}
"$CODEX" login --device-auth
"$CODEX" login status
