"""The supervisor must not touch the GPU while idle and must release it after work."""

import json
import sys
import threading
import time
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from mm_worker.config import WorkerConfig
from mm_worker.gpus import parse_gpus
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


def cfg(url, keepalive=0.0, gpus=("0",)):
    return WorkerConfig(
        server_url=url, token="t", worker_id="test-gpu0", worker_name="test", device="cpu", hf_token=None,
        asr_model="fake", asr_backend="fake", asr_batch_size=4, asr_max_new_tokens=64,
        diarization_model="fake", max_segment_sec=30.0, poll_interval=0.2, model_keepalive_sec=keepalive,
        gpus=list(gpus),
    )


def test_gpu_session_loads_on_demand_drains_queue_and_exits(two_speaker_wav, tmp_path):
    jobs = [
        {"jobId": f"j{i}", "meetingId": f"m{i}", "attempt": 1, "mediaPath": str(two_speaker_wav), "outDir": str(tmp_path / f"m{i}"), "options": {"diarize": True, "script": "zh-TW"}, "title": "t"}
        for i in range(2)
    ]
    backend = FakeBackend(jobs)
    sup = Supervisor(cfg(backend.url))
    gpu = sup.workers[0]
    assert gpu.info()["state"] == "idle" and gpu.info()["modelsLoaded"] is False
    # Nothing is known about speaker diarization before a session has loaded it.
    assert gpu.info()["diarization"] == "unknown"

    t = threading.Thread(target=sup.run, daemon=True)
    t.start()
    import time

    deadline = time.time() + 45
    while time.time() < deadline:
        paths = backend.paths()
        if paths.count("/jobs/j0/complete") and paths.count("/jobs/j1/complete") and gpu.child is None:
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
    assert gpu.child is None and gpu.models_loaded is False
    # The long-lived supervisor never imported torch (so it never created a CUDA context).
    assert "torch" not in sys.modules
    # After the session, the worker reports what loading actually found.
    assert gpu.info()["diarization"] == "ready" and gpu.info()["diarizationError"] is None
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
        if "/jobs/v0/complete" in paths and "/jobs/t1/complete" in paths and sup.workers[0].child is None:
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
    # The session sets these for its GPU; restore them afterwards.
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "0")
    monkeypatch.setenv("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
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


# ------------------------------------------------- choosing the GPU (nvidia-smi mocked)

# GPU 0: 23.2 GB free, GPU 1: 5.9 GB (another program), GPU 2: 12.3 GB, GPU 3: 20.4 GB.
SMI = """\
0, GPU-aaaa, NVIDIA GeForce RTX 4090, 24564, 819
1, GPU-bbbb, NVIDIA GeForce RTX 4090, 24564, 18534
2, GPU-cccc, NVIDIA GeForce RTX 4090, 24564, 12000
3, GPU-dddd, NVIDIA GeForce RTX 4090, 24564, 3686
"""


def multi_gpu_cfg(gpus):
    return replace(cfg("http://unused", gpus=gpus), worker_id="box", worker_name="box")


class Stubbed:
    """A supervisor whose claims and GPU sessions are recorded instead of sent or spawned."""

    def __init__(self, gpus, query, jobs):
        self.sup = Supervisor(multi_gpu_cfg(gpus), query=query)
        self.jobs = [{"jobId": j} for j in jobs]
        self.claims = []
        self.started = []
        for w in self.sup.workers:
            w.client.heartbeat = lambda *a: None
            w.client.claim = lambda w=w: self._claim(w)
            w.start_session = lambda job, w=w: self._start(w, job)

    def _claim(self, w):
        self.claims.append(w.cfg.worker_id)
        return self.jobs.pop(0) if self.jobs else None

    def _start(self, w, job):
        self.started.append((job["jobId"], w.cfg.worker_id))
        w.child = object()  # busy until the test ends its session

    def run(self):
        self.thread = threading.Thread(target=self.sup.run, daemon=True)
        self.thread.start()
        return self

    def wait_started(self, n, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline and len(self.started) < n:
            time.sleep(0.02)
        return self.started

    def stop(self):
        self.sup.stop.set()
        self.thread.join(timeout=5)


def test_each_gpu_is_its_own_worker():
    sup = Supervisor(multi_gpu_cfg(["0", "1"]))
    assert [(w.gpu, w.cfg.worker_id, w.cfg.worker_name) for w in sup.workers] == [("0", "box-gpu0", "box-gpu0"), ("1", "box-gpu1", "box-gpu1")]
    assert [w.cfg.gpus for w in sup.workers] == [["0"], ["1"]]


def test_job_goes_to_the_gpu_with_the_most_free_memory():
    s = Stubbed(["0", "1", "2", "3"], lambda: parse_gpus(SMI), ["j0"]).run()
    started = s.wait_started(1)
    time.sleep(0.5)
    s.stop()
    # GPU 0 (23.2 GB free), not GPU 1, which another program had filled to 18.1 GB.
    assert started == [("j0", "box-gpu0")]
    assert s.claims[0] == "box-gpu0" and "box-gpu1" not in s.claims


def test_jobs_wait_while_no_gpu_has_room():
    full = "".join(f"{i}, GPU-{i}, NVIDIA GeForce RTX 4090, 24564, 20000\n" for i in range(4))
    smi = {"csv": full}
    s = Stubbed(["0", "1", "2", "3"], lambda: parse_gpus(smi["csv"]), ["j0"]).run()
    time.sleep(1.0)
    # Every GPU has under 8 GB free: nothing is claimed, so the job stays queued.
    assert s.claims == [] and s.started == []
    smi["csv"] = full.replace("2, GPU-2, NVIDIA GeForce RTX 4090, 24564, 20000", "2, GPU-2, NVIDIA GeForce RTX 4090, 24564, 1000")
    started = s.wait_started(1)
    s.stop()
    assert started == [("j0", "box-gpu2")]


def test_jobs_starting_together_get_different_gpus():
    s = Stubbed(["0", "1", "2", "3"], lambda: parse_gpus(SMI), ["j0", "j1", "j2", "j3"]).run()
    started = s.wait_started(3)
    time.sleep(0.5)
    # Most free memory first and one session per GPU; GPU 1 never has room, so j3 waits.
    assert started == [("j0", "box-gpu0"), ("j1", "box-gpu3"), ("j2", "box-gpu2")]
    assert [j["jobId"] for j in s.jobs] == ["j3"]
    # When GPU 3's session ends, it is the GPU with the most room again.
    s.sup.workers[3].child = None
    started = s.wait_started(4)
    s.stop()
    assert started[3] == ("j3", "box-gpu3")


def test_no_job_is_claimed_while_gpu_memory_cannot_be_read():
    def broken():
        raise OSError("nvidia-smi: driver/library version mismatch")

    sup = Supervisor(multi_gpu_cfg(["0", "1"]), query=broken)
    assert sup.pick(sup.workers) is None
    # Without nvidia-smi at all there is nothing to check, as before.
    sup = Supervisor(multi_gpu_cfg(["0", "1"]), query=lambda: None)
    assert sup.pick(sup.workers) is sup.workers[0]


def test_cpu_worker_ignores_gpu_memory():
    # A real (not fake) CPU worker on a machine whose GPUs are full still takes jobs.
    sup = Supervisor(replace(multi_gpu_cfg(["0"]), asr_backend="transformers", device="cpu"))
    assert sup.query is None and sup.pick(sup.workers) is sup.workers[0]
    assert Supervisor(replace(multi_gpu_cfg(["0"]), asr_backend="transformers", device="cuda:0")).query is not None
