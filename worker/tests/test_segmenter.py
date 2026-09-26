import numpy as np

from mm_worker import segmenter
from mm_worker.segmenter import Segment


def test_merges_same_speaker_turns_with_short_gaps():
    turns = [(0.0, 2.0, "A"), (2.3, 4.0, "A"), (4.5, 6.0, "B"), (8.0, 9.0, "B")]
    plan = segmenter.plan_from_turns(turns, duration=10.0, pad=0.0)
    assert [(s.start, s.end, s.speaker) for s in plan] == [(0.0, 4.0, "A"), (4.5, 6.0, "B"), (8.0, 9.0, "B")]


def test_absorbs_tiny_blips_and_drops_isolated_noise():
    turns = [(0.0, 3.0, "A"), (3.1, 3.2, "B"), (3.3, 5.0, "A"), (9.0, 9.1, "C")]
    plan = segmenter.plan_from_turns(turns, duration=10.0, pad=0.0)
    assert len(plan) == 1
    assert plan[0].speaker == "A" and plan[0].start == 0.0 and plan[0].end == 5.0


def test_splits_long_turns_into_balanced_pieces_within_limit():
    turns = [(0.0, 95.0, "A")]
    plan = segmenter.plan_from_turns(turns, duration=100.0, max_len=30.0, pad=0.0)
    durations = [s.duration for s in plan]
    assert all(d <= 30.0 + 1e-6 for d in durations)
    assert len(plan) == 4
    assert min(durations) > 15  # no tiny tail
    # Pieces tile the turn exactly.
    assert plan[0].start == 0.0 and plan[-1].end == 95.0
    for a, b in zip(plan, plan[1:]):
        assert abs(a.end - b.start) < 1e-9


def test_split_prefers_quiet_points():
    sr = 16000
    wav = np.full(sr * 50, 0.5, dtype=np.float32)
    quiet_at = 22.0
    wav[int(quiet_at * sr) : int((quiet_at + 0.5) * sr)] = 0.0
    energy = segmenter.frame_energy(wav, sr)
    pieces = segmenter.split_long(Segment(0.0, 50.0, "A"), energy, max_len=30.0)
    assert len(pieces) == 2
    assert quiet_at - 0.1 <= pieces[0].end <= quiet_at + 0.6


def test_padding_never_crosses_gap_midpoint_or_bounds():
    turns = [(0.05, 2.0, "A"), (2.1, 4.0, "B"), (6.0, 9.95, "A")]
    plan = segmenter.plan_from_turns(turns, duration=10.0, pad=0.15)
    assert plan[0].start == 0.0
    assert plan[0].end == 2.05 and plan[1].start == 2.05
    assert plan[1].end == 4.15 and plan[2].start == 5.85
    assert plan[2].end == 10.0
    for a, b in zip(plan, plan[1:]):
        assert a.end <= b.start


def test_energy_vad_finds_speech_regions():
    sr = 16000
    rng = np.random.default_rng(0)
    noise = lambda s: (rng.standard_normal(int(sr * s)) * 0.002).astype(np.float32)
    speech = lambda s: (rng.standard_normal(int(sr * s)) * 0.2).astype(np.float32)
    wav = np.concatenate([noise(2), speech(3), noise(2), speech(1), noise(0.3), speech(1.5), noise(2)])
    plan = segmenter.plan_without_diarization(wav, sr, pad=0.0)
    assert len(plan) == 2
    assert abs(plan[0].start - 2.0) < 0.1 and abs(plan[0].end - 5.0) < 0.1
    # The 0.3 s pause is bridged.
    assert abs(plan[1].start - 7.0) < 0.1 and abs(plan[1].end - 9.8) < 0.1
    assert all(s.speaker is None for s in plan)


def test_vad_on_silence_returns_nothing():
    assert segmenter.plan_without_diarization(np.zeros(16000 * 5, dtype=np.float32)) == []
