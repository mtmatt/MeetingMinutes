from mm_worker.config import load_config


def _env(monkeypatch, **values):
    monkeypatch.setenv("MM_SKIP_DOTENV", "1")
    monkeypatch.setenv("WORKER_TOKEN", "t")
    for key in ("TLS_CERT_FILE", "INTERNAL_PORT", "PORT", "MM_SERVER_URL"):
        monkeypatch.delenv(key, raising=False)
    for key, value in values.items():
        monkeypatch.setenv(key, value)


def test_plain_http_uses_the_public_port(monkeypatch):
    _env(monkeypatch, PORT="9000")
    assert load_config().server_url == "http://127.0.0.1:9000"


def test_builtin_https_uses_the_loopback_worker_port(monkeypatch):
    _env(monkeypatch, PORT="8443", TLS_CERT_FILE="data/tls/server.crt")
    assert load_config().server_url == "http://127.0.0.1:8788"
    _env(monkeypatch, PORT="8443", TLS_CERT_FILE="data/tls/server.crt", INTERNAL_PORT="9100")
    assert load_config().server_url == "http://127.0.0.1:9100"


def test_explicit_server_url_wins(monkeypatch):
    _env(monkeypatch, TLS_CERT_FILE="x", MM_SERVER_URL="http://gpu-box:8788/")
    assert load_config().server_url == "http://gpu-box:8788"
