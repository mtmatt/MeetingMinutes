"""Speaker diarization by pyannoteAI (https://pyannote.ai), the pyannote team's hosted service.

For a worker without a GPU, CUDA or torch. The recording, as 48 kbit/s mono
Opus, goes to pyannoteAI's temporary storage (deleted there within 48 hours,
per its documentation); a diarization job returns who spoke when. Voice
fingerprints are made on this machine by ``embedder`` (sherpa-onnx), so
recognising people by voice keeps working without sending anything more.

The API, as used by pyannoteAI's own Python SDK:
  POST /v1/media/input {"url": "media://…"}  -> {"url": <pre-signed upload URL>}; then PUT the bytes there
  POST /v1/diarize {"url": "media://…", "model", "numSpeakers", "minSpeakers", "maxSpeakers", "exclusive"} -> {"jobId"}
  GET  /v1/jobs/{jobId} -> {"status": "pending|created|running|succeeded|failed|canceled", "output": {...}}
The key is the worker's PYANNOTEAI_API_KEY; it never passes through the backend.
"""

from __future__ import annotations

import json
import logging
import random
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Callable, List, Optional, Tuple

import numpy as np

from .audio import ffmpeg_bin
from .client import is_loopback_host

log = logging.getLogger("mm_worker.cloud_diarize")

API_URL = "https://api.pyannote.ai/v1"
DEFAULT_MODEL = "precision-2"
KEY_VARIABLE = "PYANNOTEAI_API_KEY"
UPLOAD_KBPS = 48

Turn = Tuple[float, float, str]


class CloudDiarizationError(Exception):
    """pyannoteAI refused or failed. ``retryable``: trying again later may help."""

    def __init__(self, message: str, retryable: bool = False, status: Optional[int] = None):
        super().__init__(message)
        self.retryable = retryable
        self.status = status


def encode_opus(wav: np.ndarray, sr: int, kbps: int = UPLOAD_KBPS) -> bytes:
    """The recording as mono Ogg Opus, to upload (about 21 MB per hour at 48 kbit/s)."""
    cmd = [
        ffmpeg_bin(), "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
        "-c:a", "libopus", "-b:a", f"{kbps}k", "-application", "voip", "-f", "ogg", "pipe:1",
    ]  # fmt: skip
    proc = subprocess.run(cmd, input=np.ascontiguousarray(wav, dtype=np.float32).tobytes(), capture_output=True)
    if proc.returncode != 0 or not proc.stdout:
        raise CloudDiarizationError(f"Could not encode the audio for pyannoteAI: {proc.stderr.decode(errors='replace')[-300:]}")
    return proc.stdout


def _message(body: str) -> str:
    try:
        data = json.loads(body)
    except ValueError:
        return body.strip()[:300]
    if isinstance(data, dict):
        for key in ("message", "error", "detail"):
            value = data.get(key)
            if isinstance(value, str) and value:
                return value[:300]
            if isinstance(value, dict) and isinstance(value.get("message"), str):
                return value["message"][:300]
    return body.strip()[:300]


def _safe_upload_url(url: str) -> bool:
    """HTTPS, or plain HTTP to this machine only (a stand-in service in tests)."""
    try:
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return False
    if parts.scheme == "https":
        return bool(host)
    return parts.scheme == "http" and is_loopback_host(host)


class PyannoteAIDiarizer:
    """Same interface as diarize.Diarizer: run() for turns, embed() for voice fingerprints."""

    def __init__(
        self,
        key: Optional[str],
        embedder,
        model: str = DEFAULT_MODEL,
        api_url: str = API_URL,
        poll_sec: float = 5.0,
        timeout: float = 60.0,
        max_wait_sec: Optional[float] = None,
        retries: int = 4,
        opener: Optional[Callable] = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        if not key:
            raise CloudDiarizationError(
                f"Speaker separation is set to pyannoteAI, but this worker has no API key: set {KEY_VARIABLE} in the worker's .env and restart it."
            )
        self.key = key
        self.embedder = embedder
        self.model = model
        self.api_url = api_url.rstrip("/")
        self.poll_sec = poll_sec
        self.timeout = timeout
        self.max_wait_sec = max_wait_sec
        self.retries = retries
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        self._clock = clock

    @property
    def voice_model(self) -> str:
        return self.embedder.voice_model

    # ------------------------------------------------------------- HTTP

    def _call(self, method: str, url: str, body: Optional[bytes] = None, headers: Optional[dict] = None, what: str = "") -> bytes:
        """One request, retrying rate limits, server errors and network errors."""
        delay = 2.0
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
            try:
                with self._open(req, timeout=self.timeout) as res:
                    return res.read()
            except urllib.error.HTTPError as e:
                text = e.read().decode("utf-8", errors="replace") if e.fp else ""
                status = e.code
                msg = _message(text)
                if status == 401:
                    raise CloudDiarizationError(f"pyannoteAI rejected the API key (HTTP 401: {msg}). Check {KEY_VARIABLE} in the worker's .env.", status=status)
                if status == 402:
                    raise CloudDiarizationError(f"pyannoteAI says the account is out of credit (HTTP 402: {msg}).", status=status)
                retryable = status in (408, 409, 425, 429) or status >= 500
                err = CloudDiarizationError(f"pyannoteAI {what} failed (HTTP {status}: {msg}).", retryable=retryable, status=status)
                if not retryable or attempt >= self.retries:
                    raise err
                after = e.headers.get("Retry-After") if e.headers else None
                try:
                    wait = float(after) if after else delay
                except ValueError:
                    wait = delay
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                if attempt >= self.retries:
                    raise CloudDiarizationError(f"Could not reach pyannoteAI ({what}): {getattr(e, 'reason', e)}", retryable=True) from None
                wait = delay
            log.warning("pyannoteAI %s: retrying in %.0fs", what, wait)
            self._sleep(min(60.0, wait * (0.75 + random.random() / 2)))
            delay = min(delay * 2, 30.0)
        raise CloudDiarizationError(f"pyannoteAI {what} failed.", retryable=True)

    def _api(self, method: str, route: str, payload: Optional[dict] = None, what: str = "") -> dict:
        headers = {"Authorization": f"Bearer {self.key}", "Accept": "application/json"}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        raw = self._call(method, self.api_url + route, body, headers, what or route)
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            raise CloudDiarizationError(f"pyannoteAI answered {route} with something other than JSON.", retryable=True) from None
        if not isinstance(data, dict):
            raise CloudDiarizationError(f"pyannoteAI answered {route} unexpectedly.", retryable=True)
        return data

    # ------------------------------------------------------------- diarization

    def run(
        self,
        wav: np.ndarray,
        sr: int,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
        progress: Optional[Callable[[float], None]] = None,
    ) -> List[Turn]:
        report = progress or (lambda f: None)
        duration = len(wav) / sr if sr else 0.0
        audio = encode_opus(wav, sr)
        report(0.05)
        media = f"media://meetingminutes/{uuid.uuid4().hex}.ogg"
        upload = self._api("POST", "/media/input", {"url": media}, "upload request").get("url")
        if not isinstance(upload, str) or not _safe_upload_url(upload):
            # The whole recording goes there: never over plain HTTP across a network.
            raise CloudDiarizationError("pyannoteAI did not return an https upload address.", retryable=True)
        self._call("PUT", upload, audio, {"Content-Type": "audio/ogg"}, "upload")
        report(0.15)

        request: dict = {"url": media, "model": self.model, "exclusive": True}
        if num_speakers:
            request["numSpeakers"] = int(num_speakers)
        else:
            if min_speakers:
                request["minSpeakers"] = int(min_speakers)
            if max_speakers:
                request["maxSpeakers"] = int(max_speakers)
        job_id = self._api("POST", "/diarize", request, "diarization request").get("jobId")
        if not isinstance(job_id, str) or not job_id:
            raise CloudDiarizationError("pyannoteAI did not return a job.", retryable=True)
        log.info("pyannoteAI job %s for %.0fs of audio", job_id, duration)

        # Typically well under real time; wait at most an hour per hour of audio (at least 10 minutes).
        limit = self.max_wait_sec if self.max_wait_sec is not None else max(600.0, duration)
        expected = max(30.0, duration / 20)
        started = self._clock()
        while True:
            job = self._api("GET", f"/jobs/{job_id}", None, "job status")
            status = str(job.get("status") or "")
            output = job.get("output") if isinstance(job.get("output"), dict) else {}
            if status == "succeeded":
                break
            if status in ("failed", "canceled"):
                detail = output.get("error") if isinstance(output.get("error"), str) else "no reason given"
                # pyannoteAI's own failures (unreadable audio) are not expected to go away on retry.
                raise CloudDiarizationError(f"pyannoteAI {status} the diarization job: {detail}")
            elapsed = self._clock() - started
            if elapsed > limit:
                raise CloudDiarizationError(f"pyannoteAI did not finish within {limit / 60:.0f} minutes.", retryable=True)
            # Progress approaches 95% while waiting; the callback may raise to cancel.
            report(0.15 + 0.80 * (1 - np.exp(-elapsed / expected)))
            self._sleep(self.poll_sec)

        turns = output.get("exclusiveDiarization") or output.get("diarization") or []
        if not isinstance(turns, list):
            raise CloudDiarizationError("pyannoteAI returned no diarization.", retryable=True)
        out: List[Turn] = []
        for t in turns:
            try:
                start, end, speaker = float(t["start"]), float(t["end"]), str(t["speaker"])
            except (KeyError, TypeError, ValueError):
                continue
            if end > start:
                out.append((max(0.0, start), min(end, duration) if duration else end, speaker))
        out.sort(key=lambda x: x[0])
        report(1.0)
        return out

    def embed(self, clips, sr: int) -> np.ndarray:
        return self.embedder.embed(clips, sr)
