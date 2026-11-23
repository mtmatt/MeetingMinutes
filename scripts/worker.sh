#!/usr/bin/env bash
# Run the transcription worker for this machine's GPUs.
#
#   scripts/worker.sh           one worker for the GPUs in WORKER_GPUS (.env), or all GPUs
#   scripts/worker.sh check     load the models once (downloads them) and report
#   scripts/worker.sh transcribe FILE [--language auto] [--no-diarize]
#   scripts/worker.sh bench [FILE] [--threads 1,2,4]   time speaker separation on the CPU
#   scripts/worker.sh enroll URL CODE   connect this machine to a server (code from Admin -> System)
#
# Idle workers hold no GPU memory: models are loaded in a child process only
# while jobs are being processed.
#
# The worker runs at low CPU priority (nice 10), so the web server on the same
# machine stays responsive while a recording is decoded or its speakers are
# separated on the CPU. WORKER_NICE (the environment, or .env) changes the
# niceness; 0 runs it without nice.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(id -u)" = 0 ]; then
  echo "warning: the worker is running as root; a dedicated user is safer (README, \"Running as a normal user\": scripts/setup-user.sh)" >&2
fi
# .env holds secrets (worker token, HF token): readable by this user only.
# (find -perm /077 is GNU; on macOS the test is skipped and chmod is simply applied.)
if [ -f .env ] && [ -n "$(find .env -perm /077 2>/dev/null)" ]; then
  chmod go-rwx .env && echo "==> Restricted .env to this user (it holds secrets)"
elif [ -f .env ]; then
  chmod go-rwx .env 2>/dev/null || true
fi
export PATH="$HOME/.local/bin:$PATH"
ROOT=$PWD

GPUS=$(grep -E '^WORKER_GPUS=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
GPUS=${WORKER_GPUS:-$GPUS}
if [ -z "$GPUS" ]; then
  if command -v nvidia-smi >/dev/null 2>&1; then
    GPUS=$(nvidia-smi --query-gpu=index --format=csv,noheader | paste -sd, -)
  fi
  GPUS=${GPUS:-0}
fi

NICENESS=$(grep -E '^WORKER_NICE=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)
NICENESS=${WORKER_NICE:-${NICENESS:-10}}
case "$NICENESS" in
  0) NICE=() ;;
  [1-9] | 1[0-9]) NICE=(nice -n "$NICENESS") ;;
  *) echo "WORKER_NICE must be a number from 0 (no nice) to 19 (lowest priority), got \"$NICENESS\"" >&2; exit 2 ;;
esac
if [ ${#NICE[@]} -gt 0 ] && ! command -v nice >/dev/null 2>&1; then
  echo "warning: nice not found; running the worker at normal priority" >&2
  NICE=()
fi

cd "$ROOT/worker"
# GPU numbers are nvidia-smi's, so CUDA has to count GPUs the same way.
export CUDA_DEVICE_ORDER=${CUDA_DEVICE_ORDER:-PCI_BUS_ID}
# The environment scripts/install.sh made; uv is needed only to create it.
if [ -x .venv/bin/python ]; then
  PY=(.venv/bin/python)
elif command -v uv >/dev/null 2>&1; then
  PY=(uv run --no-sync python)
else
  echo "worker/.venv is missing and uv is not installed: run scripts/install.sh first" >&2
  exit 1
fi
if [ "${1:-run}" != "run" ]; then
  export CUDA_VISIBLE_DEVICES=${GPUS%%,*}
  exec ${NICE[@]+"${NICE[@]}"} "${PY[@]}" -m mm_worker "$@"
fi

# One process for all of them: before each GPU session it picks the GPU with the
# most free memory (MIN_FREE_VRAM_GB), and each GPU still appears as its own worker.
echo "starting worker on GPUs $GPUS${NICE[*]+ (${NICE[*]})}"
# ${NICE[@]+…}: bash 3.2 (macOS) treats an empty array as unset under `set -u`.
WORKER_GPUS=$(echo "$GPUS" | tr -d ' ') exec ${NICE[@]+"${NICE[@]}"} "${PY[@]}" -m mm_worker run
