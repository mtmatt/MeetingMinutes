#!/usr/bin/env bash
# Run the web server as a systemd service (meetingminutes-web) instead of in
# tmux. Run this once, as root:
#
#   sudo scripts/install-service.sh              # install, enable and start it
#   sudo scripts/install-service.sh --dry-run    # only show what would be done
#   sudo scripts/install-service.sh --uninstall  # back to tmux (scripts/restart.sh web)
#
# The service runs as the user who owns this project directory (see
# scripts/setup-user.sh for a dedicated one), starts at boot, restarts after a
# crash, and logs to the journal: journalctl -u meetingminutes-web -f
# Afterwards `scripts/restart.sh web` (and acme.sh after a certificate renewal)
# restarts the service and waits until the site answers. For a user other than
# root, a sudoers rule allows exactly that and nothing more.
#
# The worker is not affected: it keeps running in tmux (scripts/restart.sh worker).
# Running this again is safe: it rewrites the unit from
# deploy/systemd/system/meetingminutes-web.service.in and restarts the server.
set -euo pipefail

UNIT=meetingminutes-web.service
UNIT_PATH=/etc/systemd/system/$UNIT
SUDOERS_PATH=/etc/sudoers.d/meetingminutes-web
DRY=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run | -n) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" != 0 ]; then
  echo "scripts/install-service.sh must be run as root (it installs a system service): sudo $0 $*" >&2
  exit 1
fi
if [ "$(uname -s)" != Linux ] || [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null; then
  echo "This machine does not run systemd; keep using scripts/restart.sh (tmux)." >&2
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
SYSTEMCTL=$(command -v systemctl)
say() { printf '==> %s\n' "$*"; }
run() { # show a command, and run it unless --dry-run
  printf '    %s\n' "$*"
  [ "$DRY" = 1 ] || "$@"
}

if [ "$UNINSTALL" = 1 ]; then
  say "Removing the $UNIT service"
  if [ -f "$UNIT_PATH" ]; then
    run "$SYSTEMCTL" disable --now "$UNIT"
    run rm -f "$UNIT_PATH"
    run "$SYSTEMCTL" daemon-reload
  else
    echo "    (not installed)"
  fi
  [ -f "$SUDOERS_PATH" ] && run rm -f "$SUDOERS_PATH"
  echo
  echo "The web server is stopped. Start it in tmux again with scripts/restart.sh web (as the project's owner)."
  exit 0
fi

# The service runs as whoever owns the project, like the scripts do when that
# user runs them.
# By number: files copied from another computer with their owner kept (rsync -a,
# scp -p, a tar) can belong to a user ID with no account here, which stat names
# "UNKNOWN".
OWNER_UID=$(stat -c %u "$PROJECT_DIR")
NAME=$(getent passwd "$OWNER_UID" | cut -d: -f1 || true)
if [ -z "$NAME" ]; then
  cat >&2 <<EOF
$PROJECT_DIR belongs to user ID $OWNER_UID, which has no account on this machine
(the files were probably copied here from another computer with their owner kept).
The service must run as an account that exists. Give the project to one, then run
this script again:
  the account you run it as now:   chown -R root:root $PROJECT_DIR
  or a dedicated user (safer):     scripts/setup-user.sh
Only ownership changes; no file is altered.
EOF
  exit 1
fi
GROUP=$(id -gn "$NAME")
HOME_DIR=$(getent passwd "$NAME" | cut -d: -f6)
if [ "$NAME" = root ]; then
  echo "warning: $PROJECT_DIR belongs to root, so the web server will run as root." >&2
  echo "         A dedicated user is safer: see scripts/setup-user.sh (README, \"Running as a normal user\")," >&2
  echo "         then run this script again." >&2
fi
if [ ! -x "$HOME_DIR/.bun/bin/bun" ] && ! runuser -u "$NAME" -- sh -c 'command -v bun' >/dev/null 2>&1; then
  echo "Bun is not installed for $NAME ($HOME_DIR/.bun/bin/bun). Run scripts/install.sh as $NAME first." >&2
  exit 1
fi
case "$PROJECT_DIR$HOME_DIR" in
  *[[:space:]@]*) echo "The project or home directory contains a space or @; move it to a plain path first." >&2; exit 1 ;;
esac

TEMPLATE="$PROJECT_DIR/deploy/systemd/system/meetingminutes-web.service.in"
# The template's own header comment (before [Unit]) is replaced by one for the installed copy.
UNIT_TEXT="# Written by $PROJECT_DIR/scripts/install-service.sh from
# deploy/systemd/system/meetingminutes-web.service.in: edit that and run the script again.
$(sed -e '1,/^\[Unit\]/{/^#/d}' -e "s|@USER@|$NAME|g" -e "s|@GROUP@|$GROUP|g" -e "s|@HOME@|$HOME_DIR|g" -e "s|@DIR@|$PROJECT_DIR|g" "$TEMPLATE")"

say "Service $UNIT_PATH (runs as $NAME, in $PROJECT_DIR)"
if [ "$DRY" = 1 ]; then
  sed 's/^/      /' <<<"$UNIT_TEXT"
else
  tmp=$(mktemp)
  printf '%s\n' "$UNIT_TEXT" >"$tmp"
  install -m 644 -o root -g root "$tmp" "$UNIT_PATH"
  rm -f "$tmp"
  if command -v systemd-analyze >/dev/null; then
    systemd-analyze verify "$UNIT_PATH" 2>&1 | grep -F "$UNIT" | sed 's/^/    note: /' || true
  fi
fi

# Let the owner restart the service (scripts/restart.sh web, acme.sh renewals)
# and read its last lines when a start fails; exact commands only.
if [ "$NAME" != root ]; then
  if command -v sudo >/dev/null && command -v visudo >/dev/null; then
    JOURNALCTL=$(command -v journalctl || echo /usr/bin/journalctl)
    RULE="# Written by scripts/install-service.sh: $NAME may restart the MeetingMinutes web server, nothing else.
$NAME ALL=(root) NOPASSWD: $SYSTEMCTL restart $UNIT, $SYSTEMCTL start $UNIT, $SYSTEMCTL stop $UNIT, $JOURNALCTL -u $UNIT -n 50 --no-pager"
    say "Allowing $NAME to restart it: $SUDOERS_PATH"
    if [ "$DRY" = 1 ]; then
      sed 's/^/      /' <<<"$RULE"
    else
      tmp=$(mktemp)
      printf '%s\n' "$RULE" >"$tmp"
      if visudo -cqf "$tmp"; then
        install -m 440 -o root -g root "$tmp" "$SUDOERS_PATH"
      else
        echo "warning: the sudoers rule did not pass visudo; not installed. Restart the service as root." >&2
      fi
      rm -f "$tmp"
    fi
  else
    echo "warning: sudo is not installed; only root can restart the service (systemctl restart ${UNIT%.service})." >&2
  fi
fi

# The older user-level unit (deploy/systemd/meetingminutes.service) would
# start a second copy on the same port.
if [ -f "$HOME_DIR/.config/systemd/user/meetingminutes.service" ]; then
  echo "warning: $NAME also has the user unit meetingminutes.service. Turn it off, as $NAME:" >&2
  echo "         systemctl --user disable --now meetingminutes" >&2
fi

say "Enabling it at boot and starting it"
run "$SYSTEMCTL" daemon-reload
run "$SYSTEMCTL" enable "$UNIT"
if [ "$DRY" = 1 ]; then
  echo "    $PROJECT_DIR/scripts/restart.sh web   (as $NAME: stops the tmux copy, mm-web, and starts the service)"
  echo
  echo "Dry run: nothing was changed."
  exit 0
fi
# A copy root started in tmux (before scripts/setup-user.sh, say) would hold the port.
if [ "$NAME" != root ] && command -v tmux >/dev/null && tmux has-session -t mm-web 2>/dev/null; then
  tmux kill-session -t mm-web && say "Stopped root's tmux copy of the web server (mm-web)"
fi
# restart.sh stops the copy in tmux (as its owner) and waits until the site answers.
if [ "$NAME" = root ]; then
  "$PROJECT_DIR/scripts/restart.sh" web
else
  runuser -u "$NAME" -- "$PROJECT_DIR/scripts/restart.sh" web
fi

cat <<EOF

Done. The web server now runs as the systemd service ${UNIT%.service}:
  status:   systemctl status ${UNIT%.service}
  logs:     journalctl -u ${UNIT%.service} -f
  restart:  scripts/restart.sh web     (after git pull, as before)
The worker still runs in tmux: scripts/restart.sh worker
EOF
