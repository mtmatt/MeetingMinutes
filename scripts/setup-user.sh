#!/usr/bin/env bash
# Run MeetingMinutes as a normal user instead of root. Run this once, as root:
#
#   sudo scripts/setup-user.sh              # a system user named "minutes"
#   sudo scripts/setup-user.sh meetings     # another name (or MM_USER=meetings)
#   sudo scripts/setup-user.sh --dry-run    # only show what would be done
#
# It creates the user (if it does not exist), gives it this project directory
# and the data directory, keeps the data directory at mode 700 and .env at 600,
# and prints how to start the services as that user. It deletes nothing, stops
# nothing, and can be run again at any time (after an update done as root, say)
# to put ownership right.
#
# Why: the web server parses requests from the internet and the worker decodes
# uploaded files with ffmpeg. As root, a flaw in either is a flaw in the whole
# machine; as this user it reaches only this project and its data. No
# privileges are needed: the site listens on ports above 1024 (8443, and 8788
# on loopback), so there is nothing to grant with setcap or authbind.
set -euo pipefail

DRY=0
NAME=${MM_USER:-minutes}
for arg in "$@"; do
  case "$arg" in
    --dry-run | -n) DRY=1 ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) NAME=$arg ;;
  esac
done

if [ "$(id -u)" != 0 ]; then
  echo "scripts/setup-user.sh must be run as root (it creates a user and changes file ownership): sudo $0 $*" >&2
  exit 1
fi
case "$(uname -s)" in
  Linux) ;;
  *) echo "scripts/setup-user.sh is for Linux servers; on $(uname -s), run the worker from your own account." >&2; exit 1 ;;
esac
if ! [[ $NAME =~ ^[a-z_][a-z0-9_-]{0,30}$ ]]; then
  echo "\"$NAME\" is not a usable user name (lower-case letters, digits, - and _, starting with a letter)." >&2
  exit 2
fi
if [ "$NAME" = root ] || { id -u "$NAME" >/dev/null 2>&1 && [ "$(id -u "$NAME")" = 0 ]; }; then
  echo "The point is a user other than root; choose another name." >&2
  exit 2
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"

# The data directory as the server reads it: DATA_DIR from .env, relative to the project.
DATA_DIR=$(grep -E '^DATA_DIR=' "$PROJECT_DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"'"'"'\r' || true)
DATA_DIR=${DATA_DIR:-data}
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$PROJECT_DIR/$DATA_DIR" ;;
esac

say() { printf '==> %s\n' "$*"; }
run() { # show a command, and run it unless --dry-run
  printf '    %s\n' "$*"
  [ "$DRY" = 1 ] || "$@"
}

# The user must be able to reach the directories: /root, for one, is closed to
# everyone else. Checked before anything is changed.
blocked=""
for dir in "$PROJECT_DIR" "$DATA_DIR"; do
  parent=$(dirname "$dir")
  while [ "$parent" != / ]; do
    if [ -d "$parent" ] && [ -z "$(find "$parent" -maxdepth 0 -perm -o=x 2>/dev/null)" ]; then
      blocked=$parent
    fi
    parent=$(dirname "$parent")
  done
done
if [ -n "$blocked" ]; then
  cat >&2 <<EOF
$blocked is closed to other users, so "$NAME" could not reach
$PROJECT_DIR.

Move the project out of it first (stop the services, then for example):
  mv "$PROJECT_DIR" /opt/$(basename "$PROJECT_DIR")
and run /opt/$(basename "$PROJECT_DIR")/scripts/setup-user.sh again. Nothing was changed.
EOF
  exit 1
fi

[ "$DRY" = 1 ] && say "Dry run: nothing is changed"

if id -u "$NAME" >/dev/null 2>&1; then
  say "User $NAME exists"
else
  say "Creating the system user $NAME"
  # A home directory, because Bun, uv and acme.sh live in one;
  # no password, so nobody signs in as this user: root uses sudo -u or su.
  run useradd --system --create-home --user-group --shell /bin/bash "$NAME"
fi
if [ "$DRY" = 1 ] && ! id -u "$NAME" >/dev/null 2>&1; then
  GROUP=$NAME
else
  GROUP=$(id -gn "$NAME")
fi

say "Giving $PROJECT_DIR to $NAME"
# -h: a symbolic link itself changes owner, never the file it points to.
run chown -R -h "$NAME:$GROUP" "$PROJECT_DIR"
if [ -d "$DATA_DIR" ]; then
  case "$DATA_DIR/" in
    "$PROJECT_DIR"/*) ;;
    *)
      say "Giving the data directory $DATA_DIR to $NAME"
      run chown -R -h "$NAME:$GROUP" "$DATA_DIR"
      ;;
  esac
  say "Data directory: this user only (mode 700)"
  run chmod 700 "$DATA_DIR"
else
  say "No data directory yet ($DATA_DIR); the server creates it, with mode 700, at its first start"
fi
if [ -f "$PROJECT_DIR/.env" ]; then
  say ".env: this user only (mode 600)"
  run chmod 600 "$PROJECT_DIR/.env"
fi

# The proof: the user reads its settings and writes its data.
if [ "$DRY" = 0 ]; then
  as_user() { if command -v runuser >/dev/null 2>&1; then runuser -u "$NAME" -- "$@"; else su -s /bin/sh "$NAME" -c "$(printf '%q ' "$@")"; fi; }
  if ! as_user test -x "$PROJECT_DIR/scripts/start.sh" ||
    { [ -f "$PROJECT_DIR/.env" ] && ! as_user test -r "$PROJECT_DIR/.env"; } ||
    { [ -d "$DATA_DIR" ] && ! as_user test -w "$DATA_DIR"; }; then
    echo "warning: $NAME still cannot use $PROJECT_DIR; check the permissions of the directories above it." >&2
  fi
fi

# A command as $NAME, in its home directory, the way this machine allows:
# sudo when it is installed (Debian, for one, has only su by default).
as_user_cmd() {
  if command -v sudo >/dev/null 2>&1; then printf 'sudo -u %s -H %s' "$NAME" "$*"; else printf "su - %s -c '%s'" "$NAME" "$*"; fi
}

running=""
if command -v tmux >/dev/null 2>&1; then
  for s in mm-web mm-worker; do
    if tmux has-session -t "$s" 2>/dev/null; then running="$running $s"; fi
  done
fi

if [ "$DRY" = 1 ]; then
  HEAD="Dry run: nothing was changed. After a real run, this is what is left to do, as root:"
else
  HEAD="Done. $PROJECT_DIR now belongs to $NAME. What is left to do, as root:"
fi

cat <<EOF

$HEAD

1. Stop what is still running as root${running:+ (tmux sessions:$running)}:
     tmux kill-session -t mm-web; tmux kill-session -t mm-worker
   (or systemctl stop meetingminutes-web, if it runs as a systemd service).

2. Give $NAME its own tools. Bun and uv are installed in the home directory
   of whoever ran scripts/install.sh, and the worker's Python environment
   points there, so run it once more as $NAME, with the options you used:
     $(as_user_cmd "$PROJECT_DIR/scripts/install.sh [--no-gpu | --worker-only | …]")
   Not moved, because they are in root's home directory: Ollama and its
   models, and Hugging Face downloads. The worker's models in the data directory,
   its enrollment and all recordings stay where they are.

3. On the standard ports 443 and 80, allow users other than root to open them, once:
     echo 'net.ipv4.ip_unprivileged_port_start=80' > /etc/sysctl.d/60-meetingminutes-ports.conf && sysctl --system
   (A site on a port above 1024, such as 8443, needs nothing.)

4. Run the web server as a systemd service, as $NAME (it starts at boot):
     $PROJECT_DIR/scripts/install-service.sh
   and start the worker, which stays in tmux, with
     $PROJECT_DIR/scripts/restart.sh worker
   As root, scripts/restart.sh restarts the service and starts what runs in
   tmux as $NAME, never as root. Watch the worker with
     $(as_user_cmd "tmux attach -t mm-worker")        (detach with Ctrl-b d)
   Start it at boot: crontab -u $NAME -e, with the line
     @reboot $PROJECT_DIR/scripts/restart.sh worker

5. Certificates. If root's acme.sh renews the certificate (scripts/install-cert.sh),
   keep it there (the DNS token stays out of $NAME's reach) and run, as root, once:
     $PROJECT_DIR/scripts/install-cert.sh <domain>
   Each renewal then gives the files to $NAME and restarts the web server. Run it
   again whenever the project moves: acme.sh remembers the old paths.

6. Update as $NAME from now on, so new files belong to it:
     $(as_user_cmd "git -C $PROJECT_DIR pull") && $PROJECT_DIR/scripts/restart.sh
   An update done as root leaves files $NAME cannot change: run this script again.
EOF
