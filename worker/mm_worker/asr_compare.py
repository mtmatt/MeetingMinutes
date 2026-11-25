"""Compare speech recognition models on transcripts people corrected by hand.

    scripts/worker.sh compare-asr DIR [--models qwen,breeze25] [--out DIR] ...

DIR comes from the server (``bun run admin export-asr-eval DIR``): one folder per
meeting, with the recording and reference.json. Every segment someone edited on
the site is a reference: its audio span is given to each model, and the model's
text is scored against the corrected text. Unedited segments are the old
model's own output, so they are left out (``--include-unedited`` scores them
too, which only measures agreement with Qwen3-ASR).

The score is the mixed error rate (MER) used for Chinese-English speech: each
Chinese character, and each English word or number, is one unit; MER is the
substitutions, deletions and insertions needed to turn the model's text into
the reference, over the reference's units. Both sides are put in Taiwan
Traditional script, half-width, lower case, without punctuation or spaces, so
only the words count. Speed is the time spent transcribing (loading excluded)
per hour of audio. Models are loaded one at a time, so only one is in GPU
memory at once.
"""

from __future__ import annotations

import csv
import gc
import json
import logging
import re
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import audio, textnorm

log = logging.getLogger("mm_worker.asr_compare")

SR = 16000
# Whisper reads at most 30 s at a time; shorter than this is mostly noise.
MAX_CLIP_SEC = 30.0
MIN_CLIP_SEC = 0.3

# Short names for models; any Hugging Face Whisper model works as "whisper:<repo>".
WHISPER_MODELS = {
    "breeze25": "MediaTek-Research/Breeze-ASR-25",
    "breeze26": "MediaTek-Research/Breeze-ASR-26",
    "whisper-v2": "openai/whisper-large-v2",
    "whisper-v3": "openai/whisper-large-v3",
}

_CJK = "㐀-䶿一-鿿豈-﫿"
_UNITS = re.compile(rf"[{_CJK}]|[a-z0-9]+(?:'[a-z]+)*")


def units(text: str) -> List[str]:
    """Scoring units: each Chinese character, each English word or number, in Taiwan Traditional, lower case."""
    t = textnorm.convert_script(text or "", "zh-TW")
    t = unicodedata.normalize("NFKC", t).lower()
    return _UNITS.findall(t)


@dataclass
class Errors:
    substitutions: int = 0
    deletions: int = 0
    insertions: int = 0
    reference: int = 0

    @property
    def total(self) -> int:
        return self.substitutions + self.deletions + self.insertions

    @property
    def mer(self) -> float:
        return self.total / self.reference if self.reference else (0.0 if self.total == 0 else 1.0)

    def __add__(self, o: "Errors") -> "Errors":
        return Errors(self.substitutions + o.substitutions, self.deletions + o.deletions, self.insertions + o.insertions, self.reference + o.reference)


def align(ref: Sequence[str], hyp: Sequence[str]) -> Errors:
    """Edit distance between two unit sequences, split into substitutions, deletions and insertions."""
    n, m = len(ref), len(hyp)
    # Each cell: (cost, substitutions, deletions, insertions); ties prefer substitutions, as scoring tools do.
    prev = [(j, 0, 0, j) for j in range(m + 1)]
    for i in range(1, n + 1):
        cur = [(i, 0, i, 0)] + [None] * m  # type: ignore[list-item]
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur[j] = prev[j - 1]
                continue
            c, s, d, ins = prev[j - 1]
            best = (c + 1, s + 1, d, ins)
            c, s, d, ins = prev[j]
            if c + 1 < best[0]:
                best = (c + 1, s, d + 1, ins)
            c, s, d, ins = cur[j - 1]
            if c + 1 < best[0]:
                best = (c + 1, s, d, ins + 1)
            cur[j] = best
        prev = cur
    _, s, d, ins = prev[m]
    return Errors(s, d, ins, n)


# ---------------------------------------------------------------- data


@dataclass
class Clip:
    meeting: str
    title: str
    start: float
    end: float
    speaker: Optional[str]
    reference: str
    audio: np.ndarray
    context: str
    script: str


@dataclass
class EvalSet:
    clips: List[Clip]
    meetings: int
    skipped: Dict[str, int] = field(default_factory=dict)


def load_eval_set(root: Path, include_unedited: bool = False, limit: Optional[int] = None) -> EvalSet:
    """Every meeting folder under ``root`` (or ``root`` itself) with a reference.json."""
    refs = sorted(root.glob("*/reference.json")) or ([root / "reference.json"] if (root / "reference.json").exists() else [])
    if not refs:
        raise SystemExit(f"No reference.json under {root}. Make the folder on the server: bun run admin export-asr-eval <dir>")
    clips: List[Clip] = []
    skipped = {"unedited": 0, "too short": 0, "too long": 0, "empty reference": 0}
    for ref_path in refs:
        ref = json.loads(ref_path.read_text(encoding="utf-8"))
        wanted = [s for s in ref["segments"] if include_unedited or s.get("edited")]
        skipped["unedited"] += len(ref["segments"]) - len(wanted)
        if not wanted:
            continue
        wav = audio.decode_pcm(str(ref_path.parent / ref["audio"]))
        for s in wanted:
            dur = float(s["end"]) - float(s["start"])
            if not units(s["text"]):
                skipped["empty reference"] += 1
            elif dur < MIN_CLIP_SEC:
                skipped["too short"] += 1
            elif dur > MAX_CLIP_SEC:
                skipped["too long"] += 1
            else:
                a, b = int(float(s["start"]) * SR), int(float(s["end"]) * SR)
                clips.append(
                    Clip(ref["meetingId"], ref.get("title", ""), float(s["start"]), float(s["end"]), s.get("speaker"), s["text"], wav[a:b].copy(),
                         ref.get("vocabulary", ""), ref.get("script", "zh-TW"))
                )  # fmt: skip
            if limit and len(clips) >= limit:
                return EvalSet(clips, len({c.meeting for c in clips}), skipped)
    return EvalSet(clips, len({c.meeting for c in clips}), skipped)


# ---------------------------------------------------------------- models


class WhisperModel:
    """A Whisper-architecture model from Hugging Face (Breeze ASR 25/26, Whisper large), transcribing clips of up to 30 s in batches."""

    def __init__(self, repo: str, device: str, dtype: Optional[str] = None, batch_size: int = 8, language: Optional[str] = None):
        self.repo = repo
        self.device = device
        self.dtype_name = dtype
        self.batch_size = max(1, batch_size)
        self.language = language
        self._model = None
        self._processor = None
        self._prompts = True

    def load(self):
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        # Half precision on NVIDIA; full on Apple GPUs and CPUs, where half is slower or less stable.
        name = self.dtype_name or ("float16" if self.device.startswith("cuda") else "float32")
        self._dtype = getattr(torch, name)
        self._processor = WhisperProcessor.from_pretrained(self.repo)
        self._model = WhisperForConditionalGeneration.from_pretrained(self.repo, torch_dtype=self._dtype).to(self.device).eval()
        return self

    def transcribe(self, clips: Sequence[np.ndarray], sr: int, context: str = "", language: Optional[str] = None, progress=None) -> List[Tuple[str, str]]:
        import torch

        out: List[Tuple[str, str]] = []
        for i in range(0, len(clips), self.batch_size):
            batch = [np.ascontiguousarray(c, dtype=np.float32) for c in clips[i : i + self.batch_size]]
            feats = self._processor(batch, sampling_rate=sr, return_tensors="pt").input_features.to(self.device, self._dtype)
            kwargs = {"task": "transcribe", "max_new_tokens": 440}
            if self.language:
                kwargs["language"] = self.language
            prompt = None
            if context and self._prompts:
                prompt = self._processor.get_prompt_ids(context, return_tensors="pt").to(self.device)
            with torch.inference_mode():
                try:
                    ids = self._model.generate(feats, prompt_ids=prompt, **kwargs) if prompt is not None else self._model.generate(feats, **kwargs)
                except Exception as e:  # older transformers: no prompt with a batch
                    if prompt is None:
                        raise
                    log.warning("%s: the vocabulary cannot be given as a prompt here (%s); continuing without it", self.repo, e)
                    self._prompts = False
                    ids = self._model.generate(feats, **kwargs)
            texts = self._processor.batch_decode(ids, skip_special_tokens=True)
            if prompt is not None and self._prompts:
                # Some versions return the prompt in front of the text.
                texts = [t[len(context) :].lstrip() if t.startswith(context) else t for t in texts]
            out.extend(("", t.strip()) for t in texts)
            if progress:
                progress(min(1.0, (i + len(batch)) / len(clips)))
        return out


def free_gpu_memory():
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if getattr(torch, "mps", None) is not None and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass


# ---------------------------------------------------------------- comparison


@dataclass
class ModelResult:
    name: str
    label: str
    errors: Errors
    seconds: float
    load_seconds: float
    hypotheses: List[str]
    per_clip: List[Errors]


def run_model(name: str, label: str, loader: Callable[[], object], data: EvalSet, use_context: bool = True) -> ModelResult:
    t0 = time.perf_counter()
    model = loader()
    loaded = time.perf_counter() - t0
    log.info("%s loaded in %.0fs; transcribing %d clips", label, loaded, len(data.clips))
    hyps: List[str] = [""] * len(data.clips)
    spent = 0.0
    # Clips of one meeting share its vocabulary, so they go together.
    groups: Dict[Tuple[str, str], List[int]] = {}
    for i, c in enumerate(data.clips):
        groups.setdefault((c.context if use_context else "", c.script), []).append(i)
    for (context, script), idx in groups.items():
        t = time.perf_counter()
        results = model.transcribe([data.clips[i].audio for i in idx], SR, context=context, language=None)
        spent += time.perf_counter() - t
        for i, (_lang, text) in zip(idx, results):
            # What the pipeline does to every model's text: script conversion and cleanup.
            hyps[i] = textnorm.normalize(text, script)
    per_clip = [align(units(c.reference), units(h)) for c, h in zip(data.clips, hyps)]
    total = sum(per_clip, Errors())
    del model
    free_gpu_memory()
    return ModelResult(name, label, total, spent, loaded, hyps, per_clip)


def audio_seconds(data: EvalSet) -> float:
    return sum(c.end - c.start for c in data.clips)


def report(data: EvalSet, results: List[ModelResult], out_dir: Path, show: int = 10) -> str:
    """Write summary.json and segments.csv, and return the text report."""
    out_dir.mkdir(parents=True, exist_ok=True)
    secs = audio_seconds(data)
    lines = [
        f"{len(data.clips)} corrected segments from {data.meetings} meeting(s), {secs / 60:.1f} minutes of speech",
        f"(left out: {', '.join(f'{v} {k}' for k, v in data.skipped.items() if v) or 'none'})",
        "",
        f"{'model':<34} {'MER':>7} {'subst':>6} {'del':>6} {'ins':>6}   {'min per audio hour':>18}   load",
    ]
    for r in results:
        e = r.errors
        per_hour = r.seconds / secs * 60 if secs else 0.0
        lines.append(f"{r.label:<34} {e.mer * 100:6.2f}% {e.substitutions:6d} {e.deletions:6d} {e.insertions:6d}   {per_hour:18.1f}   {r.load_seconds:.0f}s")
    if len(results) >= 2:
        a, b = results[0], results[1]
        wins = sum(1 for x, y in zip(a.per_clip, b.per_clip) if x.total < y.total)
        losses = sum(1 for x, y in zip(a.per_clip, b.per_clip) if x.total > y.total)
        lines += ["", f"Per segment: {a.label} better on {wins}, {b.label} better on {losses}, equal on {len(data.clips) - wins - losses}."]
        diffs = sorted(range(len(data.clips)), key=lambda i: -abs(a.per_clip[i].total - b.per_clip[i].total))[:show]
        if diffs and show:
            lines += ["", f"Largest differences ({a.label} vs {b.label}):"]
            for i in diffs:
                c = data.clips[i]
                lines += [
                    "",
                    f"  [{c.meeting} {int(c.start // 3600):02d}:{int(c.start % 3600 // 60):02d}:{int(c.start % 60):02d}] {c.speaker or ''}",
                    f"    reference : {c.reference}",
                    f"    {a.name:<10}: {a.hypotheses[i]}   ({a.per_clip[i].total} errors)",
                    f"    {b.name:<10}: {b.hypotheses[i]}   ({b.per_clip[i].total} errors)",
                ]
    lines += [
        "",
        "Note: the references were corrected from Qwen3-ASR's own transcripts, so mistakes nobody fixed count as correct for it;",
        "the comparison leans towards Qwen3-ASR. Numbers written as digits by one model and as characters (三) by another count as errors.",
    ]
    text = "\n".join(lines)
    summary = {
        "segments": len(data.clips),
        "meetings": data.meetings,
        "audioSeconds": round(secs, 1),
        "skipped": data.skipped,
        "models": [
            {
                "name": r.name,
                "model": r.label,
                "mer": round(r.errors.mer, 5),
                "substitutions": r.errors.substitutions,
                "deletions": r.errors.deletions,
                "insertions": r.errors.insertions,
                "referenceUnits": r.errors.reference,
                "transcribeSeconds": round(r.seconds, 2),
                "minutesPerAudioHour": round(r.seconds / secs * 60, 2) if secs else None,
                "loadSeconds": round(r.load_seconds, 1),
            }
            for r in results
        ],
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / "report.txt").write_text(text + "\n", encoding="utf-8")
    with open(out_dir / "segments.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["meeting", "start", "end", "speaker", "reference", *[x for r in results for x in (r.name, f"{r.name} errors")]])
        for i, c in enumerate(data.clips):
            w.writerow([c.meeting, f"{c.start:.2f}", f"{c.end:.2f}", c.speaker or "", c.reference, *[x for r in results for x in (r.hypotheses[i], r.per_clip[i].total)]])
    return text


def model_loaders(names: List[str], cfg, batch_size: int, dtype: Optional[str], language: Optional[str]) -> List[Tuple[str, str, Callable[[], object]]]:
    """(short name, model id, loader) for each requested model: "qwen", "qwen:<repo>", a short Whisper name, or "whisper:<repo>"."""
    out = []
    for name in names:
        if name == "qwen" or name.startswith("qwen:"):
            from dataclasses import replace

            from .worker import load_transcriber

            repo = name.split(":", 1)[1] if ":" in name else cfg.asr_model
            c = replace(cfg, asr_model=repo)
            out.append((name, repo, lambda c=c: load_transcriber(c)))
        elif name in WHISPER_MODELS or name.startswith("whisper:"):
            repo = WHISPER_MODELS.get(name) or name.split(":", 1)[1]
            out.append((name, repo, lambda repo=repo: WhisperModel(repo, cfg.device, dtype, batch_size, language).load()))
        else:
            raise SystemExit(f"Unknown model {name!r}: use qwen, {', '.join(WHISPER_MODELS)}, qwen:<repo> or whisper:<repo>.")
    return out


def compare(cfg, root: Path, models: List[str], out: Optional[Path], include_unedited: bool, limit: Optional[int], batch_size: int,
            dtype: Optional[str], language: Optional[str], use_context: bool, show: int) -> str:  # fmt: skip
    data = load_eval_set(root, include_unedited=include_unedited, limit=limit)
    if not data.clips:
        raise SystemExit("No corrected segments to compare (see --include-unedited, or correct some transcript lines on the site and export again).")
    results = [run_model(n, label, loader, data, use_context) for n, label, loader in model_loaders(models, cfg, batch_size, dtype, language)]
    out_dir = out or root / f"results-{time.strftime('%Y%m%d-%H%M%S')}"
    text = report(data, results, out_dir, show)
    return f"{text}\n\nDetails: {out_dir}/segments.csv (every segment, every model) and summary.json"
