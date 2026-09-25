from mm_worker.pipeline import Canceled, JobSpec, _dominant_language, run_job

import pytest


class FakeDiarizer:
    def __init__(self):
        self.kwargs = None

    def run(self, wav, sr, num_speakers=None, min_speakers=None, max_speakers=None, progress=None):
        self.kwargs = dict(num_speakers=num_speakers, min_speakers=min_speakers, max_speakers=max_speakers)
        if progress:
            progress(1.0)
        # Raw labels are arbitrary; the pipeline orders speakers by first appearance.
        return [(0.0, 3.0, "SPK_7"), (4.0, 8.0, "SPK_2"), (9.0, 11.0, "SPK_7")]


class FakeTranscriber:
    def __init__(self):
        self.calls = []

    def transcribe(self, clips, sr, context="", language=None, progress=None):
        self.calls.append(dict(n=len(clips), context=context, language=language, lens=[len(c) / sr for c in clips]))
        outs = [("Chinese", "我们开始开会吧"), ("Chinese,English", "这个 release 要延后"), ("Chinese", "。")]
        if progress:
            progress(1.0)
        return outs[: len(clips)]


def test_full_pipeline_with_fakes(two_speaker_wav, tmp_path):
    reports = []
    diarizer, transcriber = FakeDiarizer(), FakeTranscriber()
    result = run_job(
        JobSpec(str(two_speaker_wav), str(tmp_path), {"language": "auto", "diarize": True, "vocabulary": "Kubernetes", "script": "zh-TW", "numSpeakers": 2}),
        report=lambda stage, p: reports.append((stage, p)) or True,
        transcriber=transcriber,
        diarizer=diarizer,
    )
    assert diarizer.kwargs["num_speakers"] == 2
    assert transcriber.calls[0]["context"] == "Kubernetes"
    assert transcriber.calls[0]["language"] is None
    assert transcriber.calls[0]["n"] == 3
    # Third segment was punctuation only and is dropped.
    assert [s["text"] for s in result["segments"]] == ["我們開始開會吧", "這個 release 要延後"]
    assert result["speakers"] == ["SPK_7", "SPK_2"]
    assert result["language"] == "Chinese,English"
    assert result["hasPlayback"] and result["hasPeaks"] and not result["hasVideo"]
    assert (tmp_path / "playback.m4a").exists()
    stages = [s for s, _ in reports]
    assert stages[0] == "decoding" and "diarizing" in stages and stages[-1] == "finalizing"
    progress_values = [p for _, p in reports]
    assert progress_values == sorted(progress_values)


def test_pipeline_without_diarization(two_speaker_wav, tmp_path):
    transcriber = FakeTranscriber()
    result = run_job(
        JobSpec(str(two_speaker_wav), str(tmp_path), {"diarize": False, "language": "Chinese", "script": "none"}),
        report=lambda s, p: True,
        transcriber=transcriber,
        diarizer=FakeDiarizer(),
    )
    assert transcriber.calls[0]["language"] == "Chinese"
    assert result["speakers"] == []
    assert all(s["speaker"] is None for s in result["segments"])
    assert result["segments"][0]["text"] == "我们开始开会吧"


def test_diarization_failure_falls_back(two_speaker_wav, tmp_path):
    class Broken:
        def run(self, *a, **k):
            raise RuntimeError("no HF token")

    result = run_job(JobSpec(str(two_speaker_wav), str(tmp_path), {}), lambda s, p: True, FakeTranscriber(), Broken())
    assert result["speakers"] == [] and result["segments"]


def test_cancellation_stops_the_job(two_speaker_wav, tmp_path):
    with pytest.raises(Canceled):
        run_job(JobSpec(str(two_speaker_wav), str(tmp_path), {}), lambda s, p: s != "diarizing", FakeTranscriber(), FakeDiarizer())


def test_dominant_language():
    assert _dominant_language(["Chinese", "Chinese", "English"], [10, 10, 1]) == "Chinese"
    assert _dominant_language(["Chinese", "English"], [10, 5]) == "Chinese,English"
    assert _dominant_language([], []) is None
