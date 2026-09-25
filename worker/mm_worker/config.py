"""Worker configuration from environment variables (and the repo-level .env)."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _int(name: str, default: Optional[int]) -> Optional[int]:
    v = os.environ.get(name, "")
    return int(v) if v.strip() else default


def _float(name: str, default: float) -> float:
    v = os.environ.get(name, "")
    return float(v) if v.strip() else default


@dataclass
class WorkerConfig:
    server_url: str
    token: str
    worker_id: str
    worker_name: str
    device: str
    hf_token: Optional[str]
    asr_model: str
    asr_backend: str
    asr_batch_size: int
    asr_max_new_tokens: int
    diarization_model: str
    max_segment_sec: float
    poll_interval: float
    # Seconds a GPU session waits for another job before exiting. 0 releases
    # the GPU as soon as the queue is empty.
    model_keepalive_sec: float
    extra: dict = field(default_factory=dict)


def load_config() -> WorkerConfig:
    if os.environ.get("MM_SKIP_DOTENV") != "1":
        _load_dotenv(REPO_ROOT / ".env")

    data_dir = Path(os.environ.get("DATA_DIR", "data"))
    if not data_dir.is_absolute():
        data_dir = REPO_ROOT / data_dir
    token = os.environ.get("WORKER_TOKEN", "").strip()
    if not token:
        token_file = data_dir / "worker.token"
        if token_file.exists():
            token = token_file.read_text().strip()
    if not token:
        raise SystemExit(
            "No worker token. Start the backend once (it creates data/worker.token) or set WORKER_TOKEN."
        )

    port = os.environ.get("PORT", "8787")
    server_url = os.environ.get("MM_SERVER_URL", f"http://127.0.0.1:{port}").rstrip("/")
    gpu = os.environ.get("CUDA_VISIBLE_DEVICES", "0").split(",")[0] or "0"
    host = socket.gethostname()
    worker_id = os.environ.get("MM_WORKER_ID") or f"{host}-gpu{gpu}"

    return WorkerConfig(
        server_url=server_url,
        token=token,
        worker_id=worker_id,
        worker_name=os.environ.get("MM_WORKER_NAME") or worker_id,
        device=os.environ.get("MM_DEVICE", "cuda:0"),
        hf_token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN") or None,
        asr_model=os.environ.get("ASR_MODEL", "Qwen/Qwen3-ASR-1.7B"),
        asr_backend=os.environ.get("ASR_BACKEND", "transformers"),
        asr_batch_size=_int("ASR_BATCH_SIZE", 16) or 16,
        asr_max_new_tokens=_int("ASR_MAX_NEW_TOKENS", 512) or 512,
        diarization_model=os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1"),
        max_segment_sec=_float("MAX_SEGMENT_SEC", 30.0),
        poll_interval=_float("MM_POLL_INTERVAL", 3.0),
        model_keepalive_sec=max(0.0, _float("MODEL_KEEPALIVE_SEC", 0.0)),
    )
