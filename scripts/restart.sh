#!/usr/bin/env bash
# Restart MeetingMinutes in the background, in tmux sessions that survive logout.
#
#   scripts/restart.sh          # web server and GPU worker
#   scripts/restart.sh web      # web server only (e.g. after a new TLS certificate)
#   scripts/restart.sh worker   # GPU worker only
#
# Watch them with `tmux attach -t mm-web` / `tmux attach -t mm-worker`
# (detach again with Ctrl-b d).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }

restart() { # <session> <script>
  tmux kill-session -t "$1" 2>/dev/null || true
  tmux new-session -d -s "$1" -c "$PROJECT_DIR" "bash $2"
  echo "Restarted $1 (tmux attach -t $1)"
}

what="${1:-all}"
case "$what" in
  web) restart mm-web scripts/start.sh ;;
  worker) restart mm-worker scripts/worker.sh ;;
  all)
    restart mm-web scripts/start.sh
    # The worker does not use the TLS certificate; it is restarted here so code updates reach it too.
    restart mm-worker scripts/worker.sh
    ;;
  *) echo "usage: scripts/restart.sh [all|web|worker]" >&2; exit 2 ;;
esac
