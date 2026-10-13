import numpy as np
import pytest

from mm_worker import voices
from mm_worker.fakes import FakeDiarizer
from mm_worker.pipeline import JobSpec, run_voiceprint
from mm_worker.audio import MediaError


def test_spans_by_speaker_skips_unlabelled_and_empty_turns():
    spans = voices.spans_by_speaker([(0, 2, "A"), (2, 2, "A"), (3, 5, None), (5, 9, "B"), (9, 10, "A")])
    assert spans == {"A": [(0.0, 2.0), (9.0, 10.0)], "B": [(5.0, 9.0)]}


def test_windows_split_evenly_merge_adjacent_and_drop_short_bits():
    # 0-4 and 4.1-12 are one stretch (12 s -> two 6 s windows); 20-20.5 is too short.
    assert voices.windows([(4.1, 12.0), (0.0, 4.0), (20.0, 20.5)]) == [(0.0, 6.0), (6.0, 12.0)]


def test_windows_keep_the_longest_up_to_the_limit_in_time_order():
    spans = [(0, 1.5), (10, 18), (30, 32), (40, 49)]
    assert voices.windows(spans, limit=2) == [(10, 18), (40, 49)]


def test_combine_weights_by_length_and_ignores_unusable_rows():
    emb = np.array([[2.0, 0.0], [0.0, 1.0], [np.nan, 1.0], [0.0, 0.0]])
    v = voices.combine(emb, [3.0, 1.0, 5.0, 5.0])
    assert v is not None and np.isclose(np.linalg.norm(v), 1.0)
    assert np.allclose(v, np.array([3.0, 1.0]) / np.sqrt(10.0), atol=1e-6)
    assert voices.combine(np.full((2, 3), np.nan), [1, 1]) is None
    assert voices.combine(np.zeros((0, 3)), []) is None


def test_fingerprints_tell_two_voices_apart_and_recognise_the_same_one():
    sr = 16000
    t = np.arange(sr * 12) / sr
    low, high = np.sin(2 * np.pi * 220 * t), np.sin(2 * np.pi * 1300 * t)
    wav = np.concatenate([low[: sr * 6], high[: sr * 6], low[: sr * 6]]).astype(np.float32)
    fake = FakeDiarizer()
    out = voices.fingerprints(wav, sr, {"A": [(0, 6)], "B": [(6, 12)], "A2": [(12, 18)], "C": [(1, 1.4)]}, lambda c: fake.embed(c, sr))
    # C has too little speech for a fingerprint.
    assert set(out) == {"A", "B", "A2"}
    assert out["A"]["speechSec"] == 6.0
    vec = {k: np.array(v["embedding"]) for k, v in out.items()}
    assert vec["A"] @ vec["A2"] > 0.99
    assert vec["A"] @ vec["B"] < 0.5


def test_voiceprint_job_uses_the_transcript_speakers(two_speaker_wav, tmp_path):
    reports = []
    job = JobSpec(str(two_speaker_wav), str(tmp_path), {"speakers": {"SPEAKER_00": [[0, 3], [9, 11]], "SPEAKER_01": [[4, 8]], "MANUAL_x": [[50, 60]]}})
    result = run_voiceprint(job, lambda s, p: reports.append((s, p)) or True, FakeDiarizer())
    assert result["voiceModel"] == "fake"
    # MANUAL_x has spans only beyond the end of the recording.
    assert set(result["voices"]) == {"SPEAKER_00", "SPEAKER_01"}
    assert result["voices"]["SPEAKER_00"]["speechSec"] == pytest.approx(5.0, abs=0.05)
    a, b = (np.array(result["voices"][k]["embedding"]) for k in ("SPEAKER_00", "SPEAKER_01"))
    assert a @ b < 0.5
    assert [s for s, _ in reports][-1] == "voiceprint"
    # Nothing is written next to the meeting: a voiceprint never touches its media.
    assert not list(tmp_path.iterdir())


def test_voiceprint_job_needs_the_diarization_model(two_speaker_wav, tmp_path):
    with pytest.raises(MediaError, match="401"):
        run_voiceprint(JobSpec(str(two_speaker_wav), str(tmp_path), {"speakers": {}}), lambda s, p: True, None, diarizer_unavailable="401 Unauthorized")


def test_voiceprint_job_failure_is_not_swallowed(two_speaker_wav, tmp_path):
    class Broken(FakeDiarizer):
        def embed(self, clips, sr):
            raise RuntimeError("CUDA error")

    with pytest.raises(RuntimeError, match="CUDA"):
        run_voiceprint(JobSpec(str(two_speaker_wav), str(tmp_path), {"speakers": {"A": [[0, 3]]}}), lambda s, p: True, Broken())
