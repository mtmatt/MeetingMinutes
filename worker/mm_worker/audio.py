"""Media handling through ffmpeg.

No system ffmpeg is required: by default we use the static binary shipped by
the ``imageio-ffmpeg`` wheel, so the worker installs without sudo. Set
FFMPEG_BIN to use a different build.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable, Optional

import numpy as np

SAMPLE_RATE = 16000


class MediaError(Exception):
    """The input file could not be decoded (not retryable)."""


@lru_cache(maxsize=1)
def ffmpeg_bin() -> str:
    explicit = os.environ.get("FFMPEG_BIN")
    if explicit:
        return explicit
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # pragma: no cover - fallback when the wheel is missing
        return "ffmpeg"


@dataclass
class MediaInfo:
    duration: Optional[float]
    has_audio: bool
    has_video: bool


_DURATION = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


# Uploaded media is untrusted: ffmpeg may only open local files, never network
# URLs or other protocols a crafted playlist could point at.
SAFE_INPUT = ["-protocol_whitelist", "file"]


def probe(path: str) -> MediaInfo:
    """Inspect streams using `ffmpeg -i` (ffprobe is not bundled with imageio-ffmpeg)."""
    proc = subprocess.run(
        [ffmpeg_bin(), "-hide_banner", "-nostdin", *SAFE_INPUT, "-i", path],
        capture_output=True,
        text=True,
        errors="replace",
    )
    info = proc.stderr
    if "Invalid data found" in info or "No such file" in info:
        raise MediaError("The file is not a readable audio or video file.")
    m = _DURATION.search(info)
    duration = None
    if m:
        h, mi, s = m.groups()
        duration = int(h) * 3600 + int(mi) * 60 + float(s)
    stream_lines = [ln for ln in info.splitlines() if re.search(r"Stream #\d+:\d+", ln)]
    has_audio = any(": Audio:" in ln for ln in stream_lines)
    # Cover art in audio files shows up as a video stream flagged attached_pic.
    has_video = any(": Video:" in ln and "attached pic" not in ln for ln in stream_lines)
    return MediaInfo(duration=duration, has_audio=has_audio, has_video=has_video)


def decode_pcm(
    path: str,
    progress: Optional[Callable[[float], None]] = None,
    duration: Optional[float] = None,
    max_seconds: Optional[float] = None,
) -> np.ndarray:
    """Decode the first audio stream to 16 kHz mono float32.

    ``max_seconds`` bounds the decoded length regardless of what the file's
    header claims, so a small crafted file cannot expand into more audio than
    fits in memory.
    """
    cmd = [
        ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        *SAFE_INPUT,
        "-i",
        path,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "f32le",
        "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    chunks: list[bytes] = []
    total = 0
    expected = int((duration or 0) * SAMPLE_RATE * 4)
    limit = int(max_seconds * SAMPLE_RATE * 4) if max_seconds else None
    while True:
        buf = proc.stdout.read(1 << 22)
        if not buf:
            break
        chunks.append(buf)
        total += len(buf)
        if limit is not None and total > limit:
            proc.kill()
            proc.wait()
            raise MediaError(f"The recording is longer than the {max_seconds / 3600:g}-hour limit (MAX_AUDIO_HOURS).")
        if progress and expected:
            progress(min(1.0, total / expected))
    stderr = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
    code = proc.wait()
    if code != 0 or total == 0:
        raise MediaError(f"Could not decode audio: {stderr.strip()[-500:] or 'no audio stream'}")
    data = b"".join(chunks)
    usable = len(data) - (len(data) % 4)
    return np.frombuffer(data[:usable], dtype=np.float32).copy()


def write_playback(src: str, dest: Path, bitrate: str = "64k") -> bool:
    """Small AAC/M4A rendition for in-browser playback and seeking."""
    tmp = dest.with_suffix(".tmp.m4a")
    cmd = [
        ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        *SAFE_INPUT,
        "-i",
        src,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        bitrate,
        "-movflags",
        "+faststart",
        str(tmp),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        return False
    os.replace(tmp, dest)
    return True


def compute_peaks(wav: np.ndarray, sr: int = SAMPLE_RATE, max_points: int = 40000, per_second: int = 20) -> dict:
    """Downsampled absolute-peak envelope for drawing a waveform (values 0-255)."""
    duration = len(wav) / sr if sr else 0.0
    if duration <= 0:
        return {"version": 1, "duration": 0.0, "pointsPerSecond": per_second, "peaks": []}
    n_points = int(min(max_points, max(1, np.ceil(duration * per_second))))
    hop = max(1, int(np.ceil(len(wav) / n_points)))
    padded = np.zeros(hop * n_points, dtype=np.float32)
    padded[: len(wav)] = np.abs(wav[: hop * n_points])
    peaks = padded.reshape(n_points, hop).max(axis=1)
    # Normalise to the 99.5th percentile so one loud click does not flatten everything.
    ref = float(np.percentile(peaks, 99.5)) or 1.0
    scaled = np.clip(peaks / ref, 0.0, 1.0)
    return {
        "version": 1,
        "duration": round(duration, 3),
        "pointsPerSecond": round(n_points / duration, 6),
        "peaks": (scaled * 255).round().astype(np.uint8).tolist(),
    }


def write_peaks(wav: np.ndarray, dest: Path) -> None:
    tmp = dest.with_suffix(".tmp")
    tmp.write_text(json.dumps(compute_peaks(wav), separators=(",", ":")))
    os.replace(tmp, dest)
