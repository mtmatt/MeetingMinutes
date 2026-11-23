"""Transcription through a hosted API (OpenRouter or an OpenAI-compatible server), against a local stand-in."""

import base64
import io
import json
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest

from mm_worker import asr_api
from mm_worker.asr_api import ApiError, ApiSettings, ApiTranscriber


class FakeSttServer:
    """Answers POST /v1/audio/transcriptions like OpenRouter (JSON) or OpenAI (multipart).

    ``script`` is a list of (status, body, headers) answers used in order before
    the normal answer, which describes the audio it received.
    """

    def __init__(self, script=(), refuse_verbose=False, delay=0.0):
        self.requests = []
        self.script = list(script)
        self.refuse_verbose = refuse_verbose
        self.delay = delay
        self.lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0
        srv = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                ctype = self.headers["Content-Type"]
                fields, audio = srv.parse(ctype, raw)
                with srv.lock:
                    srv.requests.append({"path": self.path, "auth": self.headers["Authorization"], "ctype": ctype, "fields": fields})
                    scripted = srv.script.pop(0) if srv.script else None
                    srv.in_flight += 1
                    srv.max_in_flight = max(srv.max_in_flight, srv.in_flight)
                try:
                    time.sleep(srv.delay)
                    if scripted:
                        return self._send(*scripted)
                    if srv.refuse_verbose and fields.get("response_format") == "verbose_json":
                        return self._send(400, {"error": {"message": "response_format verbose_json is not supported"}})
                    with wave.open(io.BytesIO(audio)) as w:
                        sec = w.getnframes() / w.getframerate()
                        assert w.getnchannels() == 1 and w.getsampwidth() == 2
                    out = {"text": f" {sec:.1f} 秒的語音 ", "usage": {"seconds": sec, "cost": 0.0001}}
                    if fields.get("response_format") == "verbose_json":
                        out["language"] = "chinese"
                    return self._send(200, out)
                finally:
                    with srv.lock:
                        srv.in_flight -= 1

            def _send(self, code, payload, headers=None):
                data = json.dumps(payload).encode()
                self.send_response(code)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    @staticmethod
    def parse(ctype, raw):
        if ctype.startswith("application/json"):
            body = json.loads(raw)
            audio = base64.b64decode(body.pop("input_audio")["data"])
            return {k: str(v) for k, v in body.items()}, audio
        boundary = ctype.split("boundary=")[1].encode()
        fields, audio = {}, b""
        for part in raw.split(b"--" + boundary):
            if b"\r\n\r\n" not in part:
                continue
            head, _, value = part.partition(b"\r\n\r\n")
            value = value[:-2] if value.endswith(b"\r\n") else value
            name = head.split(b'name="')[1].split(b'"')[0].decode()
            if name == "file":
                audio = value
            else:
                fields[name] = value.decode()
        return fields, audio

    def close(self):
        self.server.shutdown()


@pytest.fixture
def server():
    servers = []

    def make(**kw):
        s = FakeSttServer(**kw)
        servers.append(s)
        return s

    yield make
    for s in servers:
        s.close()


def tone(sec, sr=16000):
    return (0.3 * np.sin(2 * np.pi * 220 * np.arange(int(sr * sec)) / sr)).astype(np.float32)


def transcriber(url, provider="openrouter", **kw):
    kw.setdefault("sleep", lambda s: None)
    return ApiTranscriber(ApiSettings(provider=provider, model="qwen/qwen3-asr-1.7b", base_url=url), "sk-test", **kw)


def test_openrouter_sends_json_with_base64_audio_and_keeps_order(server):
    srv = server(delay=0.05)
    clips = [tone(s) for s in (3.0, 1.0, 2.0, 0.2, 4.0)]
    seen = []
    out = transcriber(srv.url, concurrency=3).transcribe(clips, 16000, context="MeetingMinutes, 王小明", language="Chinese", progress=seen.append)
    # In the order of the clips, whatever order the answers came in; short clips are padded to 0.5 s.
    assert [t for _, t in out] == ["3.0 秒的語音", "1.0 秒的語音", "2.0 秒的語音", "0.5 秒的語音", "4.0 秒的語音"]
    assert all(lang == "Chinese" for lang, _ in out)
    req = srv.requests[0]
    assert req["path"] == "/v1/audio/transcriptions" and req["auth"] == "Bearer sk-test" and req["ctype"] == "application/json"
    assert req["fields"]["model"] == "qwen/qwen3-asr-1.7b"
    assert req["fields"]["language"] == "zh" and req["fields"]["prompt"] == "MeetingMinutes, 王小明"
    assert 1 < srv.max_in_flight <= 3
    assert seen[-1] == 1.0 and seen == sorted(seen)


def test_openai_compatible_server_gets_a_multipart_upload(server):
    srv = server()
    out = transcriber(srv.url, provider="openai").transcribe([tone(1.5)], 16000, language="auto")
    assert out == [("Chinese", "1.5 秒的語音")]
    req = srv.requests[0]
    assert req["ctype"].startswith("multipart/form-data")
    assert req["fields"]["model"] == "qwen/qwen3-asr-1.7b" and "language" not in req["fields"] and "prompt" not in req["fields"]


def test_falls_back_to_plain_json_when_verbose_json_is_refused(server):
    srv = server(refuse_verbose=True)
    t = transcriber(srv.url, concurrency=1)
    out = t.transcribe([tone(1.0), tone(2.0)], 16000, language="English")
    # Without verbose_json there is no detected language; the one asked for stands in.
    assert out == [("English", "1.0 秒的語音"), ("English", "2.0 秒的語音")]
    formats = [r["fields"]["response_format"] for r in srv.requests]
    assert formats == ["verbose_json", "json", "json"]


def test_rate_limits_and_server_errors_are_retried(server):
    waits = []
    srv = server(script=[(429, {"error": {"message": "Rate limit exceeded"}}, {"Retry-After": "7"}), (502, {"error": {"message": "upstream"}}, {})])
    out = transcriber(srv.url, sleep=waits.append).transcribe([tone(1.0)], 16000)
    assert out[0][1] == "1.0 秒的語音"
    assert len(srv.requests) == 3 and waits[0] == 7.0 and len(waits) == 2


def test_bad_key_fails_at_once_with_what_to_fix(server):
    srv = server(script=[(401, {"error": {"message": "No auth credentials found", "code": 401}}, {})])
    with pytest.raises(ApiError) as e:
        transcriber(srv.url).transcribe([tone(1.0), tone(1.0)], 16000)
    assert e.value.retryable is False and e.value.status == 401
    assert "OPENROUTER_API_KEY" in str(e.value) and "No auth credentials found" in str(e.value)


def test_unknown_model_is_not_retried(server):
    srv = server(script=[(404, {"error": {"message": "No endpoints found for qwen/nope"}}, {})])
    with pytest.raises(ApiError) as e:
        transcriber(srv.url, concurrency=1).transcribe([tone(1.0)], 16000)
    assert not e.value.retryable and "qwen/qwen3-asr-1.7b" in str(e.value) and len(srv.requests) == 1


def test_giving_up_after_retries_is_retryable_for_the_job(server):
    busy = (503, {"error": {"message": "overloaded"}}, {})
    srv = server(script=[busy] * 10)
    with pytest.raises(ApiError) as e:
        transcriber(srv.url, retries=2, concurrency=1).transcribe([tone(1.0)], 16000)
    assert e.value.retryable and len(srv.requests) == 3


def test_unreachable_server_is_retryable():
    t = transcriber("http://127.0.0.1:9/v1", retries=1, timeout=2)
    with pytest.raises(ApiError) as e:
        t.transcribe([tone(1.0)], 16000)
    assert e.value.retryable and "Could not reach" in str(e.value)


def test_cancel_stops_sending(server):
    srv = server(delay=0.05)
    calls = []

    def progress(f):
        calls.append(f)
        return False if len(calls) >= 2 else True

    with pytest.raises(InterruptedError):
        transcriber(srv.url, concurrency=2).transcribe([tone(0.5)] * 40, 16000, progress=progress)
    time.sleep(0.3)
    assert len(srv.requests) < 10


def test_missing_key_names_the_variables(monkeypatch):
    for k in ("OPENROUTER_API_KEY", "ASR_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    t = ApiTranscriber(ApiSettings("openrouter", "qwen/qwen3-asr-1.7b", asr_api.DEFAULT_BASE_URLS["openrouter"]), asr_api.api_key("openrouter"))
    with pytest.raises(ApiError) as e:
        t.load()
    assert not e.value.retryable and "OPENROUTER_API_KEY or ASR_API_KEY" in str(e.value)
    monkeypatch.setenv("ASR_API_KEY", "k2")
    assert asr_api.api_key("openrouter") == "k2" and asr_api.keys_present() == {"openrouter": True, "openai": True}
    monkeypatch.setenv("OPENROUTER_API_KEY", "k1")
    assert asr_api.api_key("openrouter") == "k1"


def test_languages_and_settings():
    assert asr_api.language_code("Chinese") == "zh" and asr_api.language_code("Cantonese") == "yue"
    assert asr_api.language_code("auto") is None and asr_api.language_code("") is None
    assert asr_api.language_code("fr") == "fr" and asr_api.language_code("Klingon") is None
    assert asr_api.language_name("zh") == "Chinese" and asr_api.language_name("english") == "English"
    assert asr_api.language_name("zh-TW") == "Chinese" and asr_api.language_name(None) == ""
    # Qwen3-ASR's raw output, if a provider passes it through.
    assert ApiTranscriber._parse({"text": "language Chinese<asr_text>大家好"}, None) == ("Chinese", "大家好")
    s = asr_api.settings_from_job({"engine": "api", "provider": "openrouter", "model": "openai/whisper-large-v3"})
    assert s.base_url == "https://openrouter.ai/api/v1"
    s = asr_api.settings_from_job({"engine": "api", "provider": "openai", "model": "whisper-large-v3", "baseUrl": "https://api.groq.com/openai/v1/"})
    assert s.base_url == "https://api.groq.com/openai/v1"
    # OpenRouter has one address: a job cannot send this worker's OpenRouter key anywhere else.
    s = asr_api.settings_from_job({"engine": "api", "provider": "openrouter", "model": "qwen/qwen3-asr-1.7b", "baseUrl": "https://collector.example.net/v1"})
    assert s.base_url == "https://openrouter.ai/api/v1"
    with pytest.raises(ApiError):
        asr_api.settings_from_job({"provider": "elsewhere", "model": "x"})
