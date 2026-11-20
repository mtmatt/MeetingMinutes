#!/usr/bin/env bash
# The local model that writes summaries: Ollama, installed and run as a normal
# user (no root, no system service).
#
#   scripts/llm.sh install        download Ollama into ~/.local/ollama (run again to update)
#   scripts/llm.sh serve          run it in the foreground on LLM_BASE_URL (default 127.0.0.1:11434)
#   scripts/llm.sh pull [MODEL]   download a model (default: LLM_MODEL from .env)
#   scripts/llm.sh check          show the server and the model, and ask it for one sentence
#
# The model is loaded onto the GPU only while a summary is being written and
# released right after (LLM_KEEP_ALIVE_SEC, default 0), so transcription keeps
# its GPU memory. An Ollama you installed some other way is used if it is on PATH.
#
# Ollama only ever listens on this machine's loopback address (127.0.0.1): it
# has no authentication, so nothing outside this machine may reach it. Only the
# web server talks to it; the web server's port is the only one to open.
set -euo pipefail
cd "$(dirname "$0")/.."

# A value from the environment, else from .env, else the default.
setting() {
  local name=$1 fallback=$2 v
  v=${!name-}
  if [ -z "$v" ] && [ -f .env ]; then
    v=$(grep -E "^${name}=" .env | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true)
  fi
  printf '%s' "${v:-$fallback}"
}

BASE_URL=$(setting LLM_BASE_URL http://127.0.0.1:11434)
BASE_URL=${BASE_URL%/}
MODEL=$(setting LLM_MODEL batiai/qwen3.8-27b:q3)
GPUS=$(setting LLM_GPUS "")
PREFIX=${OLLAMA_PREFIX:-$HOME/.local/ollama}

say() { printf '\033[1;31m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

ollama_bin() {
  if [ -n "${OLLAMA_BIN:-}" ]; then echo "$OLLAMA_BIN"
  elif [ -x "$PREFIX/bin/ollama" ]; then echo "$PREFIX/bin/ollama"
  elif command -v ollama >/dev/null 2>&1; then command -v ollama
  else return 1
  fi
}

is_loopback() {
  case "$1" in
    127.* | localhost | "[::1]" | ::1) return 0 ;;
    *) return 1 ;;
  esac
}

# Loopback host:port for Ollama: LLM_BASE_URL's port when it points at this
# machine, otherwise Ollama's usual 11434. Never a network address.
listen_addr() {
  local hostport=${BASE_URL#*://} host port
  hostport=${hostport%%/*}
  case "$hostport" in
    \[*\]:*) host=${hostport%:*}; port=${hostport##*:} ;;
    \[*\]) host=$hostport; port=11434 ;;
    *:*) host=${hostport%:*}; port=${hostport##*:} ;;
    *) host=$hostport; port=11434 ;;
  esac
  case "$host" in
    "[::1]") echo "[::1]:$port" ;;
    *) if is_loopback "$host"; then echo "127.0.0.1:$port"; else echo "127.0.0.1:11434"; fi ;;
  esac
}

reachable() { curl -fsS --max-time 3 "$BASE_URL/api/version" >/dev/null 2>&1; }

install_ollama() {
  local arch
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU architecture $(uname -m)" ;;
  esac
  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  # Ollama publishes Linux builds as .tar.zst (newer) and .tgz (older); try both.
  local got=""
  for url in \
    "https://ollama.com/download/ollama-linux-$arch.tar.zst" \
    "https://github.com/ollama/ollama/releases/latest/download/ollama-linux-$arch.tar.zst" \
    "https://ollama.com/download/ollama-linux-$arch.tgz" \
    "https://github.com/ollama/ollama/releases/latest/download/ollama-linux-$arch.tgz"; do
    case "$url" in *.zst) command -v zstd >/dev/null 2>&1 || continue ;; esac
    say "Downloading $url"
    if curl -fL --progress-bar -o "$tmp/ollama.archive" "$url"; then got=$url; break; fi
  done
  [ -n "$got" ] || die "could not download Ollama (install zstd if only .tar.zst builds are offered, or install Ollama yourself and put it on PATH)"
  mkdir -p "$tmp/out"
  case "$got" in
    *.zst) zstd -dc "$tmp/ollama.archive" | tar -x -C "$tmp/out" ;;
    *) tar -xzf "$tmp/ollama.archive" -C "$tmp/out" ;;
  esac
  [ -x "$tmp/out/bin/ollama" ] || die "the download did not contain bin/ollama"
  rm -rf "$PREFIX.new"
  mkdir -p "$(dirname "$PREFIX")"
  mv "$tmp/out" "$PREFIX.new"
  rm -rf "$PREFIX"
  mv "$PREFIX.new" "$PREFIX"
  say "Installed $("$PREFIX/bin/ollama" --version 2>/dev/null | tail -n 1) in $PREFIX"
}

serve_env() {
  export OLLAMA_HOST=${OLLAMA_HOST:-$(listen_addr)}
  # Refuse to expose the model: Ollama has no authentication.
  local host=${OLLAMA_HOST#*://}
  case "$host" in *:*) host=${host%:*} ;; esac
  if ! is_loopback "${host:-0.0.0.0}"; then
    die "OLLAMA_HOST=$OLLAMA_HOST would let other machines use the model directly. Ollama must listen on 127.0.0.1 only; unset OLLAMA_HOST."
  fi
  # Flash attention and an 8-bit KV cache halve the memory a long transcript needs.
  export OLLAMA_FLASH_ATTENTION=${OLLAMA_FLASH_ATTENTION:-1}
  export OLLAMA_KV_CACHE_TYPE=${OLLAMA_KV_CACHE_TYPE:-q8_0}
  # One summary model at a time; summaries are queued by the web server anyway.
  export OLLAMA_MAX_LOADED_MODELS=${OLLAMA_MAX_LOADED_MODELS:-1}
  export OLLAMA_NUM_PARALLEL=${OLLAMA_NUM_PARALLEL:-1}
  # Requests say how long to stay loaded; anything else (the CLI) unloads at once.
  export OLLAMA_KEEP_ALIVE=${OLLAMA_KEEP_ALIVE:-0}
  export CUDA_DEVICE_ORDER=${CUDA_DEVICE_ORDER:-PCI_BUS_ID}
  if [ -n "$GPUS" ]; then export CUDA_VISIBLE_DEVICES=$GPUS; fi
}

cmd=${1:-serve}
case "$cmd" in
  install)
    install_ollama
    ;;
  serve)
    bin=$(ollama_bin) || die "Ollama is not installed: run scripts/llm.sh install"
    serve_env
    echo "starting Ollama on $OLLAMA_HOST (this machine only)${GPUS:+, GPUs $GPUS}"
    exec "$bin" serve
    ;;
  pull)
    bin=$(ollama_bin) || die "Ollama is not installed: run scripts/llm.sh install"
    model=${2:-$MODEL}
    serve_env
    started=""
    if ! reachable; then
      # Pulling needs a running server: start one for the download only.
      "$bin" serve >/dev/null 2>&1 &
      started=$!
      trap '[ -n "$started" ] && kill "$started" 2>/dev/null || true' EXIT
      for _ in $(seq 1 30); do reachable && break; sleep 1; done
      reachable || die "Ollama did not start on $OLLAMA_HOST"
    fi
    say "Downloading $model"
    "$bin" pull "$model"
    ;;
  check)
    reachable || die "no Ollama server at $BASE_URL: start it with scripts/llm.sh serve"
    echo "Server: Ollama $(curl -fsS "$BASE_URL/api/version" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p') at $BASE_URL"
    # Nothing outside this machine may reach the model server.
    port=$(listen_addr); port=${port##*:}
    if command -v ss >/dev/null 2>&1; then
      exposed=$(ss -Hltn "sport = :$port" 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]:|\[::ffff:127\.)' || true)
      if [ -n "$exposed" ]; then
        echo "WARNING: port $port is open to the network ($exposed). Restart it with scripts/llm.sh serve, which listens on 127.0.0.1 only." >&2
      else
        echo "Listen: 127.0.0.1:$port only (not reachable from other machines)"
      fi
    fi
    if ! curl -fsS "$BASE_URL/api/show" -d "{\"model\":\"$MODEL\"}" >/dev/null 2>&1; then
      die "model $MODEL is not downloaded: run scripts/llm.sh pull"
    fi
    echo "Model:  $MODEL"
    echo "Asking it for one sentence (the first answer loads the model, which can take a minute)..."
    curl -fsS "$BASE_URL/api/chat" -d "{\"model\":\"$MODEL\",\"stream\":false,\"keep_alive\":0,\"messages\":[{\"role\":\"user\",\"content\":\"請用一句臺灣繁體中文回答：會議紀錄的重點是什麼？\"}]}" |
      sed -n 's/.*"content":"\([^"]*\)".*/\1/p' | sed 's/\\n/ /g'
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
