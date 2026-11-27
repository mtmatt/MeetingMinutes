"""Worker entry point.

    python -m mm_worker run            poll the backend; load models on demand per job (default)
    python -m mm_worker run --exit-when-idle 60   the same, exiting after a minute without work (Modal)
    python -m mm_worker check          load both models once and print environment info
    python -m mm_worker transcribe F   transcribe a local file and print the transcript
    python -m mm_worker bench [F]      time speaker separation on the CPU (sherpa-onnx)
    python -m mm_worker enroll URL CODE   connect this machine to a server as a remote worker
    python -m mm_worker compare-asr DIR   compare speech recognition models on corrected transcripts
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
from .worker import Models, Supervisor, api_keys, build_models, capabilities, gpu_info


def cmd_run(cfg: WorkerConfig):
    sup = Supervisor(cfg)
    signal.signal(signal.SIGTERM, sup.shutdown)
    signal.signal(signal.SIGINT, sup.shutdown)
    sup.run()


def cmd_check(cfg: WorkerConfig):
    caps = capabilities(cfg)
    keys = api_keys()
    print(json.dumps({"serverUrl": cfg.server_url, "workerId": cfg.worker_id, "capabilities": caps, "apiKeys": keys, **gpu_info(cfg.gpus[0])}, indent=2))
    # The CPU models (speaker separation and voice fingerprints): download them now rather than during the first job.
    try:
        models = Models(cfg)
        models.embedder().load()
        from .onnx_diarize import OnnxDiarizer

        if cfg.asr_backend != "fake":
            OnnxDiarizer(cfg.model_dir, models.embedder()).load()
        print("Speaker separation and voice fingerprints on the CPU: ready")
    except Exception as e:
        print(f"Speaker separation and voice fingerprints on the CPU: UNAVAILABLE ({e})")
    if "local" not in caps["asr"] or "local" not in caps["diarization"]:
        print("GPU models: not installed (this worker runs the transcription API, with speakers separated on the CPU or by pyannoteAI)")
        for name, ok in (("OPENROUTER_API_KEY or ASR_API_KEY", keys["openrouter"]), ("PYANNOTEAI_API_KEY (only for pyannoteAI)", keys["pyannoteai"])):
            print(f"  {name}: {'set' if ok else 'missing'}")
        return
    t0 = time.monotonic()
    _, _, diarization = build_models(cfg)
    print(f"ASR model loaded: {cfg.asr_model} ({time.monotonic() - t0:.1f}s including diarization)")
    if diarization["state"] == "ready":
        print("Diarization: ready")
    else:
        print(f"Diarization: UNAVAILABLE ({diarization.get('reason')})")
    print(json.dumps(gpu_info(cfg.gpus[0]), indent=2))


def cmd_transcribe(cfg: WorkerConfig, path: str, language: str, vocabulary: str, no_diarize: bool, script: str):
    transcriber, diarizer, _ = build_models(cfg)
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
    # Playback audio, waveforms and temporary files hold meeting content:
    # readable by this OS user only (GPU workstations are often shared).
    os.umask(0o077)
    parser = argparse.ArgumentParser(prog="mm-worker", description="MeetingMinutes GPU transcription worker")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="process jobs from the backend (default)")
    r.add_argument(
        "--exit-when-idle",
        type=float,
        metavar="SEC",
        help="exit after SEC seconds without work (for a worker started on demand, e.g. on Modal)",
    )
    sub.add_parser("check", help="load models and print environment info")
    t = sub.add_parser("transcribe", help="transcribe a local file")
    t.add_argument("path")
    t.add_argument("--language", default="auto")
    t.add_argument("--vocabulary", default="")
    t.add_argument("--no-diarize", action="store_true")
    t.add_argument("--script", default="zh-TW", choices=["zh-TW", "zh-CN", "none"])
    e = sub.add_parser("enroll", help="connect this machine to a server, with a code from Admin -> System")
    e.add_argument("url", help="the server's address, e.g. https://minutes.example.com:8443")
    e.add_argument("code", help="the one-time enrollment code")
    b = sub.add_parser("bench", help="time speaker separation on the CPU")
    b.add_argument("path", nargs="?", help="a recording to use (default: a 4-speaker sample)")
    b.add_argument("--threads", default="1", help="thread counts to try, e.g. 1,2,4 (default: 1)")
    b.add_argument("--minutes", type=float, default=5.0, help="length of sample audio to use (default: 5)")
    c = sub.add_parser("compare-asr", help="compare speech recognition models on transcripts corrected on the site")
    c.add_argument("dir", help="folder made on the server with: bun run admin export-asr-eval <dir>")
    c.add_argument("--models", default="qwen,breeze25", help="comma-separated: qwen, breeze25, breeze26, whisper-v2, whisper-v3, qwen:<repo>, whisper:<repo> (default: qwen,breeze25)")
    c.add_argument("--out", help="where to write the results (default: DIR/results-<time>)")
    c.add_argument("--limit", type=int, help="score only the first N segments (a quick try)")
    c.add_argument("--include-unedited", action="store_true", help="also score segments nobody corrected (they are Qwen3-ASR's own output)")
    c.add_argument("--batch-size", type=int, default=8, help="clips per batch for Whisper-type models (default: 8)")
    c.add_argument("--dtype", choices=["float16", "bfloat16", "float32"], help="Whisper-type models (default: float16 on NVIDIA, float32 elsewhere)")
    c.add_argument("--language", help="force a language for Whisper-type models, e.g. zh (default: detect per clip)")
    c.add_argument("--no-vocabulary", action="store_true", help="do not give the meeting's vocabulary to the models")
    c.add_argument("--show", type=int, default=10, help="segments with the largest differences to print (default: 10)")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.cmd == "enroll":
        from .client import check_server_url, enroll
        from .config import credential_path, data_dir_path, write_credential

        if os.environ.get("MM_SKIP_DOTENV") != "1":
            from .config import REPO_ROOT, _load_dotenv

            _load_dotenv(REPO_ROOT / ".env")
        data_dir = data_dir_path()
        if credential_path(data_dir).exists():
            print(f"Replacing the earlier enrollment in {credential_path(data_dir)}.")
        url = check_server_url(args.url)
        got = enroll(url, args.code)
        path = write_credential(data_dir, {"serverUrl": url, "workerId": got["workerId"], "name": got["name"], "token": got["token"]})
        print(f"Enrolled as {got['name']} ({got['workerId']}); credential saved to {path} (readable by this user only).")
        print("Next: scripts/worker.sh check   then   scripts/restart.sh worker")
        return
    if args.cmd == "bench":
        from .bench import parse_threads, run_bench
        from .onnx_voice import default_model_dir

        os.environ.setdefault("WORKER_TOKEN", "unused")
        cfg = load_config()
        run_bench(cfg.model_dir or default_model_dir(None), args.path, parse_threads(args.threads), args.minutes)
        return
    if args.cmd == "compare-asr":
        from pathlib import Path

        from .asr_compare import compare

        os.environ.setdefault("WORKER_TOKEN", "unused")
        cfg = load_config()
        print(
            compare(
                cfg,
                Path(args.dir),
                [m.strip() for m in args.models.split(",") if m.strip()],
                Path(args.out) if args.out else None,
                args.include_unedited,
                args.limit,
                args.batch_size,
                args.dtype,
                args.language,
                not args.no_vocabulary,
                args.show,
            )
        )
        return
    if args.cmd == "transcribe":
        os.environ.setdefault("WORKER_TOKEN", "unused")
        cfg = load_config()
        cmd_transcribe(cfg, args.path, args.language, args.vocabulary, args.no_diarize, args.script)
        return
    cfg = load_config()
    if args.cmd == "check":
        cmd_check(cfg)
    else:
        if getattr(args, "exit_when_idle", None) is not None:
            from dataclasses import replace

            cfg = replace(cfg, exit_when_idle_sec=max(0.0, args.exit_when_idle))
        cmd_run(cfg)


if __name__ == "__main__":
    main()
