"""Speaker separation on the CPU (sherpa-onnx): speaker counts, cancellation, the real models."""

import os
import sys
import types
from pathlib import Path

import numpy as np
import pytest

from mm_worker import audio, onnx_voice
from mm_worker.fakes import FakeEmbedder
from mm_worker.onnx_diarize import SEGMENTATION_FILE, OnnxDiarizer


class Seg:
    def __init__(self, start, end, speaker):
        self.start, self.end, self.speaker = start, end, speaker


class FakeSherpa(types.ModuleType):
    """Stands in for sherpa_onnx: finds `natural` speakers, or the count it is given."""

    def __init__(self, natural=3):
        super().__init__("sherpa_onnx")
        self.natural = natural
        self.runs = []
        outer = self

        class Config:
            def __init__(self, **kw):
                self.__dict__.update(kw)

        self.OfflineSpeakerDiarizationConfig = Config
        self.OfflineSpeakerSegmentationModelConfig = Config
        self.OfflineSpeakerSegmentationPyannoteModelConfig = Config
        self.SpeakerEmbeddingExtractorConfig = Config
        self.FastClusteringConfig = Config

        class Result(list):
            def sort_by_start_time(self):
                return sorted(self, key=lambda s: s.start)

        class Diarization:
            def __init__(self, config):
                self.config = config

            def set_config(self, config):
                self.config = config

            def process(self, x, callback=None):
                n = self.config.clustering.num_clusters
                n = outer.natural if n < 0 else n
                outer.runs.append(n)
                for done in range(1, 5):
                    if callback:
                        callback(done, 4)
                return Result(Seg(i * 2.0, i * 2.0 + 1.5, i % n) for i in range(2 * n))

        self.OfflineSpeakerDiarization = Diarization


@pytest.fixture
def sherpa(monkeypatch, tmp_path):
    fake = FakeSherpa()
    monkeypatch.setitem(sys.modules, "sherpa_onnx", fake)
    # The models are "downloaded" already.
    (tmp_path / SEGMENTATION_FILE).write_bytes(b"x")
    (tmp_path / onnx_voice.MODEL_FILE).write_bytes(b"x")
    return fake, tmp_path


def wav(sec=10.0):
    return np.zeros(int(16000 * sec), dtype=np.float32)


def test_automatic_count_and_labels(sherpa):
    fake, d = sherpa
    turns = OnnxDiarizer(d, FakeEmbedder(), threads=2).run(wav(), 16000)
    assert {t[2] for t in turns} == {"SPEAKER_00", "SPEAKER_01", "SPEAKER_02"} and fake.runs == [3]
    assert turns == sorted(turns)


def test_exact_count_is_used_directly(sherpa):
    fake, d = sherpa
    OnnxDiarizer(d, FakeEmbedder()).run(wav(), 16000, num_speakers=5)
    assert fake.runs == [5]


def test_a_count_outside_the_range_is_redone_within_it(sherpa):
    fake, d = sherpa
    seen = []
    turns = OnnxDiarizer(d, FakeEmbedder()).run(wav(), 16000, min_speakers=4, max_speakers=6, progress=seen.append)
    assert fake.runs == [3, 4] and len({t[2] for t in turns}) == 4
    assert seen == sorted(seen) and seen[-1] == 1.0
    fake.runs.clear()
    OnnxDiarizer(d, FakeEmbedder()).run(wav(), 16000, max_speakers=2)
    assert fake.runs == [3, 2]
    fake.runs.clear()
    OnnxDiarizer(d, FakeEmbedder()).run(wav(), 16000, min_speakers=2, max_speakers=4)
    assert fake.runs == [3]  # inside the range: one pass


def test_cancel_stops_it(sherpa):
    _, d = sherpa

    class Canceled(Exception):
        pass

    def progress(f):
        if f > 0.3:
            raise Canceled()

    with pytest.raises(Canceled):
        OnnxDiarizer(d, FakeEmbedder()).run(wav(), 16000, progress=progress)


MODEL_DIR = os.environ.get("MM_TEST_ONNX_MODEL_DIR")
# sherpa-onnx's 4-speaker Mandarin sample (0-four-speakers-zh.wav from its speaker-segmentation-models release).
SPEECH = os.environ.get("MM_TEST_SPEECH_WAV")


@pytest.mark.skipif(
    not MODEL_DIR or not SPEECH or not (Path(MODEL_DIR or ".") / SEGMENTATION_FILE).exists(),
    reason="set MM_TEST_ONNX_MODEL_DIR (both models) and MM_TEST_SPEECH_WAV (a 4-speaker recording)",
)
def test_real_models_on_four_speakers():
    x = audio.decode_pcm(SPEECH)
    d = OnnxDiarizer(Path(MODEL_DIR), onnx_voice.OnnxVoiceEmbedder(Path(MODEL_DIR)))
    assert len({t[2] for t in d.run(x, 16000)}) == 4
    assert len({t[2] for t in d.run(x, 16000, num_speakers=3)}) == 3


def test_bench_reports_each_thread_count(sherpa, two_speaker_wav):
    from mm_worker.bench import parse_threads, run_bench

    _, d = sherpa
    lines = []
    results = run_bench(d, str(two_speaker_wav), parse_threads("1,2"), 5, printer=lines.append)
    assert [r["threads"] for r in results] == [1, 2] and all(r["speakers"] == 3 for r in results)
    assert any("one-hour meeting" in line for line in lines)
    with pytest.raises(ValueError):
        parse_threads("0")
