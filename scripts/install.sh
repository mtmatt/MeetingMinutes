#!/usr/bin/env bash
# Install MeetingMinutes without root: Bun and uv go to your home directory,
# everything else stays inside this repository.
#
#   scripts/install.sh            backend + frontend + GPU worker + Ollama (summary model)
#   scripts/install.sh --no-gpu   skip the worker's GPU dependencies (torch, Qwen3-ASR, pyannote) and Ollama:
#                                 a web host only, or a worker that uses the transcription API and pyannoteAI
#   scripts/install.sh --no-llm   skip Ollama (summaries by a hosted API, or a model server elsewhere)
#   scripts/install.sh --vllm     also install the vLLM backend for faster ASR
#   scripts/install.sh --worker-only   a worker on another machine (an NVIDIA box, a Mac): only the
#                                 worker, no web server or Ollama; then scripts/worker.sh enroll
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

GPU=1
VLLM=0
LLM=1
WEB=1
for arg in "$@"; do
  case "$arg" in
    --worker-only) WEB=0; LLM=0 ;;
    --no-gpu) GPU=0; LLM=0 ;;
    --no-llm) LLM=0 ;;
    --vllm) VLLM=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;31m==>\033[0m %s\n' "$*"; }

if [ "$WEB" = 1 ] && ! command -v bun >/dev/null 2>&1; then
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

if [ "$WEB" = 1 ]; then
  say "Installing JavaScript dependencies"
  bun install

  say "Building the web interface"
  bun run build
fi

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
  chmod 600 .env
  # A worker on another machine gets its own token by enrolling, not the server's shared one.
  if [ "$WEB" = 1 ]; then
    TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 43)
    sed -i.bak "s/^WORKER_TOKEN=.*/WORKER_TOKEN=$TOKEN/" .env && rm -f .env.bak
  fi
fi

if [ "$WEB" = 0 ]; then
  cat <<MSG

Worker installed. Next steps:
  1. In the site, Admin -> System -> Workers on other machines -> Add, and copy the command it shows:
       scripts/worker.sh enroll https://your-server:8443 mme_...
  2. For speakers separated on this machine's GPU, put HF_TOKEN in .env (see README).
  3. scripts/worker.sh check     (downloads the models, shows what this machine can run)
  4. scripts/restart.sh worker   (or scripts/worker.sh in a terminal)
MSG
  exit 0
fi

# After .env exists: it may say where Ollama goes (OLLAMA_PREFIX).
if [ "$LLM" = 1 ]; then
  if scripts/llm.sh where >/dev/null 2>&1; then
    say "Ollama is already installed (run scripts/llm.sh install to update it)"
  else
    say "Installing Ollama, for summaries"
    scripts/llm.sh install || echo "warning: Ollama could not be installed; see scripts/llm.sh, or choose a hosted API in Admin → Summary model" >&2
  fi
fi

cat <<MSG

Installed. Next steps:
  1. Edit .env: set PUBLIC_URL, and HF_TOKEN for speaker diarization.
  2. Summaries are written by a local model (Qwen3.8 27B, about 13 GB):
       start it:                                  scripts/llm.sh serve
       download the model (once):                 scripts/llm.sh pull
     Or a hosted model instead (Anthropic, OpenAI, OpenRouter, Gemini):
       put its key in .env (e.g. ANTHROPIC_API_KEY), then choose it in Admin → Summary model
  3. Start the web server:                        scripts/start.sh
  4. Start the GPU worker(s):                     scripts/worker.sh
  5. Open the site and create the admin account with the setup token printed by step 3.
  Optional: download the speech models ahead of time: scripts/worker.sh check
MSG
