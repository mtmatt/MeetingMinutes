"""Checking a wake-up call from the server, for a worker started on demand (Modal).

When a job is queued that such a worker could take, the server sends a POST to
the worker's wake-up address with the header

    X-MM-Wake: t=<milliseconds since 1970>,sig=<hex HMAC-SHA256>

signed with the SHA-256 (hex) of this worker's token, over "<t>.<key ID>". The
server keeps only that hash, never the token; the worker can compute it from
its token. So no further secret has to be set up, and only the server can wake
the worker (and spend GPU time): anyone else calling the address is refused.
A call older than five minutes is refused too; a repeated recent one can only
start a worker that then finds nothing to do.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional

HEADER = "x-mm-wake"
MAX_AGE_MS = 5 * 60 * 1000


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def sign(token_sha256: str, key_id: str, t_ms: int) -> str:
    """The header value the server sends (also used by tests)."""
    sig = hmac.new(token_sha256.encode(), f"{t_ms}.{key_id}".encode(), hashlib.sha256).hexdigest()
    return f"t={t_ms},sig={sig}"


def verify(header: Optional[str], token: str, key_id: str, now_ms: Optional[int] = None) -> Optional[str]:
    """None if the call is the server's and recent; otherwise why it is refused."""
    if not header:
        return "missing X-MM-Wake header"
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t_ms = int(parts.get("t", ""))
    except ValueError:
        return "malformed X-MM-Wake header"
    sig = parts.get("sig", "")
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if abs(now_ms - t_ms) > MAX_AGE_MS:
        return "stale wake-up call"
    expected = sign(token_hash(token), key_id, t_ms).split("sig=", 1)[1]
    if not hmac.compare_digest(expected, sig):
        return "bad signature"
    return None
