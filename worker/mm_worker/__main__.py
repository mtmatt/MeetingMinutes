"""Worker entry point.

    python -m mm_worker run            poll the backend; load models on demand per job (default)
    python -m mm_worker check          load both models once and print environment info
    python -m mm_worker transcribe F   transcribe a local file and print the transcript
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import tempfile
import time
from typing import Optional

from .config import WorkerConfig, load_config
from .pipeline import JobSpec, run_job
from .worker import Supervisor, build_models, gpu_info


def cmd_run(cfg: WorkerConfig):
    sup = Supervisor(cfg)
    signal.signal(signal.SIGTERM, sup.shutdown)
    signal.signal(signal.SIGINT, sup.shutdown)
    sup.run()


def cmd_check(cfg: WorkerConfig):
    print(json.dumps({"serverUrl": cfg.server_url, "workerId": cfg.worker_id, **gpu_info()}, indent=2))
    t0 = time.monotonic()
    _, diarizer = build_models(cfg)
    print(f"ASR model loaded: {cfg.asr_model} ({time.monotonic() - t0:.1f}s including diarization)")
    print(f"Diarization: {'ready' if diarizer else 'UNAVAILABLE (set HF_TOKEN and accept the model terms)'}")
    print(json.dumps(gpu_info(), indent=2))


def cmd_transcribe(cfg: WorkerConfig, path: str, language: str, vocabulary: str, no_diarize: bool, script: str):
    transcriber, diarizer = build_models(cfg)
    with tempfile.TemporaryDirectory() as out:
        t0 = time.monotonic()
        result = run_job(
            JobSpec(path, out, {"language": language, "diarize": not no_diarize, "vocabulary": vocabulary, "script": script}),
            report=lambda stage, p: (print(f"\r{stage:<13} {p * 100:5.1f}%", end="", file=sys.stderr), True)[1],
            transcriber=transcriber,
            diarizer=diarizer,
            max_segment_sec=cfg.max_segment_sec,
        )
        elapsed = time.monotonic() - t0
    print(file=sys.stderr)
    names = {k: f"Speaker {i + 1}" for i, k in enumerate(result["speakers"])}
    for s in result["segments"]:
        m, sec = divmod(int(s["start"]), 60)
        h, m = divmod(m, 60)
        who = f"{names[s['speaker']]}: " if s["speaker"] else ""
        print(f"[{h:02d}:{m:02d}:{sec:02d}] {who}{s['text']}")
    rtf = elapsed / max(1e-6, result["durationSec"])
    print(
        f"\n{result['durationSec']:.0f}s of audio in {elapsed:.0f}s (real-time factor {rtf:.3f}), language {result['language']}",
        file=sys.stderr,
    )


def main(argv: Optional[list[str]] = None):
    parser = argparse.ArgumentParser(prog="mm-worker", description="MeetingMinutes GPU transcription worker")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("run", help="process jobs from the backend (default)")
    sub.add_parser("check", help="load models and print environment info")
    t = sub.add_parser("transcribe", help="transcribe a local file")
    t.add_argument("path")
    t.add_argument("--language", default="auto")
    t.add_argument("--vocabulary", default="")
    t.add_argument("--no-diarize", action="store_true")
    t.add_argument("--script", default="zh-TW", choices=["zh-TW", "zh-CN", "none"])
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.cmd == "transcribe":
        os.environ.setdefault("WORKER_TOKEN", "unused")
        cfg = load_config()
        cmd_transcribe(cfg, args.path, args.language, args.vocabulary, args.no_diarize, args.script)
        return
    cfg = load_config()
    if args.cmd == "check":
        cmd_check(cfg)
    else:
        cmd_run(cfg)


if __name__ == "__main__":
    main()
