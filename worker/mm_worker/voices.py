"""Voice fingerprints: one speaker embedding per speaker of a meeting.

The backend compares them with the voices people have named before, so a
recurring participant is recognised in new recordings. Both new transcriptions
and older meetings (from their stored transcript) go through the same steps
here, so their fingerprints are comparable:

    speaker's speech -> windows of up to 10 s -> one embedding per window
    -> length-weighted mean of the unit vectors -> unit vector

Only numpy here; the embedding model itself lives in the diarizer.
"""

from __future__ import annotations

from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

Span = Tuple[float, float]

# Embedding windows: as long as pyannote's own chunks, never shorter than a
# second (shorter crops give unreliable embeddings), and at most this many per
# speaker, the longest first, which bounds the work for long meetings.
WINDOW_SEC = 10.0
MIN_WINDOW_SEC = 1.0
MAX_WINDOWS = 48


def spans_by_speaker(turns: Iterable[Tuple[float, float, Optional[str]]]) -> Dict[str, List[Span]]:
    out: Dict[str, List[Span]] = {}
    for start, end, speaker in turns:
        if speaker and end > start:
            out.setdefault(speaker, []).append((float(start), float(end)))
    return out


def speech_seconds(spans: Sequence[Span]) -> float:
    return float(sum(max(0.0, e - s) for s, e in spans))


def windows(spans: Sequence[Span], window: float = WINDOW_SEC, min_len: float = MIN_WINDOW_SEC, limit: int = MAX_WINDOWS) -> List[Span]:
    """Cut a speaker's speech into windows for embedding, longest first."""
    # Adjacent turns (a pause shorter than 0.25 s) are one stretch of speech.
    merged: List[List[float]] = []
    for s, e in sorted(spans):
        if merged and s - merged[-1][1] < 0.25:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    out: List[Span] = []
    for s, e in merged:
        n = int(np.ceil((e - s) / window)) if e > s else 0
        if n == 0:
            continue
        # Equal pieces, so a 12 s turn becomes 2 x 6 s rather than 10 s + 2 s.
        step = (e - s) / n
        out.extend((s + i * step, s + (i + 1) * step) for i in range(n))
    out = [w for w in out if w[1] - w[0] >= min_len]
    out.sort(key=lambda w: w[0] - w[1])
    return sorted(out[:limit])


def combine(embeddings: np.ndarray, weights: Sequence[float]) -> Optional[np.ndarray]:
    """Length-weighted mean direction of window embeddings; None if none is usable."""
    emb = np.asarray(embeddings, dtype=np.float64)
    if emb.ndim != 2 or not len(emb):
        return None
    w = np.asarray(weights, dtype=np.float64)
    norms = np.linalg.norm(emb, axis=1)
    ok = np.isfinite(emb).all(axis=1) & np.isfinite(norms) & (norms > 1e-8)
    if not ok.any():
        return None
    unit = emb[ok] / norms[ok, None]
    mean = (unit * w[ok, None]).sum(axis=0)
    n = np.linalg.norm(mean)
    return (mean / n).astype(np.float32) if n > 1e-8 else None


def fingerprints(
    wav: np.ndarray,
    sr: int,
    spans: Dict[str, List[Span]],
    embed: Callable[[List[np.ndarray]], np.ndarray],
    progress: Optional[Callable[[float], None]] = None,
) -> Dict[str, dict]:
    """speaker -> {"embedding": [...], "speechSec": s}, for speakers with enough clean speech.

    ``embed`` turns a list of mono clips into an (n, dimension) array, NaN rows
    for clips it cannot embed.
    """
    out: Dict[str, dict] = {}
    items = list(spans.items())
    for i, (speaker, sp) in enumerate(items):
        ws = windows(sp)
        if ws:
            clips = [wav[int(s * sr) : int(e * sr)] for s, e in ws]
            vec = combine(embed(clips), [e - s for s, e in ws])
            if vec is not None:
                out[speaker] = {
                    "embedding": [round(float(x), 6) for x in vec],
                    "speechSec": round(speech_seconds(sp), 2),
                }
        if progress:
            progress((i + 1) / len(items))
    return out
