"""How fast this machine separates speakers on the CPU (sherpa-onnx).

    scripts/worker.sh bench                        # 1 thread, 5 minutes of sample speech
    scripts/worker.sh bench --threads 1,2,4        # compare thread counts
    scripts/worker.sh bench meeting.m4a            # your own recording (any length)

Without a file it uses sherpa-onnx's 4-speaker Mandarin sample (57 s,
downloaded once into the model folder and checked against a pinned SHA-256),
repeated to --minutes. Speaker counts on that repeated audio mean little: it
measures speed. On your own recording it also shows how many speakers were found.
"""

from __future__ import annotations

import os
import platform
import time
from pathlib import Path
from typing import List, Optional

import numpy as np

from . import audio
from .onnx_diarize import OnnxDiarizer
from .onnx_voice import OnnxVoiceEmbedder, ensure_model

SAMPLE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav"
SAMPLE_SHA256 = "bedf036caed208386c67b4ef4b11f83d74dd0d420b102163a1c33cd09cde7010"
SAMPLE_FILE = "bench-0-four-speakers-zh.wav"


def cpu_name() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def parse_threads(spec: str) -> List[int]:
    out = []
    for part in spec.split(","):
        part = part.strip()
        if part:
            n = int(part)
            if n < 1:
                raise ValueError("thread counts must be at least 1")
            out.append(n)
    return out or [1]


def run_bench(model_dir: Path, path: Optional[str], threads: List[int], minutes: float, printer=print) -> List[dict]:
    if path:
        source = Path(path)
        wav = audio.decode_pcm(str(source))
        label = f"{source.name} ({len(wav) / audio.SAMPLE_RATE / 60:.1f} min)"
    else:
        sample = ensure_model(model_dir, url=SAMPLE_URL, sha256=SAMPLE_SHA256, filename=SAMPLE_FILE)
        one = audio.decode_pcm(str(sample))
        reps = max(1, int(round(minutes * 60 * audio.SAMPLE_RATE / len(one))))
        wav = np.tile(one, reps)
        label = f"4-speaker Mandarin sample x{reps} ({len(wav) / audio.SAMPLE_RATE / 60:.1f} min)"
    seconds = len(wav) / audio.SAMPLE_RATE
    embedder = OnnxVoiceEmbedder(model_dir)
    OnnxDiarizer(model_dir, embedder).load()  # download outside the timing

    printer(f"CPU:   {cpu_name()} ({os.cpu_count()} logical cores)")
    printer(f"Audio: {label}")
    printer("")
    printer(f"{'threads':>7}  {'time':>8}  {'x real time':>11}  {'CPU min per audio hour':>22}  {'speakers':>8}")
    results = []
    for n in threads:
        diarizer = OnnxDiarizer(model_dir, OnnxVoiceEmbedder(model_dir, threads=n), threads=n)
        t0 = time.perf_counter()
        turns = diarizer.run(wav, audio.SAMPLE_RATE)
        elapsed = time.perf_counter() - t0
        rtf = elapsed / seconds
        speakers = len({t[2] for t in turns})
        results.append({"threads": n, "seconds": elapsed, "rtf": rtf, "speakers": speakers})
        printer(f"{n:>7}  {elapsed:>7.1f}s  {rtf:>11.3f}  {rtf * 60:>19.1f} min  {speakers if path else '-':>8}")
    printer("")
    printer("Time is wall-clock for speaker separation and its embeddings; voice fingerprints add a few seconds per speaker.")
    best = min(results, key=lambda r: r["rtf"])
    printer(f"A one-hour meeting would take about {best['rtf'] * 60:.0f} minutes with {best['threads']} thread(s) (DIARIZATION_CPU_THREADS).")
    return results
