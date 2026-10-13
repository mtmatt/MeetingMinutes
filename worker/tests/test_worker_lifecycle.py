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
    # Nothing is known about speaker diarization before a session has loaded it.
    assert sup.info()["diarization"] == "unknown"

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
    # After the session, the worker reports what loading actually found.
    assert sup.info()["diarization"] == "ready" and sup.info()["diarizationError"] is None
    complete = next(b for p, b in backend.events if p == "/jobs/j0/complete")
    assert complete["result"]["segments"] and complete["result"]["speakers"] == ["SPEAKER_00", "SPEAKER_01"]


def test_voiceprint_and_transcription_jobs_share_a_session(two_speaker_wav, tmp_path):
    import time

    jobs = [
        {"jobId": "v0", "kind": "voiceprint", "meetingId": "m0", "attempt": 1, "mediaPath": str(two_speaker_wav),
         "outDir": str(tmp_path / "m0"), "options": {"speakers": {"SPEAKER_00": [[0, 3]], "SPEAKER_01": [[4, 8]]}}, "title": "old"},
        {"jobId": "t1", "meetingId": "m1", "attempt": 1, "mediaPath": str(two_speaker_wav), "outDir": str(tmp_path / "m1"),
         "options": {"diarize": True}, "title": "new"},
    ]
    backend = FakeBackend(jobs)
    sup = Supervisor(cfg(backend.url))
    t = threading.Thread(target=sup.run, daemon=True)
    t.start()
    deadline = time.time() + 45
    while time.time() < deadline:
        paths = backend.paths()
        if "/jobs/v0/complete" in paths and "/jobs/t1/complete" in paths and sup.child is None:
            break
        time.sleep(0.1)
    sup.stop.set()
    t.join(timeout=5)

    # The worker says which kinds of job it can run, so older workers are never handed a voiceprint.
    claims = [b for p, b in backend.events if p == "/jobs/claim"]
    assert claims and all(b["kinds"] == ["transcribe", "voiceprint"] for b in claims)
    voiceprint = next(b for p, b in backend.events if p == "/jobs/v0/complete")["result"]
    assert set(voiceprint) == {"voiceModel", "voices"} and set(voiceprint["voices"]) == {"SPEAKER_00", "SPEAKER_01"}
    # The transcription that followed in the same session loaded the ASR model on demand.
    transcript = next(b for p, b in backend.events if p == "/jobs/t1/complete")["result"]
    assert transcript["segments"] and transcript["voiceModel"] == "fake" and set(transcript["voices"]) == set(transcript["speakers"])
    assert len([b for p, b in backend.events if p.endswith("/progress") and b["stage"] == "loading"]) == 1


def test_asr_model_failing_to_load_mid_session_is_retryable(two_speaker_wav, tmp_path, monkeypatch):
    """A session that began with a voiceprint loads the ASR model later; if that fails, the transcription is retried, not failed."""
    from mm_worker import worker as worker_mod

    calls = {"n": 0}

    def broken_transcriber(cfg):
        calls["n"] += 1
        raise OSError("weights file is corrupt")

    monkeypatch.setattr(worker_mod, "load_transcriber", broken_transcriber)
    # Leave pytest's own Ctrl-C handling alone.
    monkeypatch.setattr(worker_mod.signal, "signal", lambda *a: None)
    jobs = [
        {"jobId": "v0", "kind": "voiceprint", "meetingId": "m0", "attempt": 1, "mediaPath": str(two_speaker_wav),
         "outDir": str(tmp_path / "m0"), "options": {"speakers": {"SPEAKER_00": [[0, 3]]}}, "title": "old"},
        {"jobId": "t1", "meetingId": "m1", "attempt": 1, "mediaPath": str(two_speaker_wav), "outDir": str(tmp_path / "m1"),
         "options": {"diarize": True}, "title": "new"},
    ]
    backend = FakeBackend(jobs[1:])

    class Events:
        def put(self, item):
            pass

    # In this process (and on the main thread, for its signal handlers) so the monkeypatch applies.
    worker_mod.gpu_session(cfg(backend.url), jobs[0], Events())
    paths = backend.paths()
    assert "/jobs/v0/complete" in paths
    fail = next(b for p, b in backend.events if p == "/jobs/t1/fail")
    assert fail["retryable"] is True and fail["error"].startswith("Could not load models: OSError")
    # The session gave up instead of trying (and failing) again for further jobs.
    assert calls["n"] == 1
