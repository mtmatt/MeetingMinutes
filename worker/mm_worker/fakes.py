"""Stand-in models for development and tests (ASR_BACKEND=fake).

They exercise the full pipeline, including GPU-session lifecycle, without
torch or a GPU. The transcript simply describes each segment.
"""

from __future__ import annotations

import time
from typing import List, Optional, Sequence, Tuple

import numpy as np

from . import segmenter


class FakeTranscriber:
    def __init__(self, load_seconds: float = 0.0):
        self.load_seconds = load_seconds

    def load(self):
        time.sleep(self.load_seconds)
        return self

    def transcribe(self, clips: Sequence[np.ndarray], sr: int, context: str = "", language: Optional[str] = None, progress=None) -> List[Tuple[str, str]]:
        out = []
        for i, c in enumerate(clips):
            out.append(("Chinese", f"（示範逐字稿）第 {i + 1} 段，長度 {len(c) / sr:.1f} 秒。"))
            if progress and progress((i + 1) / len(clips)) is False:
                raise InterruptedError("canceled")
        return out


class FakeDiarizer:
    voice_model = "fake"

    def load(self):
        return self

    def run(self, wav, sr, num_speakers=None, min_speakers=None, max_speakers=None, progress=None):
        # Alternate two speakers over energy-detected regions.
        plan = segmenter.plan_without_diarization(wav, sr, pad=0.0)
        if progress:
            progress(1.0)
        return [(s.start, s.end, f"SPEAKER_0{i % 2}") for i, s in enumerate(plan)]

    def embed(self, clips: Sequence[np.ndarray], sr: int) -> np.ndarray:
        # A crude "voice": the clip's spectral envelope in 16 bands. The same
        # recording, or the same test tone, gives the same fingerprint, however
        # the clip is cut: the window and the floor keep spectral leakage into
        # near-empty bands (which depends on the cut) from dominating.
        edges = np.geomspace(80, min(4000, sr / 2), 17)
        out = []
        for c in clips:
            x = np.asarray(c, dtype=np.float64)
            spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
            freqs = np.fft.rfftfreq(len(x), 1 / sr)
            bands = np.asarray([spectrum[(freqs >= lo) & (freqs < hi)].sum() for lo, hi in zip(edges[:-1], edges[1:])])
            v = np.log(np.maximum(bands / (bands.sum() + 1e-12), 1e-3))
            out.append(v - v.mean())
        return np.asarray(out, dtype=np.float32).reshape(len(out), 16)
