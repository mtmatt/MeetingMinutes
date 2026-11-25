"""Minimal client for the backend's /internal worker API (stdlib only).

Workers only ever connect out to the backend: on this machine over loopback,
or from another machine over HTTPS with its own token. For those, it also
downloads a job's recording (resuming with byte ranges) and uploads the files
it makes, in chunks.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("mm_worker.client")


@lru_cache(maxsize=1)
def tls_context() -> ssl.SSLContext:
    """Verifies the server's certificate: against MM_CA_FILE when set (a self-signed
    certificate), else the system's trust store, falling back to certifi's bundle
    where the system's is not found (some Python builds on macOS)."""
    ca = os.environ.get("MM_CA_FILE", "").strip()
    if ca:
        return ssl.create_default_context(cafile=ca)
    ctx = ssl.create_default_context()
    if not ctx.cert_store_stats().get("x509_ca"):
        try:
            import certifi

            ctx.load_verify_locations(certifi.where())
        except ImportError:  # pragma: no cover
            pass
    return ctx


def _open(req: urllib.request.Request, timeout: float):
    if req.full_url.startswith("https://"):
        return urllib.request.urlopen(req, timeout=timeout, context=tls_context())
    return urllib.request.urlopen(req, timeout=timeout)


def is_loopback_host(host: str) -> bool:
    """Whether a URL's host is this machine: "localhost" or a loopback address
    (not a name that merely starts like one, such as 127.0.0.1.example.com)."""
    host = host.lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def check_server_url(url: str) -> str:
    """HTTPS, except to this machine: a remote worker's token and the recordings travel over this."""
    url = url.strip().rstrip("/")
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    loopback = is_loopback_host(host)
    if parts.scheme not in ("https", "http") or not host or (parts.scheme == "http" and not loopback):
        raise ValueError(f"Use the server's https:// address (got {url!r}).")
    return url


def enroll(server_url: str, code: str, timeout: float = 30.0) -> dict:
    """Trade a one-time enrollment code for this machine's token: {workerId, name, token}."""
    url = check_server_url(server_url)
    req = urllib.request.Request(
        url + "/internal/enroll", data=json.dumps({"code": code.strip()}).encode(), method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with _open(req, timeout) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            msg = json.loads(body).get("error") or body
        except ValueError:
            msg = body
        raise SystemExit(f"Enrollment refused (HTTP {e.code}): {msg[:300]}") from None
    except urllib.error.URLError as e:
        raise SystemExit(f"Could not reach {url}: {e.reason}") from None


class ServerError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


class BackendClient:
    def __init__(self, base_url: str, token: str, worker_id: str, timeout: float = 60.0, capabilities: Optional[dict] = None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.worker_id = worker_id
        self.timeout = timeout
        # What this worker can run ({"asr": [...], "diarization": [...]}), so the backend
        # hands it only transcriptions it can do with the current settings.
        self.capabilities = capabilities

    def _post(self, path: str, payload: dict, retries: int = 5) -> tuple[int, Any]:
        data = json.dumps({"workerId": self.worker_id, **payload}).encode()
        delay = 1.0
        for attempt in range(retries + 1):
            req = urllib.request.Request(
                self.base_url + "/internal" + path,
                data=data,
                method="POST",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
            )
            try:
                with _open(req, self.timeout) as res:
                    body = res.read().decode() if res.status != 204 else ""
                    return res.status, (json.loads(body) if body else None)
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors="replace")
                if e.code in (409,):
                    return e.code, json.loads(body) if body.startswith("{") else None
                if e.code >= 500 and attempt < retries:
                    log.warning("server error on %s (%s); retrying in %.0fs", path, e.code, delay)
                else:
                    raise ServerError(e.code, body) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt >= retries:
                    raise
                log.warning("cannot reach backend (%s); retrying in %.0fs", e, delay)
            time.sleep(delay)
            delay = min(delay * 2, 30.0)
        raise RuntimeError("unreachable")

    def heartbeat(self, name: str, info: dict) -> dict:
        """The backend answers with what workers should know, such as where
        transcription runs: {"transcriber": {"engine": "local" | "api"}}."""
        _, body = self._post("/worker/heartbeat", {"name": name, "info": info}, retries=0)
        return body if isinstance(body, dict) else {}

    # Job kinds this worker can run; the backend hands older workers transcriptions only.
    KINDS = ["transcribe", "voiceprint"]

    def claim(self, kinds: Optional[list] = None) -> Optional[dict]:
        payload: dict = {"kinds": kinds or self.KINDS}
        if self.capabilities:
            payload["capabilities"] = self.capabilities
        status, body = self._post("/jobs/claim", payload)
        return body["job"] if status == 200 and body else None

    def progress(self, job_id: str, stage: str, progress: float) -> bool:
        _, body = self._post(f"/jobs/{job_id}/progress", {"stage": stage, "progress": progress})
        return bool(body and body.get("continue"))

    def complete(self, job_id: str, result: dict) -> bool:
        status, _ = self._post(f"/jobs/{job_id}/complete", {"result": result}, retries=8)
        return status == 200

    def fail(self, job_id: str, error: str, retryable: bool) -> None:
        self._post(f"/jobs/{job_id}/fail", {"error": error[:4000], "retryable": retryable}, retries=8)

    # ------------------------------------------------- remote workers: media

    def _url(self, path: str, **query) -> str:
        q = urllib.parse.urlencode({"workerId": self.worker_id, **query})
        # The server's addresses may carry a query of their own (…/media?variant=audio).
        return f"{self.base_url}{path}{'&' if '?' in path else '?'}{q}"

    def download(
        self,
        path: str,
        dest: Path,
        size: Optional[int],
        progress: Optional[Callable[[float], None]] = None,
        retries: int = 6,
        on_wait: Optional[Callable[[], None]] = None,
        max_wait_sec: float = 1800.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> dict:
        """A job's recording into ``dest``, resuming where an interrupted transfer stopped.

        ``size`` may be None (the audio-only copy is made when first asked for):
        it is then taken from the response. A 202 means the server is still
        making the file: ``on_wait`` is called (it may raise to give up) and the
        request is sent again after Retry-After, for up to ``max_wait_sec``.
        Returns the headers of the last response (lower-case names).
        """
        delay = 2.0
        attempt = 0
        waited = 0.0
        headers_seen: dict = {}
        while True:
            have = dest.stat().st_size if dest.exists() else 0
            if size is not None and have >= size:
                break
            headers = {"Authorization": f"Bearer {self.token}"}
            if have:
                headers["Range"] = f"bytes={have}-"
            req = urllib.request.Request(self._url(path), headers=headers)
            try:
                with _open(req, max(self.timeout, 120)) as res:
                    headers_seen = {k.lower(): v for k, v in res.headers.items()}
                    if res.status == 202:
                        res.read()
                        if waited >= max_wait_sec:
                            raise ServerError(504, f"the server did not have the recording ready within {max_wait_sec / 60:.0f} minutes")
                        if on_wait:
                            on_wait()
                        try:
                            pause = min(30.0, max(1.0, float(headers_seen.get("retry-after") or 3)))
                        except ValueError:
                            pause = 3.0
                        sleep(pause)
                        waited += pause
                        continue
                    if have and res.status != 206:
                        have = 0  # the server sent it whole: start over
                    if size is None:
                        total = headers_seen.get("content-range", "").rpartition("/")[2]
                        if total.isdigit():
                            size = int(total)
                        elif res.status == 200 and str(headers_seen.get("content-length", "")).isdigit():
                            size = int(headers_seen["content-length"])
                    with open(dest, "r+b" if have else "wb") as out:
                        out.seek(have)
                        while True:
                            buf = res.read(1 << 20)
                            if not buf:
                                break
                            out.write(buf)
                            have += len(buf)
                            if progress and size:
                                progress(min(1.0, have / size))
                if size is None or have >= size:
                    break
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 404, 409) or attempt >= retries:
                    raise ServerError(e.code, e.read().decode(errors="replace")) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                if attempt >= retries:
                    raise
                log.warning("download interrupted (%s); resuming in %.0fs", e, delay)
            attempt += 1
            sleep(delay)
            delay = min(delay * 2, 30.0)
        if size is not None and dest.stat().st_size != size:
            raise ServerError(500, f"downloaded {dest.stat().st_size} of {size} bytes")
        return headers_seen

    def upload(self, path: str, name: str, src: Path, chunk_bytes: int, retries: int = 6) -> None:
        """A file this worker made, in chunks; resumes from what the server says it has."""
        total = src.stat().st_size
        offset = 0
        chunk_bytes = max(64 * 1024, min(chunk_bytes, 32 * 1024 * 1024))
        failures = 0
        delay = 2.0
        with open(src, "rb") as f:
            while offset < total or total == 0:
                f.seek(offset)
                data = f.read(chunk_bytes)
                req = urllib.request.Request(
                    self._url(f"{path}/{urllib.parse.quote(name)}", offset=offset),
                    data=data,
                    method="PUT",
                    headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/octet-stream"},
                )
                try:
                    with _open(req, max(self.timeout, 120)) as res:
                        offset = int(json.loads(res.read().decode())["received"])
                    failures = 0
                    if total == 0:
                        break
                    continue
                except urllib.error.HTTPError as e:
                    body = e.read().decode(errors="replace")
                    if e.code == 409 and body.startswith("{") and "received" in body:
                        offset = int(json.loads(body)["received"])  # resume where the server is
                        continue
                    if e.code < 500 or failures >= retries:
                        raise ServerError(e.code, body) from None
                except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                    if failures >= retries:
                        raise
                    log.warning("upload interrupted (%s); resuming in %.0fs", e, delay)
                failures += 1
                time.sleep(delay)
                delay = min(delay * 2, 30.0)
