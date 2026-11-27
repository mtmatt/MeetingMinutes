"""Checking a wake-up call from the server, for a worker started on demand (Modal).

When a job is queued that such a worker could take, the server sends a POST to
the worker's wake-up address with the header

    X-MM-Wake: t=<milliseconds since 1970>,sig=<hex HMAC-SHA256>

signed with the SHA-256 (hex) of this worker's token, over "<t>.<key ID>". The
server keeps only that hash, never the token; the worker can compute it from
its token. So no further secret has to be set up, and only the server can wake
the worker (and spend GPU time): anyone else calling the address is refused.
A call more than a minute old (or ahead) is refused too, and so is one no newer
than the last call accepted (`not_after_ms`), so a call seen on the way cannot
be sent again to start the GPU.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Optional

HEADER = "x-mm-wake"
MAX_AGE_MS = 60 * 1000
_HEX64 = re.compile(r"[0-9a-f]{64}")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def sign(token_sha256: str, key_id: str, t_ms: int) -> str:
    """The header value the server sends (also used by tests)."""
    sig = hmac.new(token_sha256.encode(), f"{t_ms}.{key_id}".encode(), hashlib.sha256).hexdigest()
    return f"t={t_ms},sig={sig}"


def timestamp(header: Optional[str]) -> Optional[int]:
    """The call's time (ms), to remember once it is accepted; None if there is none."""
    parts = dict(p.split("=", 1) for p in (header or "").split(",") if "=" in p)
    try:
        return int(parts.get("t", ""))
    except ValueError:
        return None


def verify(
    header: Optional[str],
    token: str,
    key_id: str,
    now_ms: Optional[int] = None,
    not_after_ms: Optional[int] = None,
) -> Optional[str]:
    """None if the call is the server's, recent, and newer than `not_after_ms`; otherwise why it is refused."""
    return verify_with_hash(header, token_hash(token), key_id, now_ms, not_after_ms)


def verify_with_hash(
    header: Optional[str],
    token_sha256: str,
    key_id: str,
    now_ms: Optional[int] = None,
    not_after_ms: Optional[int] = None,
) -> Optional[str]:
    """As verify(), given the token's hash: what the public endpoint keeps instead of the token."""
    if not header:
        return "missing X-MM-Wake header"
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t_ms = int(parts.get("t", ""))
    except ValueError:
        return "malformed X-MM-Wake header"
    sig = parts.get("sig", "")
    if not _HEX64.fullmatch(sig):
        return "malformed X-MM-Wake header"
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if abs(now_ms - t_ms) > MAX_AGE_MS:
        return "stale wake-up call"
    expected = sign(token_sha256, key_id, t_ms).split("sig=", 1)[1]
    if not hmac.compare_digest(expected, sig):
        return "bad signature"
    if not_after_ms is not None and t_ms <= not_after_ms:
        return "repeated wake-up call"
    return None
