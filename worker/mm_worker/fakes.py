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
    def load(self):
        return self

    def run(self, wav, sr, num_speakers=None, min_speakers=None, max_speakers=None, progress=None):
        # Alternate two speakers over energy-detected regions.
        plan = segmenter.plan_without_diarization(wav, sr, pad=0.0)
        if progress:
            progress(1.0)
        return [(s.start, s.end, f"SPEAKER_0{i % 2}") for i, s in enumerate(plan)]
