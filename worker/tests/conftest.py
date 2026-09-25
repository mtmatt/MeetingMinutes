import subprocess
from pathlib import Path

import numpy as np
import pytest

from mm_worker import audio


def _ffmpeg(*args: str) -> None:
    subprocess.run([audio.ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("media")


@pytest.fixture(scope="session")
def two_speaker_wav(media_dir) -> Path:
    """3 s tone A, 1 s silence, 4 s tone B, 1 s silence, 2 s tone A (11 s total)."""
    sr = 16000

    def tone(freq, sec):
        t = np.arange(int(sr * sec)) / sr
        return (0.4 * np.sin(2 * np.pi * freq * t)).astype(np.float32)

    def silence(sec):
        return np.zeros(int(sr * sec), dtype=np.float32)

    wav = np.concatenate([tone(220, 3), silence(1), tone(440, 4), silence(1), tone(220, 2)])
    raw = media_dir / "two.f32"
    raw.write_bytes(wav.tobytes())
    out = media_dir / "two.mp3"
    _ffmpeg("-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", str(raw), "-c:a", "libmp3lame", "-b:a", "96k", str(out))
    return out


@pytest.fixture(scope="session")
def video_file(media_dir) -> Path:
    out = media_dir / "clip.mp4"
    _ffmpeg(
        "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out),
    )
    return out
