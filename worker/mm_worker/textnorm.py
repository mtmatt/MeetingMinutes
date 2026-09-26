"""Post-processing of ASR text: Chinese script conversion and cleanup."""

from __future__ import annotations

import re
from functools import lru_cache

_CJK = r"㐀-䶿一-鿿豈-﫿"
_CJK_PUNCT = r"　-〿＀-￯"
_SPACE_BETWEEN_CJK = re.compile(rf"(?<=[{_CJK}{_CJK_PUNCT}])\s+(?=[{_CJK}{_CJK_PUNCT}])")
_ONLY_PUNCT = re.compile(rf"^[\s\W_{_CJK_PUNCT}]*$")
_REPEATS = re.compile(r"(.{1,12}?)\1{7,}")


@lru_cache(maxsize=4)
def _converter(config: str):
    from opencc import OpenCC  # opencc-python-reimplemented

    return OpenCC(config)


def convert_script(text: str, script: str) -> str:
    """Convert Chinese script. ``zh-TW`` uses Taiwan phrasing (s2twp), e.g. 软件 -> 軟體."""
    if not text or script == "none":
        return text
    if script == "zh-TW":
        return _converter("s2twp").convert(text)
    if script == "zh-CN":
        return _converter("t2s").convert(text)
    return text


def clean(text: str) -> str:
    """Normalise whitespace, drop pure-punctuation output and collapse runaway repetition."""
    text = (text or "").replace(" ", " ").strip()
    text = re.sub(r"\s+", " ", text)
    text = _SPACE_BETWEEN_CJK.sub("", text)
    # Decoder loops ("好好好好好好好好...") are a known ASR failure mode.
    text = _REPEATS.sub(lambda m: m.group(1) * 3, text)
    if _ONLY_PUNCT.match(text):
        return ""
    return text


def normalize(text: str, script: str) -> str:
    return clean(convert_script(clean(text), script))
