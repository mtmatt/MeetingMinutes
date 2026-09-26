"""Job loop with on-demand GPU usage.

The long-running *supervisor* process never imports torch or initialises
CUDA, so an idle worker holds no GPU memory at all. When the backend hands
it a job, it spawns a short-lived *GPU session* process that loads the
models, processes that job (and any others already queued, back to back),
and then exits. Process exit is the only way to return every byte of VRAM,
including the CUDA context that ``torch.cuda.empty_cache()`` cannot free.

    idle ──claim──▶ spawn GPU session ──load models──▶ job, job, … ──queue empty──▶ exit (VRAM freed)
"""

from __future__ import annotations

import logging
import multiprocessing as mp
import os
import queue
import shutil
import signal
import subprocess
import threading
import time
import traceback
from typing import Optional

from . import __version__
from .audio import MediaError
from .client import BackendClient
from .config import WorkerConfig
from .pipeline import Canceled, JobSpec, run_job

log = logging.getLogger("mm_worker")


def gpu_info() -> dict:
    """GPU name and memory via nvidia-smi, which does not allocate VRAM (unlike torch.cuda)."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return {"cuda": None}
    visible = os.environ.get("CUDA_VISIBLE_DEVICES", "0").split(",")[0].strip() or "0"
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits", "-i", visible],
            capture_output=True,
            text=True,
            timeout=10,
        )
        name, total, used = [p.strip() for p in out.stdout.strip().splitlines()[0].split(",")]
        total_gb, used_gb = float(total) / 1024, float(used) / 1024
        return {"cuda": True, "gpu": name, "vramTotalGb": round(total_gb, 1), "vramFreeGb": round(total_gb - used_gb, 1)}
    except Exception as e:
        return {"cuda": None, "error": str(e)[:200]}


def build_models(cfg: WorkerConfig):
    """Load the models. Returns (transcriber, diarizer or None, diarization status).

    The status records what actually happened when loading the diarization
    pipeline: {"state": "ready"} or {"state": "unavailable", "reason": ...}.
    Whether it works cannot be known in advance: pyannote also finds a token
    saved by `huggingface-cli login`, not only HF_TOKEN.
    """
    if cfg.asr_backend == "fake":
        from .fakes import FakeDiarizer, FakeTranscriber

        log.info("using fake models (ASR_BACKEND=fake)")
        if os.environ.get("MM_FAKE_NO_DIARIZATION") == "1":
            # Same message as a real missing token / unaccepted model terms.
            reason = "Could not load pyannote/speaker-diarization-community-1: 401 Client Error: Unauthorized. Set HF_TOKEN and accept the model's conditions on Hugging Face."
            return FakeTranscriber(0).load(), None, {"state": "unavailable", "reason": reason}
        return FakeTranscriber(float(os.environ.get("MM_FAKE_LOAD_SEC", "0"))).load(), FakeDiarizer().load(), {"state": "ready"}

    from .asr import Transcriber
    from .diarize import DiarizationUnavailable, Diarizer

    transcriber = Transcriber(
        cfg.asr_model, cfg.device, backend=cfg.asr_backend, batch_size=cfg.asr_batch_size, max_new_tokens=cfg.asr_max_new_tokens
    )
    diarizer: Optional[Diarizer] = Diarizer(cfg.diarization_model, cfg.device, cfg.hf_token)
    t0 = time.monotonic()
    log.info("loading ASR model %s (%s backend)", cfg.asr_model, cfg.asr_backend)
    transcriber.load()
    status = {"state": "ready"}
    try:
        log.info("loading diarization pipeline %s", cfg.diarization_model)
        diarizer.load()
    except DiarizationUnavailable as e:
        log.warning("speaker diarization disabled: %s", e)
        diarizer = None
        status = {"state": "unavailable", "reason": str(e)[:300]}
    log.info("models ready in %.1fs", time.monotonic() - t0)
    return transcriber, diarizer, status


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, MediaError):
        return False
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(k in text for k in ("out of memory", "cuda", "connection", "timeout", "temporarily"))


# ------------------------------------------------------------ GPU session


class _JobRunner:
    """Runs jobs inside the GPU session, keeping each job's heartbeat alive."""

    def __init__(self, cfg: WorkerConfig, client: BackendClient, stop: threading.Event):
        self.cfg = cfg
        self.client = client
        self.stop = stop
        self.lock = threading.Lock()
        self.current: Optional[dict] = None
        self.last = ("starting", 0.0)
        self.canceled = threading.Event()
        threading.Thread(target=self._keepalive, daemon=True).start()

    def _keepalive(self):
        # Some steps (model loading, transcoding a long video) report no progress
        # for a while; re-send the last state so the backend does not reap the job.
        while not self.stop.wait(20):
            with self.lock:
                job, (stage, prog) = self.current, self.last
            if job:
                try:
                    if not self.client.progress(job["jobId"], stage, prog):
                        self.canceled.set()
                except Exception as e:
                    log.debug("keepalive failed: %s", e)

    def report(self, stage: str, progress: float) -> bool:
        with self.lock:
            self.last = (stage, progress)
            job = self.current
        if self.canceled.is_set() or self.stop.is_set():
            return False
        if job is None:
            return True
        ok = self.client.progress(job["jobId"], stage, progress)
        if not ok:
            self.canceled.set()
        return ok

    def begin(self, job: dict):
        self.canceled.clear()
        with self.lock:
            self.current = job
            self.last = ("loading", 0.0)

    def end(self):
        with self.lock:
            self.current = None

    def fail(self, job_id: str, message: str, retryable: bool):
        try:
            self.client.fail(job_id, message, retryable)
        except Exception as e:
            log.error("could not report failure: %s", e)

    def process(self, job: dict, transcriber, diarizer, diarizer_unavailable: Optional[str] = None):
        job_id = job["jobId"]
        log.info("job %s: meeting %s (%s), attempt %s", job_id, job["meetingId"], job.get("title"), job.get("attempt"))
        started = time.monotonic()
        try:
            result = run_job(
                JobSpec(media_path=job["mediaPath"], out_dir=job["outDir"], options=job.get("options") or {}),
                report=self.report,
                transcriber=transcriber,
                diarizer=diarizer,
                max_segment_sec=self.cfg.max_segment_sec,
                diarizer_unavailable=diarizer_unavailable,
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
                self.fail(job_id, "The worker was shut down.", True)
        except Exception as e:
            log.error("job %s failed: %s\n%s", job_id, e, traceback.format_exc())
            self.fail(job_id, str(e) if isinstance(e, MediaError) else f"{type(e).__name__}: {e}", is_retryable(e))
            try:
                import torch

                torch.cuda.empty_cache()
            except Exception:
                pass


def gpu_session(cfg: WorkerConfig, first_job: dict, events) -> None:
    """Entry point of the short-lived GPU process (multiprocessing 'spawn')."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s[gpu]: %(message)s")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    client = BackendClient(cfg.server_url, cfg.token, cfg.worker_id)
    runner = _JobRunner(cfg, client, stop)
    job: Optional[dict] = first_job

    runner.begin(job)
    events.put(("job", job["jobId"]))
    try:
        if not client.progress(job["jobId"], "loading", 0.0):
            log.info("job %s was canceled before models were loaded", job["jobId"])
            events.put(("done", job["jobId"]))
            return
        transcriber, diarizer, diarization = build_models(cfg)
    except Exception as e:
        log.error("could not load models: %s\n%s", e, traceback.format_exc())
        runner.fail(job["jobId"], f"Could not load models: {type(e).__name__}: {e}", True)
        events.put(("done", job["jobId"]))
        return
    events.put(("loaded", diarization))

    while job and not stop.is_set():
        runner.begin(job)
        events.put(("job", job["jobId"]))
        runner.process(job, transcriber, diarizer, diarization.get("reason"))
        runner.end()
        events.put(("done", job["jobId"]))
        job = None
        # Drain the queue while the models are warm, then give the GPU back.
        deadline = time.monotonic() + cfg.model_keepalive_sec
        while not stop.is_set():
            try:
                job = client.claim()
            except Exception as e:
                log.warning("claim failed: %s", e)
            if job or time.monotonic() >= deadline:
                break
            stop.wait(min(cfg.poll_interval, max(0.1, deadline - time.monotonic())))
    log.info("no more work; releasing the GPU")


# ------------------------------------------------------------- supervisor


class Supervisor:
    def __init__(self, cfg: WorkerConfig):
        self.cfg = cfg
        self.client = BackendClient(cfg.server_url, cfg.token, cfg.worker_id)
        self.stop = threading.Event()
        self.child: Optional[mp.process.BaseProcess] = None
        self.models_loaded = False
        self.current_job: Optional[str] = None
        # Speaker diarization as found by the last GPU session. "unknown" until a
        # session has loaded the models (idle workers load nothing).
        self.diarization: dict = {"state": "unknown"}

    def info(self) -> dict:
        return {
            "version": __version__,
            "asrModel": self.cfg.asr_model,
            "asrBackend": self.cfg.asr_backend,
            "diarization": self.diarization["state"],
            "diarizationError": self.diarization.get("reason"),
            "state": "busy" if self.child is not None else "idle",
            "modelsLoaded": self.models_loaded,
            "loadPolicy": "on-demand",
            "jobId": self.current_job,
            **gpu_info(),
        }

    def heartbeat_loop(self):
        while not self.stop.wait(20):
            try:
                self.client.heartbeat(self.cfg.worker_name, self.info())
            except Exception as e:
                log.debug("heartbeat failed: %s", e)

    def run(self):
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        try:
            self.client.heartbeat(self.cfg.worker_name, self.info())
        except Exception as e:
            log.warning("backend not reachable yet: %s", e)
        log.info(
            "worker %s idle (models load on demand, GPU untouched); polling %s",
            self.cfg.worker_id,
            self.cfg.server_url,
        )
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
            self.run_session(job)

    def run_session(self, job: dict):
        ctx = mp.get_context("spawn")
        events = ctx.Queue()
        child = ctx.Process(target=gpu_session, args=(self.cfg, job, events), name="mm-gpu-session")
        self.child = child
        self.current_job = job["jobId"]
        log.info("job %s claimed; starting GPU session", job["jobId"])
        child.start()
        self._heartbeat_now()
        in_flight: Optional[str] = job["jobId"]
        while child.is_alive() or not events.empty():
            try:
                kind, value = events.get(timeout=1.0)
            except queue.Empty:
                continue
            if kind == "job":
                in_flight = value
                self.current_job = value
            elif kind == "done":
                in_flight = None
                self.current_job = None
            elif kind == "loaded":
                self.models_loaded = True
                if value:
                    self.diarization = value
                self._heartbeat_now()
        child.join()
        if child.exitcode not in (0, None) and in_flight:
            log.error("GPU session exited with code %s during job %s", child.exitcode, in_flight)
            try:
                self.client.fail(in_flight, f"The GPU process exited unexpectedly (code {child.exitcode}).", True)
            except Exception as e:
                log.error("could not report failure: %s", e)
        self.child = None
        self.models_loaded = False
        self.current_job = None
        log.info("GPU session ended; GPU memory released")
        self._heartbeat_now()

    def _heartbeat_now(self):
        try:
            self.client.heartbeat(self.cfg.worker_name, self.info())
        except Exception:
            pass

    def shutdown(self, signum=None, frame=None):
        log.info("shutting down (signal %s)", signum)
        self.stop.set()
        if self.child is not None and self.child.is_alive():
            self.child.terminate()  # SIGTERM: the session reports its job as retryable and exits
