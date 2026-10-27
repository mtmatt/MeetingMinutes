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
import signal
import threading
import time
import traceback
from typing import Callable, Optional

from . import __version__
from .audio import MediaError
from .client import BackendClient
from .config import WorkerConfig
from .gpus import GpuMemory, find_gpu, pick_gpu, query_gpus
from .pipeline import Canceled, JobSpec, run_job, run_voiceprint

log = logging.getLogger("mm_worker")


def gpu_info(gpu: str) -> dict:
    """GPU name and memory via nvidia-smi, which does not allocate VRAM (unlike torch.cuda)."""
    try:
        gpus = query_gpus()
    except Exception as e:
        return {"cuda": None, "error": str(e)[:200]}
    if gpus is None:
        return {"cuda": None}
    mem = find_gpu(gpus, gpu)
    if mem is None:
        return {"cuda": None, "error": f"nvidia-smi does not list GPU {gpu}"}
    return {"cuda": True, "gpu": mem.name, "vramTotalGb": round(mem.total_gb, 1), "vramFreeGb": round(mem.free_gb, 1)}


def load_transcriber(cfg: WorkerConfig):
    if cfg.asr_backend == "fake":
        from .fakes import FakeTranscriber

        return FakeTranscriber(float(os.environ.get("MM_FAKE_LOAD_SEC", "0"))).load()
    from .asr import Transcriber

    transcriber = Transcriber(
        cfg.asr_model, cfg.device, backend=cfg.asr_backend, batch_size=cfg.asr_batch_size, max_new_tokens=cfg.asr_max_new_tokens
    )
    log.info("loading ASR model %s (%s backend)", cfg.asr_model, cfg.asr_backend)
    transcriber.load()
    return transcriber


def load_diarizer(cfg: WorkerConfig):
    """Returns (diarizer or None, status).

    The status records what actually happened when loading the diarization
    pipeline: {"state": "ready"} or {"state": "unavailable", "reason": ...}.
    Whether it works cannot be known in advance: pyannote also finds a token
    saved by `huggingface-cli login`, not only HF_TOKEN.
    """
    if cfg.asr_backend == "fake":
        from .fakes import FakeDiarizer

        if os.environ.get("MM_FAKE_NO_DIARIZATION") == "1":
            # Same message as a real missing token / unaccepted model terms.
            reason = "Could not load pyannote/speaker-diarization-community-1: 401 Client Error: Unauthorized. Set HF_TOKEN and accept the model's conditions on Hugging Face."
            return None, {"state": "unavailable", "reason": reason}
        return FakeDiarizer().load(), {"state": "ready"}

    from .diarize import DiarizationUnavailable, Diarizer

    diarizer = Diarizer(cfg.diarization_model, cfg.device, cfg.hf_token)
    try:
        log.info("loading diarization pipeline %s", cfg.diarization_model)
        diarizer.load()
    except DiarizationUnavailable as e:
        log.warning("speaker diarization disabled: %s", e)
        return None, {"state": "unavailable", "reason": str(e)[:300]}
    return diarizer, {"state": "ready"}


def build_models(cfg: WorkerConfig):
    """Load both models. Returns (transcriber, diarizer or None, diarization status)."""
    if cfg.asr_backend == "fake":
        log.info("using fake models (ASR_BACKEND=fake)")
    t0 = time.monotonic()
    transcriber = load_transcriber(cfg)
    diarizer, status = load_diarizer(cfg)
    log.info("models ready in %.1fs", time.monotonic() - t0)
    return transcriber, diarizer, status


class Models:
    """The models of one GPU session. The ASR model, the larger one, loads on
    first use: a session that only makes voice fingerprints never needs it."""

    def __init__(self, cfg: WorkerConfig):
        self.cfg = cfg
        self._transcriber = None
        self.diarizer, self.diarization = load_diarizer(cfg)

    @property
    def transcriber(self):
        if self._transcriber is None:
            t0 = time.monotonic()
            self._transcriber = load_transcriber(self.cfg)
            log.info("ASR model ready in %.1fs", time.monotonic() - t0)
        return self._transcriber


def job_kind(job: dict) -> str:
    return job.get("kind") or "transcribe"


class ModelsUnavailable(Exception):
    """A model could not be loaded in this session; its job was reported as retryable."""


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

    def process(self, job: dict, models: Models):
        job_id = job["jobId"]
        kind = job_kind(job)
        log.info("job %s (%s): meeting %s (%s), attempt %s", job_id, kind, job["meetingId"], job.get("title"), job.get("attempt"))
        started = time.monotonic()
        spec = JobSpec(media_path=job["mediaPath"], out_dir=job["outDir"], options=job.get("options") or {})
        if kind == "transcribe":
            # Loaded on first use when the session began with a voiceprint. A failure
            # here is the session's, not the recording's: retry it elsewhere or later.
            try:
                models.transcriber  # noqa: B018
            except Exception as e:
                log.error("could not load the ASR model: %s\n%s", e, traceback.format_exc())
                self.fail(job_id, f"Could not load models: {type(e).__name__}: {e}", True)
                raise ModelsUnavailable() from e
        try:
            if kind == "voiceprint":
                result = run_voiceprint(
                    spec,
                    report=self.report,
                    diarizer=models.diarizer,
                    diarizer_unavailable=models.diarization.get("reason"),
                    max_audio_sec=self.cfg.max_audio_sec,
                )
                summary = f"{len(result['voices'])} voice fingerprints"
            elif kind == "transcribe":
                result = run_job(
                    spec,
                    report=self.report,
                    transcriber=models.transcriber,
                    diarizer=models.diarizer,
                    max_segment_sec=self.cfg.max_segment_sec,
                    diarizer_unavailable=models.diarization.get("reason"),
                    max_audio_sec=self.cfg.max_audio_sec,
                )
                summary = f"{len(result['segments'])} segments, {len(result['speakers'])} speakers"
            else:
                raise MediaError(f"This worker does not know {kind!r} jobs; update it.")
            accepted = self.client.complete(job_id, result)
            log.info(
                "job %s: done in %.0fs (%s)%s",
                job_id,
                time.monotonic() - started,
                summary,
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
    # Before anything initialises CUDA: only this session's GPU, numbered the way nvidia-smi numbers it.
    os.environ["CUDA_VISIBLE_DEVICES"] = cfg.gpus[0]
    os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
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
        if cfg.asr_backend == "fake":
            log.info("using fake models (ASR_BACKEND=fake)")
        t0 = time.monotonic()
        models = Models(cfg)
        if job_kind(job) == "transcribe":
            models.transcriber  # noqa: B018 - load it now, while the job shows "Loading models"
        log.info("models ready in %.1fs", time.monotonic() - t0)
    except Exception as e:
        log.error("could not load models: %s\n%s", e, traceback.format_exc())
        runner.fail(job["jobId"], f"Could not load models: {type(e).__name__}: {e}", True)
        events.put(("done", job["jobId"]))
        return
    events.put(("loaded", models.diarization))

    while job and not stop.is_set():
        runner.begin(job)
        events.put(("job", job["jobId"]))
        try:
            runner.process(job, models)
        except ModelsUnavailable:
            runner.end()
            events.put(("done", job["jobId"]))
            break
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


class GpuWorker:
    """One GPU of the supervisor. The backend sees each GPU as a worker of its own."""

    def __init__(self, cfg: WorkerConfig):
        self.cfg = cfg
        self.gpu = cfg.gpus[0]
        self.client = BackendClient(cfg.server_url, cfg.token, cfg.worker_id)
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
            **gpu_info(self.gpu),
        }

    def heartbeat(self):
        try:
            self.client.heartbeat(self.cfg.worker_name, self.info())
        except Exception as e:
            log.debug("heartbeat failed: %s", e)

    def start_session(self, job: dict):
        """Starts a GPU session for `job`; this GPU is busy until the session exits."""
        ctx = mp.get_context("spawn")
        events = ctx.Queue()
        child = ctx.Process(target=gpu_session, args=(self.cfg, job, events), name=f"mm-gpu{self.gpu}-session")
        self.child = child
        self.current_job = job["jobId"]
        log.info("job %s claimed; starting GPU session on GPU %s", job["jobId"], self.gpu)
        child.start()
        threading.Thread(target=self._watch_session, args=(child, events, job["jobId"]), daemon=True).start()

    def _watch_session(self, child: mp.process.BaseProcess, events, in_flight: Optional[str]):
        self.heartbeat()
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
                self.heartbeat()
        child.join()
        if child.exitcode not in (0, None) and in_flight:
            log.error("GPU session on GPU %s exited with code %s during job %s", self.gpu, child.exitcode, in_flight)
            try:
                self.client.fail(in_flight, f"The GPU process exited unexpectedly (code {child.exitcode}).", True)
            except Exception as e:
                log.error("could not report failure: %s", e)
        self.models_loaded = False
        self.current_job = None
        self.child = None
        log.info("GPU session on GPU %s ended; GPU memory released", self.gpu)
        self.heartbeat()


class Supervisor:
    """Claims jobs for the GPUs in `cfg.gpus`, one GPU session per GPU at a time.

    Before claiming, it asks nvidia-smi how much memory each idle GPU has free,
    counting what other programs use, and claims for the one with the most, if
    that is at least `min_free_vram_gb`. Otherwise jobs wait in the backend's
    queue until a GPU has room (or another worker takes them).
    """

    def __init__(self, cfg: WorkerConfig, query: Optional[Callable[[], Optional[list[GpuMemory]]]] = None):
        self.cfg = cfg
        self.workers = [GpuWorker(cfg.for_gpu(gpu)) for gpu in cfg.gpus]
        self.stop = threading.Event()
        # Stand-in models and CPU workers use no GPU memory, so there is nothing to check.
        self.query = query or (query_gpus if cfg.uses_gpu else None)
        self._waiting: Optional[str] = None

    def heartbeat_loop(self):
        while not self.stop.wait(20):
            for worker in self.workers:
                worker.heartbeat()

    def _note(self, reason: Optional[str], message: str = ""):
        """Logs why no GPU can be used, once each time the reason changes."""
        if reason != self._waiting:
            if reason:
                log.warning("%s", message)
            elif self._waiting:
                log.info("a GPU has enough free memory again")
        self._waiting = reason

    def pick(self, idle: list[GpuWorker]) -> Optional[GpuWorker]:
        """The idle GPU to claim a job for, or None to leave jobs queued for now."""
        if self.query is None:
            return idle[0]
        try:
            gpus = self.query()
        except Exception as e:
            self._note("error", f"cannot read GPU memory, so no job is claimed until it can: {e}")
            return None
        if gpus is None:
            self._note("no-smi", "nvidia-smi not found: GPUs are used without checking their free memory")
            return idle[0]
        gpu = pick_gpu([w.gpu for w in idle], gpus, self.cfg.min_free_vram_gb)
        if gpu is None:
            free = ", ".join(
                f"GPU {w.gpu} {mem.free_gb:.1f} GB" if (mem := find_gpu(gpus, w.gpu)) else f"GPU {w.gpu} not found"
                for w in idle
            )
            self._note(
                "full",
                f"waiting for GPU memory: no idle GPU has {self.cfg.min_free_vram_gb:g} GB free (MIN_FREE_VRAM_GB); free: {free}",
            )
            return None
        self._note(None)
        return next(w for w in idle if w.gpu == gpu)

    def run(self):
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        for worker in self.workers:
            try:
                worker.client.heartbeat(worker.cfg.worker_name, worker.info())
            except Exception as e:
                log.warning("backend not reachable yet: %s", e)
                break
        log.info(
            "worker %s idle on GPU %s (models load on demand, GPU untouched); polling %s",
            self.cfg.worker_id,
            ", ".join(self.cfg.gpus),
            self.cfg.server_url,
        )
        while not self.stop.is_set():
            idle = [w for w in self.workers if w.child is None]
            worker = self.pick(idle) if idle else None
            if worker is None:
                self.stop.wait(self.cfg.poll_interval)
                continue
            try:
                job = worker.client.claim()
            except Exception as e:
                log.warning("claim failed: %s", e)
                self.stop.wait(10)
                continue
            if not job:
                self.stop.wait(self.cfg.poll_interval)
                continue
            # The GPU is busy from here, so the next pick chooses among the others.
            worker.start_session(job)

    def shutdown(self, signum=None, frame=None):
        log.info("shutting down (signal %s)", signum)
        self.stop.set()
        for worker in self.workers:
            child = worker.child
            if child is not None and child.is_alive():
                child.terminate()  # SIGTERM: the session reports its job as retryable and exits
