"""End-to-end processing of one job.

Transcription: decode -> playback rendition + waveform peaks -> diarization
-> voice fingerprints -> segment planning -> batched ASR -> text
normalisation -> result.

Voiceprint (a meeting transcribed earlier): decode -> voice fingerprints of
the speakers in its stored transcript.

Model objects are injected so the orchestration can be tested with fakes.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Protocol, Sequence, Tuple

import numpy as np

from . import audio, segmenter, textnorm, voices

log = logging.getLogger("mm_worker.pipeline")

# Share of the overall progress bar allotted to each stage.
STAGES = {
    "decoding": (0.00, 0.06),
    "preparing": (0.06, 0.10),
    "diarizing": (0.10, 0.35),
    "transcribing": (0.35, 0.98),
    "finalizing": (0.98, 1.00),
}

VOICEPRINT_STAGES = {
    "decoding": (0.00, 0.50),
    "voiceprint": (0.50, 1.00),
}


class Canceled(Exception):
    pass


class DiarizerLike(Protocol):
    # Identifies the embedding model: fingerprints from different models are not comparable.
    voice_model: str

    def run(self, wav, sr, num_speakers=None, min_speakers=None, max_speakers=None, progress=None) -> List[Tuple[float, float, str]]: ...

    def embed(self, clips: List[np.ndarray], sr: int) -> np.ndarray: ...


class TranscriberLike(Protocol):
    def transcribe(self, clips: Sequence[np.ndarray], sr: int, context: str = "", language: Optional[str] = None, progress=None) -> List[Tuple[str, str]]: ...


@dataclass
class JobSpec:
    media_path: str
    out_dir: str
    options: dict


# Reporter returns False when the server says the job was canceled.
Reporter = Callable[[str, float], bool]


class Progress:
    """Maps stage-local progress to overall progress and throttles reports."""

    def __init__(self, report: Reporter, min_interval: float = 2.0, stages: Optional[dict] = None):
        self.report = report
        self.min_interval = min_interval
        self.stages = stages or STAGES
        self._last = 0.0

    def __call__(self, stage: str, frac: float, force: bool = False) -> None:
        lo, hi = self.stages[stage]
        now = time.monotonic()
        if not force and now - self._last < self.min_interval:
            return
        self._last = now
        if self.report(stage, lo + (hi - lo) * max(0.0, min(1.0, frac))) is False:
            raise Canceled()


def _language_arg(lang: str) -> Optional[str]:
    return None if not lang or lang.lower() == "auto" else lang


def _dominant_language(langs: List[str], weights: List[float]) -> Optional[str]:
    totals: dict[str, float] = {}
    for spec, w in zip(langs, weights):
        parts = [p.strip() for p in (spec or "").split(",") if p.strip()]
        for p in parts:
            totals[p] = totals.get(p, 0.0) + w / len(parts)
    if not totals:
        return None
    ranked = sorted(totals.items(), key=lambda kv: -kv[1])
    top = ranked[0][0]
    # Report code-switching when a second language has a meaningful share.
    if len(ranked) > 1 and ranked[1][1] >= 0.15 * sum(totals.values()):
        return f"{top},{ranked[1][0]}"
    return top


def _decode(media_path: str, progress: Progress, max_audio_sec: Optional[float]) -> Tuple[np.ndarray, "audio.MediaInfo"]:
    progress("decoding", 0.0, force=True)
    info = audio.probe(media_path)
    if not info.has_audio:
        raise audio.MediaError("The file has no audio track.")
    if max_audio_sec and info.duration and info.duration > max_audio_sec:
        raise audio.MediaError(f"The recording is longer than the {max_audio_sec / 3600:g}-hour limit (MAX_AUDIO_HOURS).")
    wav = audio.decode_pcm(media_path, progress=lambda f: progress("decoding", f), duration=info.duration, max_seconds=max_audio_sec)
    if len(wav) / audio.SAMPLE_RATE < 0.5:
        raise audio.MediaError("The recording is shorter than half a second.")
    return wav, info


def _fingerprints(diarizer: DiarizerLike, wav: np.ndarray, sr: int, spans: dict, progress=None, strict: bool = False) -> dict:
    """{"voiceModel": ..., "voices": {speaker: ...}}. Unless ``strict``, a failure leaves voices empty."""
    try:
        found = voices.fingerprints(wav, sr, spans, lambda clips: diarizer.embed(clips, sr), progress=progress)
    except Canceled:
        raise
    except Exception as e:
        if strict:
            raise
        # A transcript without fingerprints is still a transcript.
        log.warning("voice fingerprints failed, continuing without them: %s", e)
        found = {}
    return {"voiceModel": str(getattr(diarizer, "voice_model", "") or "unknown"), "voices": found}


def run_job(
    job: JobSpec,
    report: Reporter,
    transcriber: TranscriberLike,
    diarizer: Optional[DiarizerLike],
    max_segment_sec: float = 30.0,
    diarizer_unavailable: Optional[str] = None,
    max_audio_sec: Optional[float] = None,
) -> dict:
    """Transcribe one job. ``diarizer_unavailable`` is why there is no diarizer, if there is none."""
    opts = job.options
    out_dir = Path(job.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    progress = Progress(report)
    wav, info = _decode(job.media_path, progress, max_audio_sec)
    sr = audio.SAMPLE_RATE
    duration = len(wav) / sr
    log.info("decoded %.1fs of audio (video=%s)", duration, info.has_video)

    progress("preparing", 0.0, force=True)
    has_playback = audio.write_playback(job.media_path, out_dir / "playback.m4a")
    audio.write_peaks(wav, out_dir / "peaks.json")
    energy = segmenter.frame_energy(wav, sr)

    turns = None
    voiceprints: dict = {}
    # Recorded with the result, so a transcript without speakers says why.
    if not opts.get("diarize", True):
        diarization: dict = {"status": "off"}
    elif diarizer is None:
        diarization = {"status": "unavailable", "reason": (diarizer_unavailable or "The speaker diarization model is not loaded.")[:500]}
    else:
        diarization = {"status": "ok"}
    if opts.get("diarize", True) and diarizer is not None:
        progress("diarizing", 0.0, force=True)
        try:
            turns = diarizer.run(
                wav,
                sr,
                num_speakers=opts.get("numSpeakers"),
                min_speakers=opts.get("minSpeakers"),
                max_speakers=opts.get("maxSpeakers"),
                progress=lambda f: progress("diarizing", f),
            )
            log.info("diarization: %d turns, %d speakers", len(turns), len({t[2] for t in turns}))
            if turns:
                voiceprints = _fingerprints(diarizer, wav, sr, voices.spans_by_speaker(turns))
        except Canceled:
            raise
        except Exception as e:  # Fall back to plain transcription rather than failing the job.
            log.warning("diarization failed, continuing without speakers: %s", e)
            turns = None
            diarization = {"status": "failed", "reason": f"{type(e).__name__}: {e}"[:500]}

    if turns:
        plan = segmenter.plan_from_turns(turns, duration, energy=energy, max_len=max_segment_sec)
    else:
        plan = segmenter.plan_without_diarization(wav, sr, max_len=max_segment_sec)
    log.info("planned %d segments", len(plan))

    progress("transcribing", 0.0, force=True)
    clips = [segmenter.slice_audio(wav, s, sr) for s in plan]
    context = (opts.get("vocabulary") or "").strip()
    results = transcriber.transcribe(
        clips,
        sr,
        context=context,
        language=_language_arg(opts.get("language", "auto")),
        progress=lambda f: (progress("transcribing", f), True)[1],
    ) if clips else []

    progress("finalizing", 0.0, force=True)
    script = opts.get("script", "zh-TW")
    segments = []
    langs, weights = [], []
    for seg, (lang, text) in zip(plan, results):
        clean = textnorm.normalize(text, script)
        if not clean:
            continue
        segments.append({"start": seg.start, "end": seg.end, "speaker": seg.speaker, "text": clean})
        langs.append(lang)
        weights.append(seg.duration)

    # Speakers in order of first appearance, so "Speaker 1" talks first.
    speakers: List[str] = []
    for s in segments:
        if s["speaker"] and s["speaker"] not in speakers:
            speakers.append(s["speaker"])

    out = {
        "durationSec": round(duration, 3),
        "language": _dominant_language(langs, weights),
        "hasVideo": info.has_video,
        "hasPlayback": has_playback,
        "hasPeaks": (out_dir / "peaks.json").exists(),
        "speakers": speakers,
        "segments": segments,
        "diarization": {**diarization, "speakers": len(speakers)} if diarization["status"] == "ok" else diarization,
    }
    if voiceprints:
        out["voiceModel"] = voiceprints["voiceModel"]
        out["voices"] = {k: v for k, v in voiceprints["voices"].items() if k in speakers}
    return out


def run_voiceprint(
    job: JobSpec,
    report: Reporter,
    diarizer: Optional[DiarizerLike],
    diarizer_unavailable: Optional[str] = None,
    max_audio_sec: Optional[float] = None,
) -> dict:
    """Voice fingerprints for a meeting transcribed earlier, from the speakers in its transcript.

    ``job.options["speakers"]`` maps each speaker to the [start, end] spans
    attributed to them in the transcript (including the user's corrections).
    """
    if diarizer is None:
        raise audio.MediaError(
            "Voice fingerprints need the speaker diarization model, which is not loaded: "
            + (diarizer_unavailable or "unknown reason")
        )
    progress = Progress(report, stages=VOICEPRINT_STAGES)
    wav, _ = _decode(job.media_path, progress, max_audio_sec)
    sr = audio.SAMPLE_RATE
    duration = len(wav) / sr
    spans: dict = {}
    for speaker, given in (job.options.get("speakers") or {}).items():
        clipped = [(max(0.0, float(s)), min(duration, float(e))) for s, e in given]
        spans[str(speaker)] = [(s, e) for s, e in clipped if e > s]
    progress("voiceprint", 0.0, force=True)
    result = _fingerprints(
        diarizer, wav, sr, {k: v for k, v in spans.items() if v}, progress=lambda f: progress("voiceprint", f), strict=True
    )
    log.info("voice fingerprints for %d of %d speakers", len(result["voices"]), len(spans))
    return result
