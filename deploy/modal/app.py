"""MeetingMinutes worker on Modal: a cloud GPU that runs only while there is work.

The worker here is the same as on any other machine (worker/mm_worker), enrolled
as a remote worker. It is not kept running: when a recording it can take is
queued, the server calls this app's `wake` address, which starts `worker` on a
GPU; the worker claims and processes jobs like any other, and exits once the
queue has been empty for a minute, so Modal bills only for the work.

Setup (in this project's folder, with the Modal CLI: `pip install modal`, `modal setup`),
in this order (the full guide is in the README, "A cloud GPU started on demand"):

  1. Keys the worker needs, as a Modal secret, first: every command loads the whole
     app, whose GPU functions use it, and HF_TOKEN downloads the pyannote model
     (accept its terms on Hugging Face first). Only the keys your settings use:
       modal secret create meetingminutes-worker HF_TOKEN=hf_... OPENROUTER_API_KEY=sk-or-...
  2. Admin -> System -> Workers on other machines -> Add: copy the one-time code, then
       modal run deploy/modal/app.py::enroll --server-url https://minutes.example.com --code mme_...
     The credential is kept in the Modal volume "meetingminutes-worker-data", never in this repo.
  3. Deploy, and enter the printed `...-wake.modal.run` address as the worker's
     wake-up address (its settings in Admin -> System):
       modal deploy deploy/modal/app.py
  4. Download the models now rather than during the first recording (recommended):
       modal run deploy/modal/app.py::prepare

The wake-up endpoint is public, so it holds as little as possible: not the token
(only its hash and the key ID, in the Modal Dict "<app>-state"), no secrets and
no volume. It refuses calls more than a minute old and any call no newer than
the last it accepted, and starts no second worker while one is starting or running.
Enrolled with an earlier version of this file? Run once:
       modal run deploy/modal/app.py::sync_wake_key

Settings at deploy time (environment variables of `modal deploy`):
  MM_MODAL_GPU      GPU type: T4 (16 GB, the default), L4 (24 GB), A10G, ...
  MM_MODAL_IDLE_SEC seconds without work before the worker exits (default 60)
  MM_MODAL_SECRET   name of the Modal secret with the keys (default meetingminutes-worker)
  MM_MODAL_TIMEOUT_SEC  longest one run may take (default 21600, 6 hours)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import modal

# The worker's code and dependencies, from this checkout (<repo>/deploy/modal/app.py). Only the
# computer running `modal deploy` / `modal run` reads them, to build the images. In a Modal
# container this file is /root/app.py, the images are already built, and the path is never used.
_HERE = Path(__file__).resolve()
WORKER = _HERE.parents[2] / "worker" if len(_HERE.parents) > 2 else Path("/opt/mm")

APP_NAME = os.environ.get("MM_MODAL_APP", "meetingminutes-worker")
GPU = os.environ.get("MM_MODAL_GPU", "T4")
IDLE_SEC = os.environ.get("MM_MODAL_IDLE_SEC", "60")
SECRET = os.environ.get("MM_MODAL_SECRET", "meetingminutes-worker")
# Longest a container may run: a session covers a long recording and whatever queued after it.
TIMEOUT_SEC = int(os.environ.get("MM_MODAL_TIMEOUT_SEC", str(6 * 3600)))

# The credential, and the models (downloaded once, kept for later runs).
DATA = "/data"
CREDENTIAL = f"{DATA}/worker-credential.json"
volume = modal.Volume.from_name("meetingminutes-worker-data", create_if_missing=True)
# What the public wake-up endpoint needs, so that it never sees the token: the
# key ID and the token's hash (what the server signs with), the last call it
# accepted (no call is accepted twice), and the worker run it started.
state = modal.Dict.from_name(f"{APP_NAME}-state", create_if_missing=True)

WORKER_ENV = {
    "PYTHONPATH": "/opt/mm",
    "MM_SKIP_DOTENV": "1",
    "DATA_DIR": DATA,
    "HF_HOME": f"{DATA}/hf",
    "MM_MODEL_DIR": f"{DATA}/models",
    # Compacting originals is the server's own work, never a remote worker's.
    "MM_MEDIA_JOBS": "0",
}


def _image(gpu: bool) -> modal.Image:
    image = modal.Image.debian_slim(python_version="3.11").apt_install("ffmpeg")
    image = image.pip_install_from_pyproject(str(WORKER / "pyproject.toml"), optional_dependencies=["gpu"] if gpu else [])
    if not gpu:
        image = image.pip_install("fastapi[standard]")
    # The worker's code, from this checkout (deploy again after updating it).
    return image.env(WORKER_ENV).add_local_dir(WORKER / "mm_worker", "/opt/mm/mm_worker", ignore=["__pycache__", "*.pyc"])


gpu_image = _image(gpu=True)
light_image = _image(gpu=False)

app = modal.App(APP_NAME)

with light_image.imports():
    from fastapi import HTTPException, Request


def _credential() -> dict:
    """The enrolled worker's credential, from the volume (step 1)."""
    volume.reload()
    try:
        return json.loads(Path(CREDENTIAL).read_text())
    except FileNotFoundError:
        raise RuntimeError("Not enrolled: run  modal run deploy/modal/app.py::enroll --server-url ... --code ...") from None


@app.function(image=light_image, volumes={DATA: volume}, timeout=120)
def enroll(server_url: str, code: str):
    """Trade a one-time code from Admin -> System for this worker's credential, kept in the volume."""
    from mm_worker.client import check_server_url
    from mm_worker.client import enroll as trade_code
    from mm_worker.config import write_credential

    url = check_server_url(server_url)
    got = trade_code(url, code)
    write_credential(Path(DATA), {"serverUrl": url, "workerId": got["workerId"], "name": got["name"], "token": got["token"]})
    volume.commit()
    _publish_wake_key(got["workerId"], got["token"])
    print(f"Enrolled as {got['name']} ({got['workerId']}). Next: modal deploy deploy/modal/app.py")


def _publish_wake_key(worker_id: str, token: str) -> None:
    from mm_worker.wake import token_hash

    state["wake_key"] = {"workerId": worker_id, "tokenHash": token_hash(token)}


@app.function(
    image=gpu_image,
    gpu=GPU,
    volumes={DATA: volume},
    secrets=[modal.Secret.from_name(SECRET)],
    timeout=TIMEOUT_SEC,
    # One worker at a time: wake-up calls while it runs only queue behind it, and the
    # queued call finds nothing to do and ends within IDLE_SEC.
    max_containers=1,
)
def worker():
    """Process the server's queue on this GPU, then exit once it has been empty for IDLE_SEC."""
    cred = _credential()  # fail early, with what to do, if the worker was never enrolled
    if state.get("wake_key") is None:
        # Enrolled before the wake-up endpoint kept its own key.
        _publish_wake_key(cred["workerId"], cred["token"])
    env = {**os.environ, **WORKER_ENV, "MM_EXIT_WHEN_IDLE_SEC": IDLE_SEC}
    # Keep the models loaded between recordings that arrive close together.
    env.setdefault("MODEL_KEEPALIVE_SEC", "60")
    try:
        code = subprocess.run([sys.executable, "-m", "mm_worker", "run"], env=env, cwd="/opt/mm").returncode
    finally:
        # Models downloaded during this run stay in the volume for the next.
        volume.commit()
    if code:
        raise RuntimeError(f"the worker exited with code {code}")


@app.function(image=gpu_image, gpu=GPU, volumes={DATA: volume}, secrets=[modal.Secret.from_name(SECRET)], timeout=3600)
def prepare():
    """Download the models into the volume and check that they load on this GPU."""
    env = {**os.environ, **WORKER_ENV}
    try:
        subprocess.run([sys.executable, "-m", "mm_worker", "check"], env=env, cwd="/opt/mm", check=True)
    finally:
        volume.commit()


@app.function(image=light_image, volumes={DATA: volume}, timeout=60)
def sync_wake_key():
    """Give the wake-up endpoint the enrolled worker's key ID and token hash (enroll does this; for older setups)."""
    cred = _credential()
    _publish_wake_key(cred["workerId"], cred["token"])
    print(f"The wake-up endpoint now checks calls for {cred['workerId']}.")


# Calls one at a time (so two cannot both start the GPU), on at most one small container.
@app.function(image=light_image, max_containers=1, timeout=30)
@modal.fastapi_endpoint(method="POST", label=f"{APP_NAME}-wake")
def wake(request: Request):
    """Called by the server when work waits for this worker: start it, if the call is the server's and new."""
    from mm_worker.wake import HEADER, timestamp, verify_with_hash

    key = state.get("wake_key")
    if not key:
        raise HTTPException(status_code=503, detail="Not enrolled: run the enroll step (or sync_wake_key after updating).")
    header = request.headers.get(HEADER)
    why = verify_with_hash(header, key["tokenHash"], key["workerId"], not_after_ms=state.get("last_wake_t"))
    if why:
        raise HTTPException(status_code=401, detail=why)
    state["last_wake_t"] = timestamp(header)
    # A run that is starting or working already takes whatever is queued: do not pay for a second.
    running = state.get("worker_call")
    if running and _still_running(running):
        return {"ok": True, "call": running, "running": True}
    call = worker.spawn()
    state["worker_call"] = call.object_id
    return {"ok": True, "call": call.object_id}


def _still_running(call_id: str) -> bool:
    try:
        modal.FunctionCall.from_id(call_id).get(timeout=0)
    except TimeoutError:
        return True
    except Exception as e:  # finished with an error, expired, or unknown: not running
        return type(e).__name__ == "TimeoutError"
    return False
