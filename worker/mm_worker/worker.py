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
import platform
import queue
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Callable, Optional

from . import __version__
from .asr_api import ApiError, ApiTranscriber, api_key, keys_present, settings_from_job
from .audio import CompactCanceled, MediaError, compact_audio
from .cloud_diarize import API_URL as PYANNOTEAI_URL
from .cloud_diarize import KEY_VARIABLE as PYANNOTEAI_KEY
from .cloud_diarize import CloudDiarizationError, PyannoteAIDiarizer
from .client import BackendClient, ServerError
from .config import WorkerConfig
from .gpus import GpuMemory, find_gpu, pick_gpu, query_gpus
from .pipeline import Canceled, JobSpec, run_job, run_voiceprint

log = logging.getLogger("mm_worker")


def apple_gpu_info() -> Optional[dict]:
    """The chip and its unified memory on a Mac (no nvidia-smi there)."""
    if platform.system() != "Darwin":
        return None
    try:
        brand = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=5).stdout.strip()
        mem = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout.strip() or 0)
    except Exception:
        return {"cuda": None, "gpu": "Apple GPU (MPS)"}
    # Unified memory, shared with everything else on the Mac: not GPU memory to check or show as used.
    return {"cuda": None, "gpu": f"{brand or 'Apple'} (MPS)", "unifiedMemoryGb": round(mem / 1024**3, 1) if mem else None}


def gpu_info(gpu: str) -> dict:
    """GPU name and memory via nvidia-smi, which does not allocate VRAM (unlike torch.cuda)."""
    try:
        gpus = query_gpus()
    except Exception as e:
        return {"cuda": None, "error": str(e)[:200]}
    if gpus is None:
        return apple_gpu_info() or {"cuda": None}
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


def capabilities(cfg: WorkerConfig) -> dict:
    """What this worker can run, from what is installed: the APIs always; the local
    models only with their packages (a worker installed without GPU packages has
    neither torch, Qwen3-ASR nor pyannote)."""
    import importlib.util

    def installed(name: str) -> bool:
        try:
            return importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            return False

    fake = cfg.asr_backend == "fake"
    asr = (["local"] if fake or installed("qwen_asr") else []) + ["api"]
    diarization = (
        (["local"] if fake or installed("pyannote.audio") else [])
        + (["cpu"] if fake or installed("sherpa_onnx") else [])
        + ["pyannoteai"]
    )
    # With the keys it has, so the server never hands it work that needs a key it lacks.
    return {"asr": asr, "diarization": diarization, "keys": api_keys()}


def api_keys() -> dict:
    """Which API keys this worker has (never the keys)."""
    return {**keys_present(), "pyannoteai": bool(os.environ.get(PYANNOTEAI_KEY, "").strip())}


DIARIZATION_ENGINES = ("local", "cpu", "pyannoteai")


def diarization_engine(job: dict) -> str:
    """Who separates speakers for this job: "local" (pyannote on the GPU), "cpu"
    (sherpa-onnx on this machine's CPU) or "pyannoteai". Older backends send nothing: local."""
    engine = (job.get("diarization") or {}).get("engine")
    return engine if engine in DIARIZATION_ENGINES else "local"


def asr_engine(job: dict) -> str:
    """Where the backend wants this job transcribed: "local" (the GPU) or "api".
    Backends from before the choice existed send nothing, which means local."""
    return "api" if (job.get("asr") or {}).get("engine") == "api" else "local"


class Models:
    """The models of one GPU session, each loaded on first use: a session that
    only makes voice fingerprints never loads the ASR model, and one that uses
    the APIs loads neither local model."""

    def __init__(self, cfg: WorkerConfig):
        self.cfg = cfg
        self._transcriber = None
        self._local: Optional[tuple] = None
        self._embedder = None

    @property
    def diarization(self) -> Optional[dict]:
        """What loading the local diarization pipeline found; None if it was not needed."""
        return self._local[1] if self._local else None

    def local_diarizer(self):
        if self._local is None:
            self._local = load_diarizer(self.cfg)
        return self._local

    def embedder(self):
        """Voice fingerprints on the CPU, for speakers separated by pyannoteAI."""
        if self._embedder is None:
            if self.cfg.asr_backend == "fake":
                from .fakes import FakeEmbedder

                self._embedder = FakeEmbedder()
            else:
                from .onnx_voice import OnnxVoiceEmbedder, default_model_dir

                self._embedder = OnnxVoiceEmbedder(self.cfg.model_dir or default_model_dir(None))
        return self._embedder

    def diarizer_for(self, job: dict):
        """(diarizer or None, why there is none) for this job's speaker separation."""
        engine = diarization_engine(job)
        if engine == "cpu":
            if self.cfg.asr_backend == "fake":
                from .fakes import FakeDiarizer

                return FakeDiarizer(), None
            from .onnx_diarize import OnnxDiarizer
            from .onnx_voice import default_model_dir

            return OnnxDiarizer(self.cfg.model_dir or default_model_dir(None), self.embedder()), None
        if engine == "pyannoteai":
            diarizer = PyannoteAIDiarizer(
                os.environ.get(PYANNOTEAI_KEY, "").strip() or None,
                self.embedder(),
                api_url=os.environ.get("PYANNOTEAI_API_URL", "").strip() or PYANNOTEAI_URL,
            )
            return diarizer, None
        diarizer, status = self.local_diarizer()
        return diarizer, status.get("reason")

    @property
    def transcriber(self):
        if self._transcriber is None:
            t0 = time.monotonic()
            self._transcriber = load_transcriber(self.cfg)
            log.info("ASR model ready in %.1fs", time.monotonic() - t0)
        return self._transcriber

    def transcriber_for(self, job: dict):
        """The local model, or a client for the API the job names (cheap to make,
        so made per job: an administrator may change it between jobs)."""
        if asr_engine(job) == "local":
            return self.transcriber
        settings = settings_from_job(job.get("asr") or {})
        api = ApiTranscriber(
            settings,
            api_key(settings.provider),
            concurrency=self.cfg.asr_api_concurrency,
            timeout=self.cfg.asr_api_timeout,
        ).load()
        log.info("transcribing with %s", api.label)
        return api


def job_kind(job: dict) -> str:
    return job.get("kind") or "transcribe"


class ModelsUnavailable(Exception):
    """A model could not be loaded in this session; its job was reported as retryable."""


class TransferError(Exception):
    """Moving a remote job's files to or from the server failed; another try may work."""

    retryable = True


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, MediaError):
        return False
    if isinstance(exc, (ApiError, CloudDiarizationError, TransferError)):
        return exc.retryable
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
        if "mediaPath" in job:
            # On the server's machine: the recording and the meeting's folder are on this disk.
            self._process(job, models, JobSpec(media_path=job["mediaPath"], out_dir=job["outDir"], options=job.get("options") or {}))
            return
        self._process_remote(job, models)

    def _process_remote(self, job: dict, models: Models):
        """On another machine: download the recording, work in a private temporary
        folder, upload what the server keeps, and delete everything afterwards."""
        job_id = job["jobId"]
        media = job.get("media") or {}
        ext = re.sub(r"[^A-Za-z0-9]", "", str(media.get("ext") or "bin"))[:8] or "bin"
        work = Path(tempfile.mkdtemp(prefix="mm-job-"))  # mode 0700
        try:
            src = work / f"original.{ext}"
            if not self.report("downloading", 0.0):
                return
            try:
                self.client.download(media["url"], src, media.get("size"))
            except ServerError as e:
                if e.status == 409:
                    log.info("job %s: no longer ours", job_id)
                    return
                self.fail(job_id, f"Could not download the recording: {e}", e.status >= 500)
                return
            except Exception as e:
                self.fail(job_id, f"Could not download the recording: {type(e).__name__}: {e}", True)
                return
            spec = JobSpec(media_path=str(src), out_dir=str(work / "out"), options=job.get("options") or {})
            uploads = job.get("uploads") or {}

            def send_files():
                self.report("uploading", 0.99)
                for name in uploads.get("files") or []:
                    path = Path(spec.out_dir) / name
                    if not path.exists():
                        continue
                    try:
                        self.client.upload(uploads["url"], name, path, int(uploads.get("chunkBytes") or 8 * 1024 * 1024))
                    except ServerError as e:
                        if e.status == 409 and "not_running" in str(e):
                            raise Canceled() from None
                        raise TransferError(f"Could not upload {name}: {e}") from None
                    except (OSError, ConnectionError, TimeoutError) as e:
                        raise TransferError(f"Could not upload {name}: {e}") from None

            self._process(job, models, spec, before_complete=send_files if job_kind(job) == "transcribe" else None)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _process(self, job: dict, models: Models, spec: JobSpec, before_complete: Optional[Callable[[], None]] = None):
        job_id = job["jobId"]
        kind = job_kind(job)
        log.info("job %s (%s): meeting %s (%s), attempt %s", job_id, kind, job["meetingId"], job.get("title"), job.get("attempt"))
        started = time.monotonic()
        transcriber = None
        diarizer, diarizer_unavailable = None, None
        if kind in ("transcribe", "voiceprint"):
            try:
                diarizer, diarizer_unavailable = models.diarizer_for(job)
            except CloudDiarizationError as e:
                # No pyannoteAI key: the same for every retry, so say what to set.
                log.error("cannot use pyannoteAI: %s", e)
                self.fail(job_id, str(e), e.retryable)
                return
        if kind == "transcribe":
            try:
                transcriber = models.transcriber_for(job)
            except ApiError as e:
                # No key, or settings this worker cannot use: the same for every
                # worker and every retry, so say so instead of retrying.
                log.error("cannot use the transcription API: %s", e)
                self.fail(job_id, str(e), e.retryable)
                return
            except Exception as e:
                # The local model, loaded on first use when the session began with a voiceprint
                # or an API job. A failure here is the session's, not the recording's: retry it
                # elsewhere or later.
                log.error("could not load the ASR model: %s\n%s", e, traceback.format_exc())
                self.fail(job_id, f"Could not load models: {type(e).__name__}: {e}", True)
                raise ModelsUnavailable() from e
        try:
            if kind == "voiceprint":
                result = run_voiceprint(
                    spec,
                    report=self.report,
                    diarizer=diarizer,
                    diarizer_unavailable=diarizer_unavailable,
                    max_audio_sec=self.cfg.max_audio_sec,
                )
                summary = f"{len(result['voices'])} voice fingerprints"
            elif kind == "transcribe":
                result = run_job(
                    spec,
                    report=self.report,
                    transcriber=transcriber,
                    diarizer=diarizer,
                    max_segment_sec=self.cfg.max_segment_sec,
                    diarizer_unavailable=diarizer_unavailable,
                    max_audio_sec=self.cfg.max_audio_sec,
                )
                summary = f"{len(result['segments'])} segments, {len(result['speakers'])} speakers"
            else:
                raise MediaError(f"This worker does not know {kind!r} jobs; update it.")
            if before_complete is not None:
                before_complete()
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
            self.fail(
                job_id,
                str(e) if isinstance(e, (MediaError, ApiError, CloudDiarizationError, TransferError)) else f"{type(e).__name__}: {e}",
                is_retryable(e),
            )
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
    if cfg.device.startswith("mps"):
        # Operations the Apple GPU lacks run on the CPU instead of failing.
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s[gpu]: %(message)s")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    client = BackendClient(cfg.server_url, cfg.token, cfg.worker_id, capabilities=capabilities(cfg))
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
        # Load what the first job needs now, while it shows "Loading models".
        if job_kind(job) in ("transcribe", "voiceprint") and diarization_engine(job) == "local":
            models.local_diarizer()
        if job_kind(job) == "transcribe" and asr_engine(job) == "local":
            models.transcriber  # noqa: B018
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


# ------------------------------------------------------------- compaction


class MediaJobs:
    """Compacts originals to audio only, one at a time, in the supervisor.

    This is ffmpeg on the CPU: no GPU session, no models, and it never waits
    for GPU memory. It claims under the first GPU's worker ID, so the backend
    lists no extra worker.
    """

    KINDS = ["compact"]
    # How often a running compaction tells the backend it is alive (and learns whether it was canceled).
    HEARTBEAT_SEC = 15.0

    def __init__(self, cfg: WorkerConfig, worker_id: str, stop: threading.Event, client: Optional[BackendClient] = None):
        self.cfg = cfg
        self.stop = stop
        self.client = client or BackendClient(cfg.server_url, cfg.token, worker_id)

    def run(self):
        while not self.stop.is_set():
            try:
                job = self.client.claim(self.KINDS)
            except Exception as e:
                log.debug("compaction claim failed: %s", e)
                job = None
            if not job:
                self.stop.wait(self.cfg.media_poll_interval)
                continue
            self.process(job)

    def process(self, job: dict) -> None:
        job_id = job["jobId"]
        opts = job.get("options") or {}
        out = str(opts.get("output") or "")
        out_dir = os.path.realpath(job.get("outDir") or "")
        # Written only where the backend keeps this meeting's files, as an .opus file.
        if not out.endswith(".opus") or os.path.dirname(os.path.realpath(out)) != out_dir:
            self._fail(job_id, f"Refusing to write the compact copy to {out!r}.", False)
            return
        kbps = max(12, min(256, int(opts.get("bitrateKbps") or 32)))
        last = [time.monotonic()]

        def keep_going() -> bool:
            if self.stop.is_set():
                return False
            if time.monotonic() - last[0] < self.HEARTBEAT_SEC:
                return True
            last[0] = time.monotonic()
            try:
                return self.client.progress(job_id, "compacting", 0.5)
            except Exception as e:
                log.debug("compaction heartbeat failed: %s", e)
                return True

        started = time.monotonic()
        try:
            if not self.client.progress(job_id, "compacting", 0.0):
                return
            duration = compact_audio(job["mediaPath"], out, kbps, keep_going=keep_going, max_seconds=self.cfg.max_audio_sec)
            accepted = self.client.complete(job_id, {"durationSec": round(duration, 3)})
            if not accepted:
                _unlink(out)
            log.info(
                "compacted meeting %s to %d kbit/s Opus in %.0fs%s",
                job["meetingId"],
                kbps,
                time.monotonic() - started,
                "" if accepted else " but the server no longer wanted it",
            )
        except CompactCanceled:
            _unlink(out)
            log.info("compaction of meeting %s canceled", job["meetingId"])
            if self.stop.is_set():
                self._fail(job_id, "The worker was shut down.", True)
        except Exception as e:
            _unlink(out)
            log.error("compaction of meeting %s failed: %s", job["meetingId"], e)
            self._fail(job_id, str(e) if isinstance(e, MediaError) else f"{type(e).__name__}: {e}", is_retryable(e))

    def _fail(self, job_id: str, message: str, retryable: bool):
        try:
            self.client.fail(job_id, message, retryable)
        except Exception as e:
            log.error("could not report failure: %s", e)


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError as e:
        log.warning("could not remove %s: %s", path, e)


# ------------------------------------------------------------- supervisor


class GpuWorker:
    """One GPU of the supervisor. The backend sees each GPU as a worker of its own."""

    def __init__(self, cfg: WorkerConfig):
        self.cfg = cfg
        self.gpu = cfg.gpus[0]
        self.client = BackendClient(cfg.server_url, cfg.token, cfg.worker_id, capabilities=capabilities(cfg))
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
            # Which APIs this worker has a key for (never the keys), and what it can run.
            "apiKeys": api_keys(),
            "capabilities": self.client.capabilities,
            "diarization": self.diarization["state"],
            "diarizationError": self.diarization.get("reason"),
            "state": "busy" if self.child is not None else "idle",
            "modelsLoaded": self.models_loaded,
            "loadPolicy": "on-demand",
            "jobId": self.current_job,
            **gpu_info(self.gpu),
        }

    def heartbeat(self) -> Optional[dict]:
        try:
            return self.client.heartbeat(self.cfg.worker_name, self.info())
        except Exception as e:
            log.debug("heartbeat failed: %s", e)
            return None

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
        self._auth_refused = False
        # Where the backend says speech is recognised and speakers separated; decides
        # how much GPU memory a session needs.
        self.asr_engine = "local"
        self.diarization_engine = "local"

    def note_backend(self, answer: Optional[dict]):
        told = (answer or {}).get("transcriber") or {}
        engine, diarization = told.get("engine"), told.get("diarization")
        if engine in ("local", "api") and engine != self.asr_engine:
            log.info("transcription now runs %s", "through an API" if engine == "api" else "on the GPU")
            self.asr_engine = engine
        if diarization in DIARIZATION_ENGINES and diarization != self.diarization_engine:
            where = {"pyannoteai": "by pyannoteAI", "cpu": "on the CPU", "local": "on the GPU"}[diarization]
            log.info("speakers are now separated %s", where)
            self.diarization_engine = diarization

    @property
    def min_free_vram_gb(self) -> float:
        if self.asr_engine == "api" and self.diarization_engine != "local":
            return 0.0  # nothing is loaded on the GPU
        if self.asr_engine == "api":
            return self.cfg.min_free_vram_api_gb
        return self.cfg.min_free_vram_gb

    def heartbeat_loop(self):
        while not self.stop.wait(20):
            for worker in self.workers:
                self.note_backend(worker.heartbeat())

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
        if self.query is None or self.min_free_vram_gb <= 0:
            # Nothing to check: a CPU worker, or everything runs through the APIs.
            return idle[0]
        try:
            gpus = self.query()
        except Exception as e:
            self._note("error", f"cannot read GPU memory, so no job is claimed until it can: {e}")
            return None
        if gpus is None:
            self._note("no-smi", "nvidia-smi not found: GPUs are used without checking their free memory")
            return idle[0]
        need = self.min_free_vram_gb
        gpu = pick_gpu([w.gpu for w in idle], gpus, need)
        if gpu is None:
            free = ", ".join(
                f"GPU {w.gpu} {mem.free_gb:.1f} GB" if (mem := find_gpu(gpus, w.gpu)) else f"GPU {w.gpu} not found"
                for w in idle
            )
            self._note(
                "full",
                f"waiting for GPU memory: no idle GPU has {need:g} GB free "
                f"({'MIN_FREE_VRAM_API_GB' if self.asr_engine == 'api' else 'MIN_FREE_VRAM_GB'}); free: {free}",
            )
            return None
        self._note(None)
        return next(w for w in idle if w.gpu == gpu)

    def run(self):
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        # Compacting rewrites originals on the server's disk: never from another machine.
        if self.cfg.media_jobs and not self.cfg.remote:
            media = MediaJobs(self.cfg, self.workers[0].cfg.worker_id, self.stop)
            threading.Thread(target=media.run, name="mm-media", daemon=True).start()
        for worker in self.workers:
            try:
                self.note_backend(worker.client.heartbeat(worker.cfg.worker_name, worker.info()))
            except Exception as e:
                log.warning("backend not reachable yet: %s", e)
                break
        log.info(
            "worker %s idle on GPU %s (models load on demand, GPU untouched); polling %s",
            self.cfg.worker_id,
            ", ".join(self.cfg.gpus),
            self.cfg.server_url,
        )
        caps = self.workers[0].client.capabilities or {}
        if "local" not in caps.get("asr", []) or "local" not in caps.get("diarization", []):
            log.info("GPU models not installed: this worker takes only transcriptions set to the transcription API with CPU or pyannoteAI speaker separation")
        while not self.stop.is_set():
            idle = [w for w in self.workers if w.child is None]
            worker = self.pick(idle) if idle else None
            if worker is None:
                self.stop.wait(self.cfg.poll_interval)
                continue
            try:
                job = worker.client.claim()
            except ServerError as e:
                if e.status in (401, 403):
                    # Revoked, or a token from another server: say what to do, then check now and then.
                    if not self._auth_refused:
                        log.error(
                            "the server refused this worker's token (HTTP %s)%s",
                            e.status,
                            ": it was revoked or is invalid; run scripts/worker.sh enroll with a new code from Admin -> System"
                            if self.cfg.remote
                            else "; check WORKER_TOKEN",
                        )
                        self._auth_refused = True
                    self.stop.wait(60)
                    continue
                log.warning("claim failed: %s", e)
                self.stop.wait(10)
                continue
            except Exception as e:
                log.warning("claim failed: %s", e)
                self.stop.wait(10)
                continue

            self._auth_refused = False
            if not job:
                self.stop.wait(self.cfg.poll_interval)
                continue
            if job_kind(job) == "transcribe":
                self.note_backend({"transcriber": {"engine": asr_engine(job), "diarization": diarization_engine(job)}})
            # The GPU is busy from here, so the next pick chooses among the others.
            worker.start_session(job)

    def shutdown(self, signum=None, frame=None):
        log.info("shutting down (signal %s)", signum)
        self.stop.set()
        for worker in self.workers:
            child = worker.child
            if child is not None and child.is_alive():
                child.terminate()  # SIGTERM: the session reports its job as retryable and exits
