"""Wake-up calls for a worker started on demand, and exiting when idle."""

import threading
import time

import pytest

from mm_worker import wake
from mm_worker.config import key_id_of
from mm_worker.worker import Supervisor

from test_worker_lifecycle import FakeBackend, cfg

TOKEN = "mmw_wkabcdefghjk.secretpart"


def test_a_signed_recent_call_is_accepted():
    now = 1_800_000_000_000
    header = wake.sign(wake.token_hash(TOKEN), "wkabcdefghjk", now - 1000)
    assert wake.verify(header, TOKEN, "wkabcdefghjk", now) is None


def test_the_signature_matches_the_servers():
    # The same vector as backend/test/worker-wake.test.ts: HMAC-SHA256 over "<t>.<key ID>",
    # keyed by the token's SHA-256 in hex (what the server stores).
    assert wake.token_hash(TOKEN) == "ae7305186eb003211ae370cde4476cfb5d18827ad76fe904681ed015fca7e7f8"
    assert wake.sign(wake.token_hash(TOKEN), "wkabcdefghjk", 1_800_000_000_000) == (
        "t=1800000000000,sig=00fc6caddf2dde8c3eb03fe844db79dfc3b6d5c5977982fefeb1c34e39de2c45"
    )


@pytest.mark.parametrize(
    "header,why",
    [
        (None, "missing"),
        ("t=abc,sig=00", "malformed"),
        ("t=1,sig=00", "malformed"),
        ("t=1800000000000,sig=" + "\u00e9" * 64, "malformed"),
        ("t=1," + "sig=" + "0" * 64, "stale"),
        # A minute ahead is as suspect as a minute late.
        ("t=1800000061000,sig=" + "0" * 64, "stale"),
    ],
)
def test_other_calls_are_refused(header, why):
    assert why in wake.verify(header, TOKEN, "wkabcdefghjk", 1_800_000_000_000)


def test_a_call_signed_with_another_token_or_for_another_worker_is_refused():
    now = 1_800_000_000_000
    other = wake.sign(wake.token_hash("mmw_wkabcdefghjk.other"), "wkabcdefghjk", now)
    assert wake.verify(other, TOKEN, "wkabcdefghjk", now) == "bad signature"
    elsewhere = wake.sign(wake.token_hash(TOKEN), "wkzzzzzzzzzz", now)
    assert wake.verify(elsewhere, TOKEN, "wkabcdefghjk", now) == "bad signature"


def test_a_call_seen_once_cannot_be_sent_again():
    now = 1_800_000_000_000
    header = wake.sign(wake.token_hash(TOKEN), "wkabcdefghjk", now - 1000)
    assert wake.timestamp(header) == now - 1000
    assert wake.verify(header, TOKEN, "wkabcdefghjk", now, not_after_ms=now - 5000) is None
    # The same call again, or an older one, after it was accepted.
    assert wake.verify(header, TOKEN, "wkabcdefghjk", now, not_after_ms=now - 1000) == "repeated wake-up call"
    newer = wake.sign(wake.token_hash(TOKEN), "wkabcdefghjk", now)
    assert wake.verify(newer, TOKEN, "wkabcdefghjk", now, not_after_ms=now - 1000) is None
    # More than a minute old.
    old = wake.sign(wake.token_hash(TOKEN), "wkabcdefghjk", now - 61_000)
    assert wake.verify(old, TOKEN, "wkabcdefghjk", now) == "stale wake-up call"


def test_the_key_id_comes_from_the_token():
    assert key_id_of(TOKEN) == "wkabcdefghjk"
    with pytest.raises(SystemExit):
        key_id_of("mmw_nodot")


def test_a_worker_started_on_demand_exits_once_the_queue_is_empty(two_speaker_wav, tmp_path):
    jobs = [{"jobId": "j0", "meetingId": "m0", "attempt": 1, "mediaPath": str(two_speaker_wav), "outDir": str(tmp_path / "m0"), "options": {"diarize": True, "script": "zh-TW"}, "title": "t"}]
    backend = FakeBackend(jobs)
    c = cfg(backend.url)
    c.exit_when_idle_sec = 1.0
    sup = Supervisor(c)
    t = threading.Thread(target=sup.run, daemon=True)
    started = time.time()
    t.start()
    t.join(timeout=60)
    # It ran the job, then stopped by itself shortly after.
    assert not t.is_alive()
    assert "/jobs/j0/complete" in backend.paths()
    assert sup.stop.is_set() and time.time() - started < 60


def test_a_worker_woken_for_nothing_exits_soon():
    backend = FakeBackend([])
    c = cfg(backend.url)
    c.exit_when_idle_sec = 0.5
    sup = Supervisor(c)
    t = threading.Thread(target=sup.run, daemon=True)
    t.start()
    t.join(timeout=10)
    assert not t.is_alive()
    assert backend.paths().count("/jobs/claim") >= 1


def test_a_worker_without_the_setting_keeps_running():
    backend = FakeBackend([])
    sup = Supervisor(cfg(backend.url))
    t = threading.Thread(target=sup.run, daemon=True)
    t.start()
    time.sleep(1.0)
    assert t.is_alive()
    sup.stop.set()
    t.join(timeout=5)
