#!/usr/bin/env bash
set -e

PROJECT_DIR="/home/student/12/b12902033/tmp/MeetingMinutes"

# 重啟主服務 (8443)
tmux kill-session -t mm-web 2>/dev/null || true
tmux new-session -d -s mm-web -c "$PROJECT_DIR" "bash scripts/start.sh"

# 重啟 Worker（如果 worker 不吃 TLS 憑證，其實這段也可以不重啟，看你需求）
tmux kill-session -t mm-worker 2>/dev/null || true
tmux new-session -d -s mm-worker -c "$PROJECT_DIR" "bash scripts/worker.sh"

echo "MeetingMinutes restarted in tmux (mm-web, mm-worker)."
