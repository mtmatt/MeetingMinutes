"""A worker on another machine: enrollment, downloading the recording, uploading its files."""

import json
import os
import stat
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from mm_worker import client as client_mod
from mm_worker import config as config_mod
from mm_worker.config import WorkerConfig


class FakeServer:
    """The server's worker API for a remote worker: enroll, claim, media (with ranges), file uploads."""

    def __init__(self, media: bytes, jobs, cut_first_download=False):
        self.media = media
        self.jobs = list(jobs)
        self.cut = cut_first_download
        self.events = []
        self.files = {}
        self.lock = threading.Lock()
        srv = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, payload=None, raw=None, headers=None):
                data = raw if raw is not None else (b"" if payload is None else json.dumps(payload).encode())
                self.send_response(code)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _auth(self):
                return self.headers.get("Authorization") == "Bearer mmw_wkabc.secret"

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                path = self.path.removeprefix("/internal")
                with srv.lock:
                    srv.events.append(("POST", path, body))
                if path == "/enroll":
                    if body.get("code") == "mme_good":
                        return self._send(200, {"workerId": "wkabc", "name": "Mac", "token": "mmw_wkabc.secret"})
                    return self._send(403, {"error": "This enrollment code is unknown, already used or expired."})
                if not self._auth():
                    return self._send(401, {"error": "bad token"})
                if path == "/jobs/claim":
                    with srv.lock:
                        if srv.jobs and "transcribe" in body.get("kinds", []):
                            return self._send(200, {"job": srv.jobs.pop(0)})
                    return self._send(204)
                if path.endswith("/progress"):
                    return self._send(200, {"continue": True})
                return self._send(200, {"ok": True, "accepted": True})

            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                q = urllib.parse.parse_qs(parsed.query)
                with srv.lock:
                    srv.events.append(("GET", parsed.path, {"range": self.headers.get("Range"), **{k: v[0] for k, v in q.items()}}))
                if not self._auth() or q.get("workerId") != ["wkabc"]:
                    return self._send(403, {"error": "no"})
                rng = self.headers.get("Range")
                start = int(rng.split("=")[1].split("-")[0]) if rng else 0
                data = srv.media[start:]
                if srv.cut and not rng:
                    # The connection drops halfway: the worker must resume with a range.
                    srv.cut = False
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data[: len(data) // 2])
                    self.wfile.flush()
                    self.connection.shutdown(2)
                    return
                headers = {"Content-Range": f"bytes {start}-{len(srv.media) - 1}/{len(srv.media)}"} if rng else {}
                return self._send(206 if rng else 200, raw=data, headers=headers)

            def do_PUT(self):
                parsed = urllib.parse.urlsplit(self.path)
                q = urllib.parse.parse_qs(parsed.query)
                data = self.rfile.read(int(self.headers["Content-Length"]))
                name = parsed.path.rsplit("/", 1)[1]
                offset = int(q["offset"][0])
                with srv.lock:
                    srv.events.append(("PUT", parsed.path, {"offset": offset, "len": len(data)}))
                    have = srv.files.get(name, b"")
                    if offset != len(have):
                        return self._send(409, {"error": "Offset mismatch.", "received": len(have)})
                    srv.files[name] = have + data
                    return self._send(200, {"received": len(srv.files[name])})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()


def remote_cfg(url):
    return WorkerConfig(
        server_url=url, token="mmw_wkabc.secret", worker_id="wkabc", worker_name="Mac", device="cpu", hf_token=None,
        asr_model="fake", asr_backend="fake", asr_batch_size=4, asr_max_new_tokens=64,
        diarization_model="fake", max_segment_sec=30.0, poll_interval=0.2, model_keepalive_sec=0.0,
        gpus=["0"], remote=True,
    )


def job(**extra):
    return {
        "jobId": "j1", "meetingId": "m1", "attempt": 1, "title": "Remote", "kind": "transcribe",
        "options": {"diarize": True, "script": "zh-TW"},
        "media": {"url": "/internal/jobs/j1/media", "size": None, "ext": "mp3"},
        "uploads": {"url": "/internal/jobs/j1/files", "files": ["playback.m4a", "peaks.json"], "chunkBytes": 65536},
        **extra,
    }


class Events:
    def put(self, item):
        pass


def run_session(cfg, first, monkeypatch, tmp_path):
    from mm_worker import worker as worker_mod

    monkeypatch.setattr(worker_mod.signal, "signal", lambda *a: None)
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "0")
    monkeypatch.setenv("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
    work = tmp_path / "tmp"
    work.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(work))
    worker_mod.gpu_session(cfg, first, Events())
    return work


def test_remote_job_downloads_resumes_uploads_and_cleans_up(two_speaker_wav, tmp_path, monkeypatch):
    media = Path(two_speaker_wav).read_bytes()
    srv = FakeServer(media, [], cut_first_download=True)
    try:
        work = run_session(remote_cfg(srv.url), job(media={"url": "/internal/jobs/j1/media", "size": len(media), "ext": "mp3"}), monkeypatch, tmp_path)
    finally:
        srv.close()
    gets = [e for e in srv.events if e[0] == "GET"]
    # Interrupted, then resumed from where it stopped.
    assert gets[0][2]["range"] is None and gets[1][2]["range"].startswith("bytes=") and gets[1][2]["workerId"] == "wkabc"
    complete = next(e for e in srv.events if e[1] == "/jobs/j1/complete")[2]
    assert complete["workerId"] == "wkabc" and complete["result"]["speakers"] == ["SPEAKER_00", "SPEAKER_01"]
    # The playback copy and waveform went up (the copy in several 64 KB chunks) before completing.
    assert srv.files["playback.m4a"][:12].find(b"ftyp") != -1 and json.loads(srv.files["peaks.json"])["peaks"]
    puts = [e for e in srv.events if e[0] == "PUT" and e[1].endswith("playback.m4a")]
    assert [p[2]["offset"] for p in puts] == sorted(p[2]["offset"] for p in puts)
    order = [e[1] for e in srv.events]
    assert order.index("/jobs/j1/complete") > max(i for i, e in enumerate(srv.events) if e[0] == "PUT")
    stages = [e[2]["stage"] for e in srv.events if e[1] == "/jobs/j1/progress"]
    assert "downloading" in stages and "uploading" in stages
    # Nothing of the meeting is left on this machine.
    assert list(work.iterdir()) == []


def test_remote_job_that_is_no_longer_ours_stops_quietly(tmp_path, monkeypatch):
    """Canceled meanwhile (the server answers 409): no failure is reported and nothing is left behind."""
    srv = FakeServer(b"", [])

    def gone(*a, **k):
        raise client_mod.ServerError(409, '{"code":"not_running"}')

    monkeypatch.setattr(client_mod.BackendClient, "download", gone)
    try:
        work = run_session(remote_cfg(srv.url), job(), monkeypatch, tmp_path)
    finally:
        srv.close()
    assert not [e for e in srv.events if e[1].endswith("/fail") or e[1].endswith("/complete")]
    assert list(work.iterdir()) == []


def test_enroll_saves_a_private_credential_and_config_uses_it(tmp_path, monkeypatch):
    srv = FakeServer(b"", [])
    try:
        monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
        monkeypatch.setenv("MM_SKIP_DOTENV", "1")
        for k in ("WORKER_TOKEN", "MM_SERVER_URL", "MM_WORKER_ID", "MM_WORKER_NAME", "WORKER_GPUS"):
            monkeypatch.delenv(k, raising=False)
        from mm_worker.__main__ import main

        with pytest.raises(SystemExit) as refused:
            main(["enroll", srv.url, "mme_bad"])
        assert "unknown, already used or expired" in str(refused.value)
        main(["enroll", srv.url, "mme_good"])
        path = tmp_path / "data" / "worker-credential.json"
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        saved = json.loads(path.read_text())
        assert saved == {"serverUrl": srv.url, "workerId": "wkabc", "name": "Mac", "token": "mmw_wkabc.secret"}
        cfg = config_mod.load_config()
        assert cfg.remote and cfg.token == "mmw_wkabc.secret" and cfg.server_url == srv.url
        assert cfg.worker_id == "wkabc" and cfg.worker_name == "Mac"
        # Several GPUs: one worker ID each, all under this machine's key.
        monkeypatch.setenv("WORKER_GPUS", "0,1")
        cfg = config_mod.load_config()
        assert [cfg.for_gpu(g).worker_id for g in cfg.gpus] == ["wkabc-gpu0", "wkabc-gpu1"]
    finally:
        srv.close()


def test_server_address_must_be_https_unless_local():
    assert client_mod.check_server_url("https://minutes.example.com:8443/") == "https://minutes.example.com:8443"
    assert client_mod.check_server_url("http://127.0.0.1:8787") == "http://127.0.0.1:8787"
    with pytest.raises(ValueError):
        client_mod.check_server_url("http://minutes.example.com")
    with pytest.raises(ValueError):
        client_mod.check_server_url("ftp://minutes.example.com")


def test_remote_workers_do_not_compact(tmp_path):
    from mm_worker.worker import Supervisor

    sup = Supervisor(remote_cfg("http://127.0.0.1:9"))
    started = []
    import mm_worker.worker as worker_mod

    real = worker_mod.MediaJobs
    worker_mod.MediaJobs = lambda *a, **k: started.append(1) or real(*a, **k)
    try:
        sup.stop.set()
        sup.run()
    finally:
        worker_mod.MediaJobs = real
    assert started == []
