from mm_worker import textnorm


def test_converts_to_taiwan_traditional_with_phrases():
    assert textnorm.normalize("这个软件的内存不够", "zh-TW") == "這個軟體的記憶體不夠"


def test_keeps_english_and_code_switching():
    out = textnorm.normalize("我们下周三要 deploy 到 Kubernetes cluster", "zh-TW")
    assert "deploy" in out and "Kubernetes cluster" in out
    assert out.startswith("我們")


def test_simplified_and_none():
    assert textnorm.normalize("這個軟體", "zh-CN") == "这个软体"
    assert textnorm.normalize("这个", "none") == "这个"


def test_removes_spaces_between_cjk_and_drops_punctuation_only():
    assert textnorm.clean("大家 好 ， 今天") == "大家好，今天"
    assert textnorm.clean(" 。 ") == ""
    assert textnorm.clean("...") == ""


def test_collapses_decoder_loops():
    assert textnorm.clean("好" * 40) == "好好好"
    assert textnorm.clean("對對對，") == "對對對，"
