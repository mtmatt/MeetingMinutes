"""Speech recognition through a hosted API instead of a model on this GPU.

Two kinds of service are supported, both with the OpenAI-style
``POST {base}/audio/transcriptions`` endpoint:

- ``openrouter``: OpenRouter (https://openrouter.ai/api/v1), which routes to
  models such as ``qwen/qwen3-asr-1.7b`` and ``openai/whisper-large-v3``. The
  audio goes in a JSON body as ``input_audio: {data: <base64>, format}``.
- ``openai``: any OpenAI-compatible server (OpenAI, Groq, a vLLM serving
  Qwen3-ASR, ...). The audio goes as a multipart ``file`` upload.

The pipeline is the same as with the local model: speaker diarization still
runs on this machine and decides the segments; each segment (at most
MAX_SEGMENT_SEC long) is sent as one request, several at a time. Only the
audio of those segments leaves the machine, never the whole recording.

The API key comes from the worker's environment, never from the backend:
OPENROUTER_API_KEY (or ASR_API_KEY) for OpenRouter, ASR_API_KEY (or
OPENAI_API_KEY) for an OpenAI-compatible server.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import random
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

log = logging.getLogger("mm_worker.asr_api")

PROVIDERS = ("openrouter", "openai")
DEFAULT_BASE_URLS = {"openrouter": "https://openrouter.ai/api/v1", "openai": "https://api.openai.com/v1"}
KEY_VARIABLES = {"openrouter": ("OPENROUTER_API_KEY", "ASR_API_KEY"), "openai": ("ASR_API_KEY", "OPENAI_API_KEY")}

# The upload page's language choices, as the local Qwen3-ASR names them, and
# the ISO 639 codes transcription APIs take. "yue" is what Whisper calls Cantonese.
LANGUAGE_CODES = {"Chinese": "zh", "English": "en", "Cantonese": "yue", "Japanese": "ja", "Korean": "ko"}
# What APIs report back (codes, or Whisper's lowercase names), as those names.
_REPORTED = {
    **{code: name for name, code in LANGUAGE_CODES.items()},
    **{name.lower(): name for name in LANGUAGE_CODES},
    "mandarin": "Chinese",
    "zh-tw": "Chinese",
    "zh-cn": "Chinese",
    "cmn": "Chinese",
}

# Shortest clip sent: OpenAI rejects audio under 0.1 s; a little silence costs nothing.
MIN_CLIP_SEC = 0.5
# Qwen3-ASR's raw output, in case a provider passes it through: "language Chinese<asr_text>…".
_QWEN_RAW = re.compile(r"^\s*language\s+([A-Za-z]+)\s*<asr_text>", re.S)


class ApiError(Exception):
    """A request the service refused. ``retryable`` says whether trying later could help."""

    def __init__(self, message: str, status: Optional[int] = None, retryable: bool = False, retry_after: Optional[float] = None):
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        # Seconds the service asked us to wait (Retry-After), if it said.
        self.retry_after = retry_after


def api_key(provider: str, environ: Optional[dict] = None) -> Optional[str]:
    env = os.environ if environ is None else environ
    for name in KEY_VARIABLES.get(provider, ()):
        value = (env.get(name) or "").strip()
        if value:
            return value
    return None


def keys_present(environ: Optional[dict] = None) -> Dict[str, bool]:
    """Which providers this worker has a key for (reported to the admin page; never the key)."""
    return {p: api_key(p, environ) is not None for p in PROVIDERS}


def language_code(language: Optional[str]) -> Optional[str]:
    """The ISO code for an upload-page language ("Chinese" -> "zh"); None for auto-detect."""
    if not language or language.lower() == "auto":
        return None
    if language in LANGUAGE_CODES:
        return LANGUAGE_CODES[language]
    if len(language) <= 3:
        return language.lower()  # already a code
    # A name the upload page does not offer: let the service detect it rather than guess a code.
    name = _REPORTED.get(language.lower())
    return LANGUAGE_CODES.get(name) if name else None


def language_name(reported: Optional[str]) -> str:
    """A reported language ("zh", "chinese") as the local model names it ("Chinese")."""
    if not reported:
        return ""
    key = reported.strip().lower()
    return _REPORTED.get(key, _REPORTED.get(key.split("-")[0], reported.strip().capitalize()))


def encode_wav(clip: np.ndarray, sr: int) -> bytes:
    """16-bit mono WAV, padded with silence to MIN_CLIP_SEC."""
    x = np.asarray(clip, dtype=np.float32)
    short = int(MIN_CLIP_SEC * sr) - len(x)
    if short > 0:
        x = np.concatenate([x, np.zeros(short, dtype=np.float32)])
    pcm = (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _multipart(fields: Dict[str, str], file_bytes: bytes) -> Tuple[bytes, str]:
    boundary = f"mm-{uuid.uuid4().hex}"
    out = io.BytesIO()
    for name, value in fields.items():
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    out.write(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="segment.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
    )
    out.write(file_bytes)
    out.write(f"\r\n--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def _error_message(body: str) -> str:
    """The service's own explanation, from {"error": {"message": ...}} or {"error": "..."}."""
    try:
        data = json.loads(body)
    except ValueError:
        return body.strip()[:300]
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        msg = err.get("message") or ""
        raw = (err.get("metadata") or {}).get("raw") if isinstance(err.get("metadata"), dict) else None
        return f"{msg} ({raw})"[:300] if raw and isinstance(raw, str) and raw not in msg else str(msg)[:300]
    if isinstance(err, str):
        return err[:300]
    return body.strip()[:300]


@dataclass
class ApiSettings:
    provider: str
    model: str
    base_url: str


def settings_from_job(asr: dict) -> ApiSettings:
    provider = asr.get("provider") or "openrouter"
    if provider not in PROVIDERS:
        raise ApiError(f"Unknown transcription API {provider!r}; update the worker.")
    model = (asr.get("model") or "").strip()
    if not model:
        raise ApiError("No transcription model is set for the API.")
    base = (asr.get("baseUrl") or "").strip().rstrip("/") or DEFAULT_BASE_URLS[provider]
    return ApiSettings(provider=provider, model=model, base_url=base)


class ApiTranscriber:
    """Same interface as asr.Transcriber; sends each clip to a transcription API."""

    def __init__(
        self,
        settings: ApiSettings,
        key: Optional[str],
        concurrency: int = 4,
        timeout: float = 120.0,
        retries: int = 5,
        opener: Optional[Callable[..., object]] = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.settings = settings
        self.key = key
        self.concurrency = max(1, concurrency)
        self.timeout = timeout
        self.retries = max(0, retries)
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        # verbose_json also returns the detected language; providers that refuse it get plain json.
        self._verbose = True
        self._lock = threading.Lock()

    @property
    def label(self) -> str:
        return f"{self.settings.model} via {self.settings.provider} ({self.settings.base_url})"

    def load(self):
        if not self.key:
            names = " or ".join(KEY_VARIABLES[self.settings.provider])
            raise ApiError(
                f"Transcription is set to use {self.settings.provider}, but this worker has no API key: set {names} in the worker's .env and restart it."
            )
        return self

    # ------------------------------------------------------------ one request

    def _request(self, wav: bytes, context: str, language: Optional[str], verbose: bool) -> dict:
        s = self.settings
        fields: Dict[str, str] = {"model": s.model, "response_format": "verbose_json" if verbose else "json", "temperature": "0"}
        if language:
            fields["language"] = language
        if context:
            fields["prompt"] = context[:2000]
        headers = {"Authorization": f"Bearer {self.key}", "Accept": "application/json"}
        if s.provider == "openrouter":
            payload = {**fields, "temperature": 0, "input_audio": {"data": base64.b64encode(wav).decode("ascii"), "format": "wav"}}
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
            # OpenRouter's optional app attribution; names the software, not this server.
            headers["X-Title"] = "Minutes (self-hosted meeting transcription)"
        else:
            data, content_type = _multipart(fields, wav)
            headers["Content-Type"] = content_type
        req = urllib.request.Request(s.base_url + "/audio/transcriptions", data=data, method="POST", headers=headers)
        try:
            with self._open(req, timeout=self.timeout) as res:  # type: ignore[attr-defined]
                body = res.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace") if e.fp else ""
            raise self._http_error(e.code, body, e.headers.get("Retry-After") if e.headers else None) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            reason = getattr(e, "reason", e)
            raise ApiError(f"Could not reach {s.base_url}: {reason}", retryable=True) from None
        try:
            parsed = json.loads(body)
        except ValueError:
            # A server asked for json that answers with plain text.
            return {"text": body.strip()}
        if isinstance(parsed, dict) and parsed.get("error"):
            raise ApiError(f"{s.provider} returned an error: {_error_message(body)}", retryable=True)
        return parsed if isinstance(parsed, dict) else {"text": str(parsed)}

    def _http_error(self, status: int, body: str, retry_after: Optional[str]) -> ApiError:
        s = self.settings
        msg = _error_message(body)
        if status == 401:
            names = " or ".join(KEY_VARIABLES[s.provider])
            err = ApiError(f"{s.provider} rejected the API key (HTTP 401: {msg}). Check {names} in the worker's .env.", status)
        elif status == 402:
            err = ApiError(f"{s.provider} says the account is out of credit (HTTP 402: {msg}).", status)
        elif status == 403:
            err = ApiError(f"{s.provider} refused the request (HTTP 403: {msg}).", status)
        elif status == 404:
            err = ApiError(f"{s.provider} does not offer the transcription model {s.model!r} at {s.base_url} (HTTP 404: {msg}).", status)
        elif status in (408, 409, 425, 429) or status >= 500:
            err = ApiError(f"{s.provider} is busy or failing (HTTP {status}: {msg}).", status, retryable=True)
        else:
            err = ApiError(f"{s.provider} refused the request (HTTP {status}: {msg}).", status)
        try:
            err.retry_after = float(retry_after) if retry_after else None
        except ValueError:
            err.retry_after = None
        return err

    def transcribe_one(self, clip: np.ndarray, sr: int, context: str = "", language: Optional[str] = None, canceled=None) -> Tuple[str, str]:
        """(language, text) for one clip, retrying what may succeed later."""
        wav = encode_wav(clip, sr)
        code = language_code(language)
        delay = 1.0
        attempt = 0
        while True:
            with self._lock:
                verbose = self._verbose
            try:
                out = self._request(wav, context, code, verbose)
            except ApiError as e:
                if verbose and e.status in (400, 422):
                    # Some providers accept only plain json; remember that and ask again.
                    with self._lock:
                        self._verbose = False
                    log.info("%s refused verbose_json (%s); using json", self.settings.provider, e)
                    try:
                        out = self._request(wav, context, code, False)
                    except ApiError as e2:
                        with self._lock:
                            self._verbose = True  # it was not the response format after all
                        e = e2
                    else:
                        return self._parse(out, language)
                if not e.retryable or attempt >= self.retries or (canceled and canceled()):
                    raise e
                wait_for = e.retry_after or delay * (0.75 + random.random() / 2)
                log.warning("%s; retrying in %.0fs", e, wait_for)
                self._sleep(min(wait_for, 60.0))
                delay = min(delay * 2, 30.0)
                attempt += 1
                continue
            return self._parse(out, language)

    @staticmethod
    def _parse(out: dict, requested: Optional[str]) -> Tuple[str, str]:
        text = out.get("text")
        text = text if isinstance(text, str) else ""
        lang = language_name(out.get("language") if isinstance(out.get("language"), str) else None)
        raw = _QWEN_RAW.match(text)
        if raw:
            lang = lang or language_name(raw.group(1))
            text = text[raw.end() :]
        if not lang and requested and requested.lower() != "auto":
            lang = requested
        return lang, text.strip()

    # ---------------------------------------------------------------- batches

    def transcribe(
        self,
        clips: Sequence[np.ndarray],
        sr: int,
        context: str = "",
        language: Optional[str] = None,
        progress: Optional[Callable[[float], bool]] = None,
    ) -> List[Tuple[str, str]]:
        """Transcribe clips, ``concurrency`` requests at a time, in their original order.

        ``progress`` receives the completed fraction and may return False to abort.
        """
        self.load()
        results: List[Optional[Tuple[str, str]]] = [None] * len(clips)
        stop = threading.Event()
        done = 0
        pool = ThreadPoolExecutor(max_workers=self.concurrency, thread_name_prefix="asr-api")
        pending: Dict[Future, int] = {}
        queue = iter(range(len(clips)))

        def submit_next() -> None:
            i = next(queue, None)
            if i is not None:
                pending[pool.submit(self.transcribe_one, clips[i], sr, context, language, stop.is_set)] = i

        try:
            for _ in range(self.concurrency):
                submit_next()
            while pending:
                finished, _ = wait(list(pending), return_when=FIRST_COMPLETED)
                for f in finished:
                    i = pending.pop(f)
                    results[i] = f.result()  # raises the clip's error
                    done += 1
                    submit_next()
                if progress is not None and progress(done / max(1, len(clips))) is False:
                    raise InterruptedError("canceled")
        except BaseException:
            # Canceled or failed: queue nothing more, and do not wait for requests in flight.
            stop.set()
            pool.shutdown(wait=False, cancel_futures=True)
            raise
        pool.shutdown(wait=True)
        return [r or ("", "") for r in results]
