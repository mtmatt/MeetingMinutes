"""The supervisor must not touch the GPU while idle and must release it after work."""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from mm_worker.config import WorkerConfig
from mm_worker.worker import Supervisor


class FakeBackend:
    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.events = []
        self.lock = threading.Lock()
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                path = self.path.removeprefix("/internal")
                with backend.lock:
                    backend.events.append((path, body))
                    if path == "/jobs/claim":
                        if backend.jobs:
                            return self._send(200, {"job": backend.jobs.pop(0)})
                        return self._send(204, None)
                    if path.endswith("/progress"):
                        return self._send(200, {"continue": True})
                    return self._send(200, {"ok": True, "accepted": True})

            def _send(self, code, payload):
                self.send_response(code)
                data = b"" if payload is None else json.dumps(payload).encode()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def paths(self):
        with self.lock:
            return [p for p, _ in self.events]


def cfg(url, keepalive=0.0):
    return WorkerConfig(
        server_url=url, token="t", worker_id="test-gpu0", worker_name="test", device="cpu", hf_token=None,
        asr_model="fake", asr_backend="fake", asr_batch_size=4, asr_max_new_tokens=64,
        diarization_model="fake", max_segment_sec=30.0, poll_interval=0.2, model_keepalive_sec=keepalive,
    )


def test_gpu_session_loads_on_demand_drains_queue_and_exits(two_speaker_wav, tmp_path):
    jobs = [
        {"jobId": f"j{i}", "meetingId": f"m{i}", "attempt": 1, "mediaPath": str(two_speaker_wav), "outDir": str(tmp_path / f"m{i}"), "options": {"diarize": True, "script": "zh-TW"}, "title": "t"}
        for i in range(2)
    ]
    backend = FakeBackend(jobs)
    sup = Supervisor(cfg(backend.url))
    assert sup.info()["state"] == "idle" and sup.info()["modelsLoaded"] is False

    t = threading.Thread(target=sup.run, daemon=True)
    t.start()
    import time

    deadline = time.time() + 45
    while time.time() < deadline:
        paths = backend.paths()
        if paths.count("/jobs/j0/complete") and paths.count("/jobs/j1/complete") and sup.child is None:
            break
        time.sleep(0.1)
    sup.stop.set()
    t.join(timeout=5)

    paths = backend.paths()
    assert "/jobs/j0/complete" in paths and "/jobs/j1/complete" in paths
    # Both jobs ran in one GPU session: models loaded once, then the process exited.
    progress = [b for p, b in backend.events if p == "/jobs/j0/progress"]
    assert progress[0]["stage"] == "loading"
    assert not [b for p, b in backend.events if p == "/jobs/j1/progress" and b["stage"] == "loading"]
    assert sup.child is None and sup.models_loaded is False
    # The long-lived supervisor never imported torch (so it never created a CUDA context).
    assert "torch" not in sys.modules
    complete = next(b for p, b in backend.events if p == "/jobs/j0/complete")
    assert complete["result"]["segments"] and complete["result"]["speakers"] == ["SPEAKER_00", "SPEAKER_01"]
