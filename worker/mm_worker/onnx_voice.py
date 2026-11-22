"""Voice fingerprints on the CPU, without torch: sherpa-onnx with a 3D-Speaker model.

Used when speakers are separated on the CPU (onnx_diarize) or by pyannoteAI,
so a worker without a GPU, CUDA or torch still recognises people by voice. The model is
ERes2Net-base, trained on Mandarin (3D-Speaker, zh-cn), 512 dimensions; it is
downloaded once (about 40 MB) and checked against a pinned SHA-256.

Fingerprints from different models are never compared, so the backend sees
this one under its own name (VOICE_MODEL).
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import urllib.request
from pathlib import Path
from typing import List, Optional, Sequence

import numpy as np

log = logging.getLogger("mm_worker.onnx_voice")

VOICE_MODEL = "sherpa-onnx/3dspeaker-eres2net-base-zh-cn"
MODEL_FILE = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
MODEL_URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/{MODEL_FILE}"
MODEL_SHA256 = "f1ee61be04000b50392a63442e5dd9feaea7e81dddd494d3647cf1c3d88a1498"
SAMPLE_RATE = 16000
# Shorter clips give unreliable fingerprints; voices.windows never asks for less than 1 s anyway.
MIN_CLIP_SEC = 0.5


class VoiceModelUnavailable(Exception):
    """The fingerprint model could not be loaded (not installed, not downloadable)."""


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_model(
    model_dir: Path,
    url: str = MODEL_URL,
    sha256: str = MODEL_SHA256,
    opener=urllib.request.urlopen,
    filename: str = MODEL_FILE,
    member: Optional[str] = None,
    member_sha256: Optional[str] = None,
) -> Path:
    """A model file in ``model_dir``, downloaded the first time and verified.

    ``member``: the download is a .tar.bz2 archive and the model is this file in it
    (checked against ``member_sha256``); nothing else is extracted.
    """
    path = model_dir / filename
    if path.exists():
        return path
    model_dir.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".part")
    log.info("downloading %s", url.rsplit("/", 1)[-1])
    try:
        with opener(url, timeout=120) as res, open(part, "wb") as out:
            while True:
                buf = res.read(1 << 20)
                if not buf:
                    break
                out.write(buf)
        got = _sha256(part)
        if got != sha256:
            raise VoiceModelUnavailable(f"The downloaded model {url.rsplit('/', 1)[-1]} does not match its checksum ({got[:12]}…); not using it.")
        if member:
            import tarfile

            with tarfile.open(part, "r:bz2") as tar:
                info = tar.getmember(member)
                if not info.isfile():
                    raise VoiceModelUnavailable(f"{member} is not a file in {url}.")
                data = tar.extractfile(info).read()  # type: ignore[union-attr]
            if member_sha256 and hashlib.sha256(data).hexdigest() != member_sha256:
                raise VoiceModelUnavailable(f"{member} does not match its checksum; not using it.")
            part.write_bytes(data)
        os.replace(part, path)
    except VoiceModelUnavailable:
        raise
    except Exception as e:
        raise VoiceModelUnavailable(f"Could not download the model from {url}: {e}") from e
    finally:
        if part.exists():
            part.unlink()
    return path


class OnnxVoiceEmbedder:
    voice_model = VOICE_MODEL

    def __init__(self, model_dir: Path, threads: int = 2):
        self.model_dir = Path(model_dir)
        self.threads = max(1, threads)
        self._extractor = None
        self._lock = threading.Lock()

    def load(self):
        with self._lock:
            if self._extractor is not None:
                return self._extractor
            try:
                import sherpa_onnx
            except ImportError as e:
                raise VoiceModelUnavailable(f"sherpa-onnx is not installed ({e}); run scripts/install.sh again.") from e
            path = ensure_model(self.model_dir)
            config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(path), num_threads=self.threads)
            self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
            return self._extractor

    def embed(self, clips: Sequence[np.ndarray], sr: int) -> np.ndarray:
        """One fingerprint per clip; NaN rows for clips too short to fingerprint."""
        if sr != SAMPLE_RATE:
            raise ValueError(f"The voice model expects {SAMPLE_RATE} Hz audio, not {sr} Hz.")
        extractor = self.load()
        dim = int(extractor.dim)
        out: List[np.ndarray] = []
        for clip in clips:
            x = np.ascontiguousarray(clip, dtype=np.float32)
            if len(x) < MIN_CLIP_SEC * sr:
                out.append(np.full(dim, np.nan, dtype=np.float32))
                continue
            stream = extractor.create_stream()
            stream.accept_waveform(sr, x)
            stream.input_finished()
            if not extractor.is_ready(stream):
                out.append(np.full(dim, np.nan, dtype=np.float32))
                continue
            out.append(np.asarray(extractor.compute(stream), dtype=np.float32))
        return np.vstack(out) if out else np.zeros((0, dim), dtype=np.float32)


def default_model_dir(data_dir: Optional[Path]) -> Path:
    explicit = os.environ.get("MM_MODEL_DIR", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    return (data_dir or Path("data")) / "models"
