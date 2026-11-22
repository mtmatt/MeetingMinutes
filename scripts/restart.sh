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
  # remain-on-exit: if the program stops (a crash at start), its last messages
  # stay on screen in `tmux attach -t <session>` instead of vanishing with it.
  tmux new-session -d -s "$1" -c "$PROJECT_DIR" "bash $2" \; set-window-option -t "$1" remain-on-exit on
  sleep 2
  if [ "$(tmux display-message -p -t "$1" '#{pane_dead}' 2>/dev/null)" = 1 ]; then
    echo "$1 stopped right after starting; its output:" >&2
    tmux capture-pane -p -S -200 -t "$1" | sed '/^$/d' | tail -n 20 >&2
    return 1
  fi
  echo "Restarted $1 (tmux attach -t $1)"
}

what="${1:-all}"
case "$what" in
  web) restart mm-web scripts/start.sh ;;
  worker) restart mm-worker scripts/worker.sh ;;
  all)
    rc=0
    restart mm-web scripts/start.sh || rc=1
    # The worker does not use the TLS certificate; it is restarted here so code updates reach it too.
    restart mm-worker scripts/worker.sh || rc=1
    exit $rc
    ;;
  *) echo "usage: scripts/restart.sh [all|web|worker]" >&2; exit 2 ;;
esac
