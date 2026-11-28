#!/usr/bin/env bash
# Restart MeetingMinutes in the background.
#
#   scripts/restart.sh          # web server and GPU worker
#   scripts/restart.sh web      # web server only (e.g. after a new TLS certificate)
#   scripts/restart.sh worker   # GPU worker only
#
# The web server runs as the systemd service meetingminutes-web once
# scripts/install-service.sh has set it up; this then restarts the service and
# waits until the site answers. Logs: journalctl -u meetingminutes-web -f
#
# Otherwise (and always for the worker) it runs in tmux sessions that survive
# logout. Watch them with `tmux attach -t mm-web` / `tmux attach -t mm-worker`
# (detach again with Ctrl-b d).
#
# Run by root on a project that belongs to another user (scripts/setup-user.sh),
# it restarts the systemd service itself and starts what runs in tmux as that
# user, never as root: root's crontab (acme.sh renewals) and root's shell can
# use it as they are, without sudo.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"
UNIT=meetingminutes-web.service

# The project's owner, when root runs this for another user's installation.
OWNER=$(stat -c %U "$PROJECT_DIR" 2>/dev/null || echo root)
for_owner() {
  [ "$(id -u)" = 0 ] && [ "$OWNER" != root ] && [ "$OWNER" != UNKNOWN ] && id -u "$OWNER" >/dev/null 2>&1
}

root_warning() {
  if [ "$(id -u)" = 0 ]; then
    echo "warning: starting MeetingMinutes as root; a dedicated user is safer (README, \"Running as a normal user\": scripts/setup-user.sh)" >&2
  fi
}

restart_tmux() { # <session> <script> <what: web|worker>
  if for_owner; then
    # As the owner, with their own home directory (Bun, uv) and their own tmux.
    runuser -l "$OWNER" -c "$(printf '%q ' "$PROJECT_DIR/scripts/restart.sh" "$3")"
    return
  fi
  root_warning
  command -v tmux >/dev/null || { echo "tmux is required" >&2; return 1; }
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

# ------------------------------------------------------------------ systemd

web_under_systemd() {
  [ -f "/etc/systemd/system/$UNIT" ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null
}

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi
}

# A setting from .env (the last line for it wins), without quotes.
env_value() {
  grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"'"'"'\r' || true
}

# Where this machine reaches the site: HOST and PORT from .env, over https when
# the server has its own certificate.
web_health_url() {
  local host port scheme=http
  host=$(env_value HOST)
  port=$(env_value PORT)
  case "$host" in "" | 0.0.0.0 | :: | "[::]") host=127.0.0.1 ;; esac
  if [[ $host == *:* && $host != \[* ]]; then host="[$host]"; fi
  [ -n "$(env_value TLS_CERT_FILE)" ] && scheme=https
  echo "$scheme://$host:${port:-8787}/healthz"
}

show_web_log() {
  local lines
  if lines=$(journalctl -u "$UNIT" -n 30 --no-pager 2>/dev/null) && [ -n "$lines" ] && ! grep -q "^-- No entries --" <<<"$lines"; then
    echo "$lines" >&2
  elif lines=$(sudo -n journalctl -u "$UNIT" -n 50 --no-pager 2>/dev/null) && [ -n "$lines" ]; then
    echo "$lines" | tail -n 30 >&2
  else
    echo "See its output with: sudo journalctl -u ${UNIT%.service} -n 50" >&2
  fi
}

restart_web_systemd() {
  # A copy still running in tmux (from before systemd) would hold the port.
  if command -v tmux >/dev/null && tmux has-session -t mm-web 2>/dev/null; then
    tmux kill-session -t mm-web && echo "Stopped the web server that ran in tmux (mm-web); systemd runs it now."
  fi
  if for_owner && runuser -u "$OWNER" -- tmux has-session -t mm-web 2>/dev/null; then
    runuser -u "$OWNER" -- tmux kill-session -t mm-web && echo "Stopped $OWNER's web server in tmux (mm-web); systemd runs it now."
  fi
  local restarts state url
  restarts=$(systemctl show -p NRestarts --value "$UNIT" 2>/dev/null || echo 0)
  if ! as_root systemctl restart "$UNIT"; then
    echo "Could not restart $UNIT as $(id -un)." >&2
    echo "Run this as root, or run sudo scripts/install-service.sh again (it allows its user to restart the service)." >&2
    return 1
  fi
  url=$(web_health_url)
  if ! command -v curl >/dev/null; then
    sleep 3
    state=$(systemctl show -p ActiveState --value "$UNIT")
    [ "$state" = active ] || { echo "$UNIT is $state after restarting; its output:" >&2; show_web_log; return 1; }
    echo "Restarted the web server ($UNIT; logs: journalctl -u ${UNIT%.service} -f)"
    return 0
  fi
  # Wait until the site answers: the first start after an update may install
  # dependencies and rebuild the web interface first.
  local waited=0
  while :; do
    if curl -fsk --max-time 2 -o /dev/null "$url" 2>/dev/null; then
      echo "Restarted the web server ($UNIT, answering at ${url%/healthz}; logs: journalctl -u ${UNIT%.service} -f)"
      return 0
    fi
    state=$(systemctl show -p ActiveState --value "$UNIT")
    if [ "$state" = failed ] || [ "$(systemctl show -p NRestarts --value "$UNIT")" != "$restarts" ]; then
      echo "The web server stopped while starting ($UNIT is $state); its output:" >&2
      show_web_log
      return 1
    fi
    if [ "$waited" -ge 600 ]; then
      echo "The web server has not answered at $url after 10 minutes ($UNIT is $state); its output:" >&2
      show_web_log
      return 1
    fi
    if [ "$waited" -gt 0 ] && [ $((waited % 15)) = 0 ]; then
      echo "  still starting after ${waited}s (installing dependencies or building the web interface?)"
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

restart_web() {
  if web_under_systemd; then restart_web_systemd; else restart_tmux mm-web scripts/start.sh web; fi
}

what="${1:-all}"
case "$what" in
  web) restart_web ;;
  worker) restart_tmux mm-worker scripts/worker.sh worker ;;
  all)
    rc=0
    restart_web || rc=1
    # The worker does not use the TLS certificate; it is restarted here so code updates reach it too.
    restart_tmux mm-worker scripts/worker.sh worker || rc=1
    exit $rc
    ;;
  *) echo "usage: scripts/restart.sh [all|web|worker]" >&2; exit 2 ;;
esac
