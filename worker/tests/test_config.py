import pytest

from mm_worker.config import load_config


def _env(monkeypatch, **values):
    monkeypatch.setenv("MM_SKIP_DOTENV", "1")
    monkeypatch.setenv("WORKER_TOKEN", "t")
    for key in ("TLS_CERT_FILE", "INTERNAL_PORT", "PORT", "MM_SERVER_URL", "WORKER_GPUS", "CUDA_VISIBLE_DEVICES", "MM_WORKER_ID", "MM_WORKER_NAME", "MIN_FREE_VRAM_GB", "MM_DEVICE", "ASR_BACKEND"):
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


def test_one_gpu_keeps_its_worker_id(monkeypatch):
    monkeypatch.setattr("socket.gethostname", lambda: "meow2")
    _env(monkeypatch, CUDA_VISIBLE_DEVICES="1")
    cfg = load_config()
    assert cfg.gpus == ["1"] and cfg.worker_id == "meow2-gpu1"
    assert cfg.for_gpu("1").worker_id == "meow2-gpu1"


def test_several_gpus_each_get_a_worker_id(monkeypatch):
    monkeypatch.setattr("socket.gethostname", lambda: "meow2")
    _env(monkeypatch, WORKER_GPUS="0, 1,1,3")
    cfg = load_config()
    assert cfg.gpus == ["0", "1", "3"]
    assert [cfg.for_gpu(g).worker_id for g in cfg.gpus] == ["meow2-gpu0", "meow2-gpu1", "meow2-gpu3"]
    # An explicit ID is shared by every GPU, so each still gets its own.
    _env(monkeypatch, WORKER_GPUS="0,1", MM_WORKER_ID="lab", MM_WORKER_NAME="Lab")
    cfg = load_config()
    assert [(cfg.for_gpu(g).worker_id, cfg.for_gpu(g).worker_name) for g in cfg.gpus] == [("lab-gpu0", "Lab-gpu0"), ("lab-gpu1", "Lab-gpu1")]


def test_mm_device_names_the_gpu_without_worker_gpus(monkeypatch):
    monkeypatch.setattr("socket.gethostname", lambda: "meow2")
    _env(monkeypatch, CUDA_VISIBLE_DEVICES="0,1", MM_DEVICE="cuda:1")
    cfg = load_config()
    assert cfg.gpus == ["1"] and cfg.worker_id == "meow2-gpu1"
    # The session sees only that GPU, so the models go to its cuda:0.
    session = cfg.for_gpu("1")
    assert session.device == "cuda:0" and session.gpus == ["1"]


def test_mm_device_alone_is_a_physical_gpu(monkeypatch):
    _env(monkeypatch, MM_DEVICE="cuda:1")
    assert load_config().gpus == ["1"]
    _env(monkeypatch)
    assert load_config().gpus == ["0"]


def test_mm_device_outside_the_visible_gpus_is_an_error(monkeypatch):
    for visible in ("", "0"):
        _env(monkeypatch, CUDA_VISIBLE_DEVICES=visible, MM_DEVICE="cuda:1")
        with pytest.raises(SystemExit, match="WORKER_GPUS"):
            load_config()
    _env(monkeypatch, CUDA_VISIBLE_DEVICES="")
    with pytest.raises(SystemExit):
        load_config()


def test_cpu_worker_keeps_its_device(monkeypatch):
    _env(monkeypatch, MM_DEVICE="cpu")
    cfg = load_config()
    assert cfg.for_gpu(cfg.gpus[0]).device == "cpu" and not cfg.uses_gpu


def test_free_vram_threshold(monkeypatch):
    _env(monkeypatch)
    assert load_config().min_free_vram_gb == 8.0
    _env(monkeypatch, MIN_FREE_VRAM_GB="12.5")
    assert load_config().min_free_vram_gb == 12.5
