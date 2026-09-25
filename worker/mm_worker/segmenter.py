"""Turn diarization output (or raw audio energy) into ASR-sized segments.

Everything here is pure numpy so it can be unit-tested without a GPU.

The pipeline transcribes one segment per ASR call, so segment boundaries are
also the transcript's timestamps. Segments should therefore
  * belong to a single speaker,
  * be long enough to give the ASR model context (short turns are merged), and
  * be short enough for fine-grained timestamps and bounded memory (long turns
    are split at the quietest point near the length limit).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence

import numpy as np

SAMPLE_RATE = 16000
FRAME_SEC = 0.02  # 20 ms energy frames


@dataclass
class Segment:
    start: float
    end: float
    speaker: Optional[str]

    @property
    def duration(self) -> float:
        return self.end - self.start


def frame_energy(wav: np.ndarray, sr: int = SAMPLE_RATE, frame_sec: float = FRAME_SEC) -> np.ndarray:
    """RMS energy per frame (float32)."""
    hop = max(1, int(sr * frame_sec))
    n = len(wav) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    frames = wav[: n * hop].astype(np.float32).reshape(n, hop)
    return np.sqrt(np.mean(frames * frames, axis=1) + 1e-12).astype(np.float32)


def quietest_point(energy: np.ndarray, lo_sec: float, hi_sec: float, frame_sec: float = FRAME_SEC) -> float:
    """Time (seconds) of the lowest-energy 200 ms window within [lo_sec, hi_sec]."""
    lo = max(0, int(lo_sec / frame_sec))
    hi = min(len(energy), int(hi_sec / frame_sec))
    if hi - lo < 2:
        return (lo_sec + hi_sec) / 2
    win = max(1, int(0.2 / frame_sec))
    window = energy[lo:hi]
    if len(window) > win:
        smoothed = np.convolve(window, np.ones(win, dtype=np.float32) / win, mode="same")
    else:
        smoothed = window
    return (lo + int(np.argmin(smoothed))) * frame_sec


def split_long(seg: Segment, energy: Optional[np.ndarray], max_len: float) -> List[Segment]:
    """Split a segment longer than max_len at quiet points, keeping pieces balanced."""
    if seg.duration <= max_len:
        return [seg]
    pieces: List[Segment] = []
    start = seg.start
    while seg.end - start > max_len:
        remaining = seg.end - start
        # Aim for evenly sized pieces rather than max_len + a tiny tail.
        n_left = int(np.ceil(remaining / max_len))
        target = start + remaining / n_left
        lo = max(start + max_len * 0.5, target - max_len * 0.25)
        hi = min(start + max_len, target + max_len * 0.25)
        cut = quietest_point(energy, lo, hi) if energy is not None and len(energy) else target
        cut = min(max(cut, start + 1.0), start + max_len)
        pieces.append(Segment(start, cut, seg.speaker))
        start = cut
    pieces.append(Segment(start, seg.end, seg.speaker))
    return pieces


def plan_from_turns(
    turns: Iterable[tuple[float, float, str]],
    duration: float,
    energy: Optional[np.ndarray] = None,
    max_len: float = 30.0,
    merge_gap: float = 1.0,
    min_len: float = 0.3,
    pad: float = 0.15,
) -> List[Segment]:
    """Build ASR segments from speaker turns (start, end, speaker).

    1. Drop turns shorter than ``min_len`` that are isolated (likely noise).
    2. Merge consecutive turns of the same speaker separated by < ``merge_gap``
       as long as the merged segment stays within ``max_len``.
    3. Split anything longer than ``max_len`` at quiet points.
    4. Pad each segment slightly so word onsets/offsets are not clipped,
       without overlapping neighbours.
    """
    ordered = sorted(
        (Segment(max(0.0, float(s)), min(duration, float(e)), str(spk)) for s, e, spk in turns if e > s),
        key=lambda t: t.start,
    )
    merged: List[Segment] = []
    for t in ordered:
        if merged:
            prev = merged[-1]
            same = prev.speaker == t.speaker
            gap = t.start - prev.end
            if same and gap < merge_gap and (t.end - prev.start) <= max_len:
                prev.end = max(prev.end, t.end)
                continue
            # Absorb a tiny blip from another speaker inside a continuous turn.
            if t.duration < min_len and gap < merge_gap:
                prev.end = max(prev.end, t.end)
                continue
        if t.duration < min_len:
            continue
        merged.append(Segment(t.start, t.end, t.speaker))

    out: List[Segment] = []
    for seg in merged:
        out.extend(split_long(seg, energy, max_len))
    return _pad(out, duration, pad)


def plan_without_diarization(
    wav: np.ndarray,
    sr: int = SAMPLE_RATE,
    max_len: float = 30.0,
    min_silence: float = 0.6,
    min_speech: float = 0.3,
    pad: float = 0.15,
) -> List[Segment]:
    """Energy-based speech detection followed by length-limited chunking.

    Used when diarization is disabled or unavailable. The threshold adapts to
    the recording: it sits between the noise floor (10th percentile) and the
    speech level (90th percentile) in the log domain.
    """
    duration = len(wav) / sr
    energy = frame_energy(wav, sr)
    if len(energy) == 0:
        return []
    log_e = np.log10(energy + 1e-8)
    floor, peak = np.percentile(log_e, 10), np.percentile(log_e, 90)
    if peak - floor < 0.5:
        # Flat signal: either continuous speech or silence. Decide by level.
        speech = log_e > -3.0
    else:
        speech = log_e > floor + (peak - floor) * 0.3
    regions = _mask_to_regions(speech, FRAME_SEC)
    # Close short pauses so sentences stay together.
    joined: List[List[float]] = []
    for s, e in regions:
        if joined and s - joined[-1][1] < min_silence and (e - joined[-1][0]) <= max_len:
            joined[-1][1] = e
        else:
            joined.append([s, e])
    segments = [Segment(s, e, None) for s, e in joined if e - s >= min_speech]
    out: List[Segment] = []
    for seg in segments:
        out.extend(split_long(seg, energy, max_len))
    return _pad(out, duration, pad)


def _mask_to_regions(mask: np.ndarray, frame_sec: float) -> List[tuple[float, float]]:
    regions: List[tuple[float, float]] = []
    if len(mask) == 0:
        return regions
    padded = np.concatenate([[False], mask.astype(bool), [False]])
    diff = np.diff(padded.astype(np.int8))
    starts = np.where(diff == 1)[0]
    ends = np.where(diff == -1)[0]
    for s, e in zip(starts, ends):
        regions.append((s * frame_sec, e * frame_sec))
    return regions


def _pad(segments: Sequence[Segment], duration: float, pad: float) -> List[Segment]:
    """Widen each segment by ``pad`` on both sides, never past the midpoint of the gap to a neighbour."""
    out: List[Segment] = []
    for i, seg in enumerate(segments):
        lo_limit = (segments[i - 1].end + seg.start) / 2 if i > 0 else 0.0
        hi_limit = (seg.end + segments[i + 1].start) / 2 if i + 1 < len(segments) else duration
        # When neighbours touch or overlap, the limits collapse onto the segment itself.
        start = max(0.0, min(seg.start, max(lo_limit, seg.start - pad)))
        end = min(duration, max(seg.end, min(hi_limit, seg.end + pad)))
        out.append(Segment(round(start, 3), round(end, 3), seg.speaker))
    return out


def slice_audio(wav: np.ndarray, seg: Segment, sr: int = SAMPLE_RATE) -> np.ndarray:
    return wav[int(seg.start * sr) : int(np.ceil(seg.end * sr))]
