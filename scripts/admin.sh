#!/usr/bin/env bash
# The administrative command line (backend/src/cli.ts), from any shell:
#
#   scripts/admin.sh media-check [meeting id …]
#   scripts/admin.sh reset-password <username>
#   scripts/admin.sh                         # lists the commands
#
# Finds Bun where scripts/install.sh put it (~/.bun/bin), which a non-login or
# `su -c` shell may not have on its PATH. Run by root on a project that belongs
# to another user (scripts/setup-user.sh), it runs as that user, so the
# database and any file it writes stay theirs.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OWNER=$(stat -c %U "$PROJECT_DIR" 2>/dev/null || echo root)
if [ "$(id -u)" = 0 ] && [ "$OWNER" != root ] && [ "$OWNER" != UNKNOWN ] && id -u "$OWNER" >/dev/null 2>&1; then
  # A terminal stays attached (reset-password asks for the new password).
  exec runuser -u "$OWNER" -- env HOME="$(getent passwd "$OWNER" | cut -d: -f6)" "$0" "$@"
fi
export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null || { echo "Bun is not installed for $(id -un) (~/.bun/bin/bun): run scripts/install.sh as $(id -un)." >&2; exit 1; }
cd "$PROJECT_DIR/backend"
exec bun src/cli.ts "$@"
