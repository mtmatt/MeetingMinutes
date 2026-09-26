#!/usr/bin/env bash
# Run one transcription worker per GPU.
#
#   scripts/worker.sh           one worker per GPU (WORKER_GPUS in .env, or all GPUs)
#   scripts/worker.sh check     load the models once (downloads them) and report
#   scripts/worker.sh transcribe FILE [--language auto] [--no-diarize]
#
# Idle workers hold no GPU memory: models are loaded in a child process only
# while jobs are being processed.
set -euo pipefail
cd "$(dirname "$0")/.."
# .env holds secrets (worker token, HF token): readable by this user only.
if [ -f .env ] && [ -n "$(find .env -perm /077 2>/dev/null)" ]; then
  chmod go-rwx .env && echo "==> Restricted .env to this user (it holds secrets)"
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

cd "$ROOT/worker"
if [ "${1:-run}" != "run" ]; then
  export CUDA_VISIBLE_DEVICES=${GPUS%%,*}
  exec uv run --no-sync python -m mm_worker "$@"
fi

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait
}
trap cleanup INT TERM

IFS=',' read -ra LIST <<<"$GPUS"
for gpu in "${LIST[@]}"; do
  gpu=$(echo "$gpu" | tr -d ' ')
  echo "starting worker on GPU $gpu"
  CUDA_VISIBLE_DEVICES=$gpu uv run --no-sync python -m mm_worker run &
  pids+=("$!")
done
wait
