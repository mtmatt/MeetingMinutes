"""Speaker separation by pyannoteAI, against a local stand-in, and CPU voice fingerprints."""

import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest

from mm_worker import audio, onnx_voice
from mm_worker.cloud_diarize import CloudDiarizationError, PyannoteAIDiarizer
from mm_worker.fakes import FakeEmbedder, FakeTranscriber
from mm_worker.pipeline import JobSpec, run_job

TURNS = [
    {"speaker": "SPEAKER_00", "start": 0.0, "end": 3.0},
    {"speaker": "SPEAKER_01", "start": 4.0, "end": 8.0},
    {"speaker": "SPEAKER_00", "start": 9.0, "end": 11.0},
]


class FakePyannoteAI:
    """POST /v1/media/input, PUT the upload, POST /v1/diarize, GET /v1/jobs/{id} (running, then done)."""

    def __init__(self, script=(), polls_before_done=1, final=None):
        self.requests = []
        self.uploads = {}
        self.script = list(script)
        self.polls_before_done = polls_before_done
        self.final = final or {"status": "succeeded", "output": {"exclusiveDiarization": TURNS, "diarization": TURNS}}
        self.lock = threading.Lock()
        srv = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(n) if n else b""

            def _send(self, code, payload, headers=None):
                data = json.dumps(payload).encode()
                self.send_response(code)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method):
                body = self._body()
                with srv.lock:
                    srv.requests.append({"method": method, "path": self.path, "auth": self.headers.get("Authorization"), "body": body})
                    scripted = srv.script.pop(0) if srv.script else None
                if scripted:
                    return self._send(*scripted)
                if method == "PUT" and self.path.startswith("/upload/"):
                    assert self.headers.get("Authorization") is None  # the pre-signed URL carries its own rights
                    srv.uploads[self.path] = body
                    return self._send(200, {})
                if self.headers.get("Authorization") != "Bearer pk-test":
                    return self._send(401, {"message": "Invalid API key"})
                if method == "POST" and self.path == "/v1/media/input":
                    key = json.loads(body)["url"]
                    assert key.startswith("media://")
                    return self._send(201, {"url": f"{srv.base}/upload/{key[len('media://'):]}"})
                if method == "POST" and self.path == "/v1/diarize":
                    return self._send(200, {"jobId": "job-1", "status": "created"})
                if method == "GET" and self.path == "/v1/jobs/job-1":
                    polls = sum(1 for r in srv.requests if r["path"] == "/v1/jobs/job-1")
                    if polls <= srv.polls_before_done:
                        return self._send(200, {"jobId": "job-1", "status": "running"})
                    return self._send(200, {"jobId": "job-1", **srv.final})
                return self._send(404, {"message": "not found"})

            def do_POST(self):
                self._handle("POST")

            def do_PUT(self):
                self._handle("PUT")

            def do_GET(self):
                self._handle("GET")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.url = self.base + "/v1"

    def json_body(self, path):
        return next(json.loads(r["body"]) for r in self.requests if r["path"] == path)

    def close(self):
        self.server.shutdown()


@pytest.fixture
def service():
    made = []

    def make(**kw):
        s = FakePyannoteAI(**kw)
        made.append(s)
        return s

    yield make
    for s in made:
        s.close()


def speech(sec=11.0, sr=16000):
    t = np.arange(int(sr * sec)) / sr
    return (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def diarizer(url, key="pk-test", **kw):
    kw.setdefault("sleep", lambda s: None)
    return PyannoteAIDiarizer(key, FakeEmbedder(), api_url=url, poll_sec=0, **kw)


def test_uploads_opus_and_returns_exclusive_turns(service):
    srv = service(polls_before_done=2)
    seen = []
    turns = diarizer(srv.url).run(speech(), 16000, min_speakers=2, max_speakers=4, progress=seen.append)
    assert turns == [(0.0, 3.0, "SPEAKER_00"), (4.0, 8.0, "SPEAKER_01"), (9.0, 11.0, "SPEAKER_00")]
    # The audio went up as Ogg Opus, to the pre-signed URL, under a random media:// key.
    (upload,) = srv.uploads.values()
    assert upload[:4] == b"OggS"
    request = srv.json_body("/v1/diarize")
    assert request["url"].startswith("media://meetingminutes/") and request["model"] == "precision-2"
    assert request["exclusive"] is True and request["minSpeakers"] == 2 and request["maxSpeakers"] == 4
    assert "numSpeakers" not in request
    assert seen == sorted(seen) and seen[-1] == 1.0


def test_exact_speaker_count_is_passed_on(service):
    srv = service()
    diarizer(srv.url).run(speech(), 16000, num_speakers=3, min_speakers=2)
    request = srv.json_body("/v1/diarize")
    assert request["numSpeakers"] == 3 and "minSpeakers" not in request


def test_falls_back_to_plain_diarization_output(service):
    srv = service(final={"status": "succeeded", "output": {"diarization": TURNS[:1]}})
    assert diarizer(srv.url).run(speech(), 16000) == [(0.0, 3.0, "SPEAKER_00")]


def test_bad_key_is_not_retried(service):
    srv = service()
    with pytest.raises(CloudDiarizationError) as e:
        diarizer(srv.url, key="wrong").run(speech(), 16000)
    assert e.value.retryable is False and "PYANNOTEAI_API_KEY" in str(e.value)


def test_rate_limits_are_retried(service):
    waits = []
    srv = service(script=[(429, {"message": "Too many requests"}, {"Retry-After": "3"})])
    turns = diarizer(srv.url, sleep=waits.append).run(speech(), 16000)
    assert len(turns) == 3 and waits and 2 <= waits[0] <= 4


def test_failed_job_is_reported_with_its_reason(service):
    srv = service(final={"status": "failed", "output": {"error": "Audio file is corrupted"}})
    with pytest.raises(CloudDiarizationError) as e:
        diarizer(srv.url).run(speech(), 16000)
    assert not e.value.retryable and "Audio file is corrupted" in str(e.value)


def test_a_job_that_never_finishes_is_retryable(service):
    srv = service(polls_before_done=10**6)
    ticks = iter(range(0, 10**6, 100))
    with pytest.raises(CloudDiarizationError) as e:
        diarizer(srv.url, max_wait_sec=300, clock=lambda: next(ticks)).run(speech(), 16000)
    assert e.value.retryable and "did not finish" in str(e.value)


def test_cancel_while_waiting(service):
    srv = service(polls_before_done=10**6)

    class Canceled(Exception):
        pass

    def progress(f):
        if f > 0.15:
            raise Canceled()

    with pytest.raises(Canceled):
        diarizer(srv.url).run(speech(), 16000, progress=progress)


def test_no_key_says_what_to_set():
    with pytest.raises(CloudDiarizationError) as e:
        PyannoteAIDiarizer(None, FakeEmbedder())
    assert "PYANNOTEAI_API_KEY" in str(e.value) and not e.value.retryable


def test_pipeline_with_cloud_diarization_and_cpu_fingerprints(two_speaker_wav, tmp_path, service):
    srv = service()
    result = run_job(
        JobSpec(str(two_speaker_wav), str(tmp_path / "out"), {"diarize": True, "script": "zh-TW"}),
        report=lambda stage, p: True,
        transcriber=FakeTranscriber(),
        diarizer=diarizer(srv.url),
    )
    assert result["speakers"] == ["SPEAKER_00", "SPEAKER_01"] and result["diarization"]["status"] == "ok"
    # Fingerprints come from the CPU model, under its own name.
    assert result["voiceModel"] == "fake-onnx" and set(result["voices"]) <= {"SPEAKER_00", "SPEAKER_01"}


def test_busy_service_retries_the_job_instead_of_dropping_speakers(two_speaker_wav, tmp_path, service):
    srv = service(script=[(503, {"message": "maintenance"}, {})] * 10)
    with pytest.raises(CloudDiarizationError) as e:
        run_job(
            JobSpec(str(two_speaker_wav), str(tmp_path / "out"), {"diarize": True}),
            report=lambda stage, p: True,
            transcriber=FakeTranscriber(),
            diarizer=diarizer(srv.url, retries=1),
        )
    assert e.value.retryable


# ---------------------------------------------------------------- CPU voice model


def test_model_download_is_checked(tmp_path):
    class Res(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    with pytest.raises(onnx_voice.VoiceModelUnavailable) as e:
        onnx_voice.ensure_model(tmp_path, opener=lambda url, timeout: Res(b"not the model"))
    assert "checksum" in str(e.value)
    assert not list(tmp_path.iterdir())
    good = b"model bytes"
    import hashlib

    path = onnx_voice.ensure_model(tmp_path, sha256=hashlib.sha256(good).hexdigest(), opener=lambda url, timeout: Res(good))
    assert path.read_bytes() == good


MODEL_DIR = os.environ.get("MM_TEST_ONNX_MODEL_DIR")


@pytest.mark.skipif(not MODEL_DIR or not (Path(MODEL_DIR or ".") / onnx_voice.MODEL_FILE).exists(), reason="set MM_TEST_ONNX_MODEL_DIR to a folder with the model")
def test_real_voice_model_tells_tones_apart(two_speaker_wav):
    wav = audio.decode_pcm(str(two_speaker_wav))
    e = onnx_voice.OnnxVoiceEmbedder(Path(MODEL_DIR))
    v = e.embed([wav[0 : 3 * 16000], wav[4 * 16000 : 8 * 16000], wav[9 * 16000 : 11 * 16000], wav[:4000]], 16000)
    assert v.shape == (4, 512) and np.isnan(v[3]).all()
    a, b, c = (x / np.linalg.norm(x) for x in v[:3])
    assert float(a @ c) > float(a @ b)


def test_the_recording_is_never_uploaded_over_plain_http():
    """The upload address comes from the service; one that is not https (or this machine) is refused before anything is sent."""
    import io

    from mm_worker.cloud_diarize import _safe_upload_url

    assert _safe_upload_url("https://storage.example.com/bucket/key?signature=abc")
    assert _safe_upload_url("http://127.0.0.1:9000/upload/key")
    for bad in ("http://storage.example.com/upload/key", "httpx://storage.example.com/x", "ftp://storage.example.com/x", "https:///nohost", "http://127.0.0.1.example.com/x"):
        assert not _safe_upload_url(bad), bad

    sent = []

    def opener(req, timeout=None):
        sent.append((req.get_method(), req.full_url))
        return io.BytesIO(json.dumps({"url": "http://storage.example.com/upload/key"}).encode())

    with pytest.raises(CloudDiarizationError, match="https upload address"):
        PyannoteAIDiarizer("pk-test", FakeEmbedder(), api_url="https://api.pyannote.ai/v1", opener=opener, sleep=lambda s: None).run(speech(2.0), 16000)
    assert sent == [("POST", "https://api.pyannote.ai/v1/media/input")]
