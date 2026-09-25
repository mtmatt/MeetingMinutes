#!/usr/bin/env bash
# Install MeetingMinutes without root: Bun and uv go to your home directory,
# everything else stays inside this repository.
#
#   scripts/install.sh            backend + frontend + GPU worker
#   scripts/install.sh --no-gpu   skip the worker's GPU dependencies (web host only)
#   scripts/install.sh --vllm     also install the vLLM backend for faster ASR
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

GPU=1
VLLM=0
for arg in "$@"; do
  case "$arg" in
    --no-gpu) GPU=0 ;;
    --vllm) VLLM=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;31m==>\033[0m %s\n' "$*"; }

if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    say "Installing Bun into ~/.bun"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi

if ! command -v uv >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/uv" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    say "Installing uv into ~/.local/bin"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

say "Installing JavaScript dependencies"
bun install

say "Building the web interface"
bun run build

say "Installing the worker (Python via uv; no system packages needed)"
cd "$ROOT/worker"
EXTRAS=()
[ "$GPU" = 1 ] && EXTRAS+=(--extra gpu)
[ "$VLLM" = 1 ] && EXTRAS+=(--extra gpu --extra vllm)
uv sync "${EXTRAS[@]}"
cd "$ROOT"

if [ ! -f .env ]; then
  say "Creating .env"
  cp .env.example .env
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 43)
  sed -i "s/^WORKER_TOKEN=.*/WORKER_TOKEN=$TOKEN/" .env
fi

cat <<MSG

Installed. Next steps:
  1. Edit .env: set PUBLIC_URL, and HF_TOKEN for speaker diarization.
  2. Sign Codex in with your ChatGPT account:   bun run codex:login
  3. Start the web server:                        scripts/start.sh
  4. Start the GPU worker(s):                     scripts/worker.sh
  5. Open the site and create the admin account with the setup token printed by step 3.
  Optional: download the models ahead of time:    scripts/worker.sh check
MSG
