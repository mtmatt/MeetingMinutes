"""Worker entry point.

    python -m mm_worker run            poll the backend and process jobs (default)
    python -m mm_worker check          load both models and print environment info
    python -m mm_worker transcribe F   transcribe a local file and print the transcript
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import tempfile
import threading
import time
import traceback
from typing import Optional

from . import __version__
from .audio import MediaError
from .client import BackendClient
from .config import WorkerConfig, load_config
from .pipeline import Canceled, JobSpec, run_job

log = logging.getLogger("mm_worker")


def gpu_info() -> dict:
    try:
        import torch

        if not torch.cuda.is_available():
            return {"cuda": False}
        idx = torch.cuda.current_device()
        free, total = torch.cuda.mem_get_info(idx)
        return {
            "cuda": True,
            "gpu": torch.cuda.get_device_name(idx),
            "vramTotalGb": round(total / 1024**3, 1),
            "vramFreeGb": round(free / 1024**3, 1),
            "torch": torch.__version__,
        }
    except Exception as e:  # pragma: no cover
        return {"cuda": False, "error": str(e)}


def build_models(cfg: WorkerConfig):
    from .asr import Transcriber
    from .diarize import Diarizer, DiarizationUnavailable

    transcriber = Transcriber(
        cfg.asr_model, cfg.device, backend=cfg.asr_backend, batch_size=cfg.asr_batch_size, max_new_tokens=cfg.asr_max_new_tokens
    )
    diarizer: Optional[Diarizer] = Diarizer(cfg.diarization_model, cfg.device, cfg.hf_token)
    log.info("loading ASR model %s (%s backend)", cfg.asr_model, cfg.asr_backend)
    transcriber.load()
    try:
        log.info("loading diarization pipeline %s", cfg.diarization_model)
        diarizer.load()
    except DiarizationUnavailable as e:
        log.warning("speaker diarization disabled: %s", e)
        diarizer = None
    return transcriber, diarizer


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, MediaError):
        return False
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(k in text for k in ("out of memory", "cuda", "connection", "timeout", "temporarily"))


class Worker:
    def __init__(self, cfg: WorkerConfig):
        self.cfg = cfg
        self.client = BackendClient(cfg.server_url, cfg.token, cfg.worker_id)
        self.stop = threading.Event()
        self.state = {"status": "starting", "job": None}
        self.current: Optional[dict] = None
        self.last_report = ("starting", 0.0)
        self.canceled = threading.Event()
        self.lock = threading.Lock()
        self.gpu: dict = {}
        self.diarization_ok = False

    def info(self) -> dict:
        return {
            "version": __version__,
            "asrModel": self.cfg.asr_model,
            "asrBackend": self.cfg.asr_backend,
            "diarization": self.diarization_ok,
            "state": self.state["status"],
            "jobId": self.state["job"],
            **self.gpu,
        }

    def heartbeat_loop(self):
        """Keeps the worker listed as online and the running job alive during long steps."""
        while not self.stop.wait(20):
            try:
                self.gpu = gpu_info()
                self.client.heartbeat(self.cfg.worker_name, self.info())
                with self.lock:
                    job = self.current
                    stage, prog = self.last_report
                if job and not self.client.progress(job["jobId"], stage, prog):
                    self.canceled.set()
            except Exception as e:
                log.debug("heartbeat failed: %s", e)

    def report(self, stage: str, progress: float) -> bool:
        with self.lock:
            self.last_report = (stage, progress)
            job = self.current
        if self.canceled.is_set() or self.stop.is_set():
            return False
        if job is None:
            return True
        ok = self.client.progress(job["jobId"], stage, progress)
        if not ok:
            self.canceled.set()
        return ok

    def run(self):
        self.gpu = gpu_info()
        self.transcriber, self.diarizer = build_models(self.cfg)
        self.diarization_ok = self.diarizer is not None
        self.gpu = gpu_info()
        self.state["status"] = "idle"
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        try:
            self.client.heartbeat(self.cfg.worker_name, self.info())
        except Exception as e:
            log.warning("backend not reachable yet: %s", e)
        log.info("worker %s ready; polling %s", self.cfg.worker_id, self.cfg.server_url)

        while not self.stop.is_set():
            try:
                job = self.client.claim()
            except Exception as e:
                log.warning("claim failed: %s", e)
                self.stop.wait(10)
                continue
            if not job:
                self.stop.wait(self.cfg.poll_interval)
                continue
            self.process(job)

    def process(self, job: dict):
        job_id = job["jobId"]
        log.info("job %s: meeting %s (%s), attempt %s", job_id, job["meetingId"], job.get("title"), job.get("attempt"))
        self.canceled.clear()
        with self.lock:
            self.current = job
            self.last_report = ("starting", 0.0)
        self.state.update(status="busy", job=job_id)
        started = time.monotonic()
        try:
            result = run_job(
                JobSpec(media_path=job["mediaPath"], out_dir=job["outDir"], options=job.get("options") or {}),
                report=self.report,
                transcriber=self.transcriber,
                diarizer=self.diarizer,
                max_segment_sec=self.cfg.max_segment_sec,
            )
            accepted = self.client.complete(job_id, result)
            log.info(
                "job %s: done in %.0fs (%d segments, %d speakers)%s",
                job_id,
                time.monotonic() - started,
                len(result["segments"]),
                len(result["speakers"]),
                "" if accepted else " but the server no longer wanted it",
            )
        except Canceled:
            log.info("job %s: canceled", job_id)
            if self.stop.is_set():
                self._fail(job_id, "The worker was shut down.", True)
        except Exception as e:
            log.error("job %s failed: %s\n%s", job_id, e, traceback.format_exc())
            self._fail(job_id, f"{type(e).__name__}: {e}" if not isinstance(e, MediaError) else str(e), is_retryable(e))
            self._free_gpu()
        finally:
            with self.lock:
                self.current = None
            self.state.update(status="idle", job=None)

    def _fail(self, job_id: str, message: str, retryable: bool):
        try:
            self.client.fail(job_id, message, retryable)
        except Exception as e:
            log.error("could not report failure: %s", e)

    @staticmethod
    def _free_gpu():
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:
            pass


def cmd_run(cfg: WorkerConfig):
    worker = Worker(cfg)

    def shutdown(signum, frame):
        log.info("shutting down after the current step (signal %s)", signum)
        worker.stop.set()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    worker.run()


def cmd_check(cfg: WorkerConfig):
    print(json.dumps({"serverUrl": cfg.server_url, "workerId": cfg.worker_id, **gpu_info()}, indent=2))
    transcriber, diarizer = build_models(cfg)
    print(f"ASR model loaded: {cfg.asr_model}")
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
    for noisy in ("httpx", "urllib3", "speechbrain", "lightning", "pytorch_lightning"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if args.cmd == "transcribe":
        import os

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
