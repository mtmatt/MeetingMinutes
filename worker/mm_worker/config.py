"""Worker configuration from environment variables (and the repo-level .env)."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field, replace
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
    # Longest recording accepted, in seconds (MAX_AUDIO_HOURS); bounds decoded audio in memory.
    max_audio_sec: float = 8 * 3600
    # GPUs this worker may use (WORKER_GPUS), as nvidia-smi indices or UUIDs.
    gpus: list = field(default_factory=lambda: ["0"])
    # Free VRAM a GPU needs before a session starts on it: Qwen3-ASR-1.7B and
    # pyannote together use roughly 6-8 GB on a 4090.
    min_free_vram_gb: float = 8.0
    extra: dict = field(default_factory=dict)

    @property
    def uses_gpu(self) -> bool:
        return self.device.startswith("cuda") and self.asr_backend != "fake"

    def for_gpu(self, gpu: str) -> "WorkerConfig":
        """The worker on one of `gpus`. Its session sees only that GPU, as cuda:0.
        With several GPUs, each reports to the backend under its own ID and
        name, suffixed with the GPU."""
        device = "cuda:0" if self.device.startswith("cuda") else self.device
        if len(self.gpus) == 1:
            return replace(self, gpus=[gpu], device=device)
        return replace(
            self, gpus=[gpu], device=device, worker_id=f"{self.worker_id}-gpu{gpu}", worker_name=f"{self.worker_name}-gpu{gpu}"
        )


def _device_gpu(device: str, visible: Optional[str]) -> str:
    """The GPU that MM_DEVICE (cuda:N) means, given CUDA_VISIBLE_DEVICES."""
    if not device.startswith("cuda"):
        return "0"  # unused; it only names the worker, as it always has
    n = int(device[5:]) if device[5:].isdigit() else 0
    if visible is None:
        return str(n)
    listed = [g.strip() for g in visible.split(",") if g.strip()]
    if n >= len(listed):
        raise SystemExit(f"MM_DEVICE={device} but CUDA_VISIBLE_DEVICES={visible!r} lists {len(listed)} GPU(s); set WORKER_GPUS instead.")
    return listed[n]


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

    # With built-in HTTPS (TLS_CERT_FILE) the backend also serves the worker API
    # over plain HTTP on a loopback-only port, so no certificate is needed here.
    if os.environ.get("TLS_CERT_FILE", "").strip():
        default_url = f"http://127.0.0.1:{os.environ.get('INTERNAL_PORT', '').strip() or '8788'}"
    else:
        default_url = f"http://127.0.0.1:{os.environ.get('PORT', '').strip() or '8787'}"
    server_url = os.environ.get("MM_SERVER_URL", "").strip().rstrip("/") or default_url
    device = os.environ.get("MM_DEVICE", "cuda:0")
    # scripts/worker.sh passes every GPU in WORKER_GPUS. A worker started by
    # hand without it uses the visible GPU that MM_DEVICE names (cuda:N).
    gpus = list(dict.fromkeys(g.strip() for g in os.environ.get("WORKER_GPUS", "").split(",") if g.strip()))
    if not gpus:
        gpus = [_device_gpu(device, os.environ.get("CUDA_VISIBLE_DEVICES"))]
    host = socket.gethostname()
    # With several GPUs, WorkerConfig.for_gpu adds "-gpuN" to each one's ID.
    worker_id = os.environ.get("MM_WORKER_ID") or (host if len(gpus) > 1 else f"{host}-gpu{gpus[0]}")

    return WorkerConfig(
        server_url=server_url,
        token=token,
        worker_id=worker_id,
        worker_name=os.environ.get("MM_WORKER_NAME") or worker_id,
        device=device,
        hf_token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN") or None,
        asr_model=os.environ.get("ASR_MODEL", "Qwen/Qwen3-ASR-1.7B"),
        asr_backend=os.environ.get("ASR_BACKEND", "transformers"),
        asr_batch_size=_int("ASR_BATCH_SIZE", 16) or 16,
        asr_max_new_tokens=_int("ASR_MAX_NEW_TOKENS", 512) or 512,
        diarization_model=os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1"),
        max_segment_sec=_float("MAX_SEGMENT_SEC", 30.0),
        poll_interval=_float("MM_POLL_INTERVAL", 3.0),
        model_keepalive_sec=max(0.0, _float("MODEL_KEEPALIVE_SEC", 0.0)),
        max_audio_sec=max(0.1, _float("MAX_AUDIO_HOURS", 8.0)) * 3600,
        gpus=gpus,
        min_free_vram_gb=max(0.0, _float("MIN_FREE_VRAM_GB", 8.0)),
    )
