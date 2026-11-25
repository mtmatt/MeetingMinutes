"""Comparing speech recognition models on corrected transcripts: scoring, the evaluation set, the report."""

import json
import shutil
from dataclasses import replace

import pytest

from mm_worker import asr_compare
from mm_worker.asr_compare import Errors, align, compare, load_eval_set, units
from mm_worker.config import WorkerConfig


def test_units_are_characters_and_words_in_taiwan_script():
    # Chinese characters one by one, English words and numbers whole; script, width, case and punctuation ignored.
    assert units("我们用 Kubernetes，部署了３次！") == ["我", "們", "用", "kubernetes", "部", "署", "了", "3", "次"]
    assert units("OK, it's done.") == ["ok", "it's", "done"]
    assert units("……　") == []


def test_alignment_counts_each_kind_of_error():
    e = align(list("abcd"), list("abxde"))
    assert (e.substitutions, e.deletions, e.insertions, e.reference) == (1, 0, 1, 4)
    assert e.mer == 0.5
    assert align(list("abc"), []).deletions == 3
    assert align([], list("ab")).insertions == 2 and align([], list("ab")).mer == 1.0
    assert align(list("same"), list("same")).total == 0
    total = Errors(1, 2, 3, 10) + Errors(1, 0, 0, 10)
    assert total.total == 7 and total.mer == pytest.approx(0.35)


def write_eval(tmp_path, wav):
    """One meeting: three corrected segments, one not corrected, one too long for Whisper."""
    d = tmp_path / "eval" / "m1"
    d.mkdir(parents=True)
    shutil.copy(wav, d / "audio.mp3")
    segments = [
        {"start": 0.0, "end": 3.0, "speaker": "王小明", "text": "我們今天討論 release。", "edited": True},
        {"start": 4.0, "end": 8.0, "speaker": "Rita", "text": "測試要在週三前補齊。", "edited": True},
        {"start": 9.0, "end": 11.0, "speaker": "王小明", "text": "好", "edited": True},
        {"start": 3.0, "end": 4.0, "speaker": None, "text": "（模型原文）", "edited": False},
        {"start": 0.0, "end": 40.0, "speaker": None, "text": "太長的段落", "edited": True},
    ]
    (d / "reference.json").write_text(
        json.dumps({"version": 1, "meetingId": "m1", "title": "週會", "audio": "audio.mp3", "vocabulary": "release", "script": "zh-TW", "segments": segments}),
        encoding="utf-8",
    )
    return tmp_path / "eval"


def test_eval_set_keeps_corrected_segments_that_fit(two_speaker_wav, tmp_path):
    data = load_eval_set(write_eval(tmp_path, two_speaker_wav))
    assert [c.reference for c in data.clips] == ["我們今天討論 release。", "測試要在週三前補齊。", "好"]
    assert data.skipped == {"unedited": 1, "too short": 0, "too long": 1, "empty reference": 0}
    assert abs(len(data.clips[1].audio) / 16000 - 4.0) < 0.05 and data.clips[0].context == "release"
    assert len(load_eval_set(write_eval(tmp_path / "x", two_speaker_wav), include_unedited=True).clips) == 4


class Scripted:
    """A model that answers from a list, in order, and records the vocabulary it was given."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.contexts = []

    def transcribe(self, clips, sr, context="", language=None, progress=None):
        self.contexts.append(context)
        return [("", self.answers.pop(0)) for _ in clips]


def test_report_scores_models_and_shows_where_they_differ(two_speaker_wav, tmp_path):
    data = load_eval_set(write_eval(tmp_path, two_speaker_wav))
    good = Scripted(["我们今天讨论 Release", "測試要在週三前補齊", "好"])  # Simplified and capitals do not count
    poor = Scripted(["我們今天討論", "測試要在周三補齊了", "好"])
    a = asr_compare.run_model("qwen", "Qwen/Qwen3-ASR-1.7B", lambda: good, data)
    b = asr_compare.run_model("breeze25", "MediaTek-Research/Breeze-ASR-25", lambda: poor, data)
    assert good.contexts == ["release"]
    assert a.errors.total == 0 and a.errors.reference == 17
    # "release" missing; 週→周 (converted back to 週 by the Taiwan script step); 前 missing, 了 extra.
    assert (b.errors.deletions, b.errors.insertions, b.errors.substitutions) == (2, 1, 0)
    text = asr_compare.report(data, [a, b], tmp_path / "out")
    assert "3 corrected segments from 1 meeting(s)" in text and "1 unedited, 1 too long" in text
    assert "Qwen/Qwen3-ASR-1.7B" in text and " 17.65%" in text
    assert "better on 2, MediaTek-Research/Breeze-ASR-25 better on 0, equal on 1" in text
    assert "reference : 我們今天討論 release。" in text
    summary = json.loads((tmp_path / "out" / "summary.json").read_text())
    assert [m["name"] for m in summary["models"]] == ["qwen", "breeze25"] and summary["models"][1]["mer"] == pytest.approx(3 / 17, abs=1e-4)
    rows = (tmp_path / "out" / "segments.csv").read_text(encoding="utf-8-sig").splitlines()
    assert rows[0].startswith("meeting,start,end,speaker,reference,qwen,qwen errors,breeze25,breeze25 errors") and len(rows) == 4


def test_compare_end_to_end_with_the_workers_own_model(two_speaker_wav, tmp_path):
    cfg = WorkerConfig(
        server_url="http://127.0.0.1:1", token="t", worker_id="w", worker_name="w", device="cpu", hf_token=None,
        asr_model="fake", asr_backend="fake", asr_batch_size=4, asr_max_new_tokens=64,
        diarization_model="fake", max_segment_sec=30.0, poll_interval=1.0, model_keepalive_sec=0.0, gpus=["0"],
    )  # fmt: skip
    root = write_eval(tmp_path, two_speaker_wav)
    text = compare(cfg, root, ["qwen", "qwen:other-fake"], tmp_path / "res", False, None, 8, None, None, True, 3)
    assert "3 corrected segments" in text and "other-fake" in text and (tmp_path / "res" / "segments.csv").exists()
    with pytest.raises(SystemExit, match="Unknown model"):
        asr_compare.model_loaders(["nope"], replace(cfg), 8, None, None)
    with pytest.raises(SystemExit, match="export-asr-eval"):
        load_eval_set(tmp_path / "empty")
