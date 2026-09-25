"""Minimal JSON client for the backend's /internal worker API (stdlib only)."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any, Optional

log = logging.getLogger("mm_worker.client")


class ServerError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


class BackendClient:
    def __init__(self, base_url: str, token: str, worker_id: str, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.worker_id = worker_id
        self.timeout = timeout

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
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
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

    def heartbeat(self, name: str, info: dict) -> None:
        self._post("/worker/heartbeat", {"name": name, "info": info}, retries=0)

    def claim(self) -> Optional[dict]:
        status, body = self._post("/jobs/claim", {})
        return body["job"] if status == 200 and body else None

    def progress(self, job_id: str, stage: str, progress: float) -> bool:
        _, body = self._post(f"/jobs/{job_id}/progress", {"stage": stage, "progress": progress})
        return bool(body and body.get("continue"))

    def complete(self, job_id: str, result: dict) -> bool:
        status, _ = self._post(f"/jobs/{job_id}/complete", {"result": result}, retries=8)
        return status == 200

    def fail(self, job_id: str, error: str, retryable: bool) -> None:
        self._post(f"/jobs/{job_id}/fail", {"error": error[:4000], "retryable": retryable}, retries=8)
