import json

import numpy as np
import pytest

from mm_worker import audio


def test_probe_and_decode_audio(two_speaker_wav):
    info = audio.probe(str(two_speaker_wav))
    assert info.has_audio and not info.has_video
    assert 10.5 < info.duration < 11.5
    wav = audio.decode_pcm(str(two_speaker_wav), duration=info.duration)
    assert wav.dtype == np.float32
    assert abs(len(wav) / audio.SAMPLE_RATE - 11.0) < 0.2


def test_probe_detects_video(video_file):
    info = audio.probe(str(video_file))
    assert info.has_video and info.has_audio


def test_playback_rendition(video_file, tmp_path):
    dest = tmp_path / "playback.m4a"
    assert audio.write_playback(str(video_file), dest)
    info = audio.probe(str(dest))
    assert info.has_audio and not info.has_video


def test_rejects_garbage(tmp_path):
    bad = tmp_path / "bad.mp3"
    bad.write_bytes(b"definitely not audio" * 100)
    with pytest.raises(audio.MediaError):
        info = audio.probe(str(bad))
        audio.decode_pcm(str(bad), duration=info.duration)


def test_peaks(tmp_path):
    sr = audio.SAMPLE_RATE
    wav = np.concatenate([np.zeros(sr, dtype=np.float32), np.full(sr, 0.5, dtype=np.float32)])
    p = audio.compute_peaks(wav, per_second=10)
    assert p["duration"] == 2.0 and len(p["peaks"]) == 20
    assert max(p["peaks"][:10]) == 0 and min(p["peaks"][10:]) == 255
    audio.write_peaks(wav, tmp_path / "peaks.json")
    assert json.loads((tmp_path / "peaks.json").read_text())["version"] == 1


def test_browser_recording_webm_opus(tmp_path):
    """MediaRecorder output (WebM/Opus without a duration header) decodes correctly."""
    import subprocess

    out = tmp_path / "recording.weba"
    subprocess.run(
        [audio.ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
         "-c:a", "libopus", "-b:a", "64k", "-f", "webm", str(out)],
        check=True,
    )
    info = audio.probe(str(out))
    assert info.has_audio and not info.has_video
    wav = audio.decode_pcm(str(out), duration=info.duration)
    assert abs(len(wav) / audio.SAMPLE_RATE - 4.0) < 0.2
    assert audio.write_playback(str(out), tmp_path / "playback.m4a")


def test_decoding_stops_at_the_length_limit(tmp_path):
    # A long recording (or a small file that expands to hours of audio) must not
    # be decoded into memory past MAX_AUDIO_HOURS.
    src = tmp_path / "long.wav"
    sr = 16000
    wav = (np.sin(np.arange(sr * 20) / sr * 2 * np.pi * 440) * 0.3).astype(np.float32)
    import wave

    with wave.open(str(src), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((wav * 32767).astype(np.int16).tobytes())
    assert len(audio.decode_pcm(str(src), max_seconds=30)) == sr * 20
    with pytest.raises(audio.MediaError, match="hour limit"):
        audio.decode_pcm(str(src), max_seconds=5)


def test_crafted_playlists_cannot_reach_other_files_or_the_network(tmp_path):
    # ffmpeg picks formats by content, so an ".mp3" may really be a playlist.
    other = tmp_path / "other"
    other.mkdir()
    for name, body in {
        "hls.mp3": "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:9/secret\n#EXT-X-ENDLIST\n",
        "concat-up.mp3": "ffconcat version 1.0\nfile ../other/original.mp3\n",
        "concat-abs.mp3": "ffconcat version 1.0\nfile /etc/hostname\n",
        "concat-net.mp3": "ffconcat version 1.0\nfile http://127.0.0.1:9/secret\n",
    }.items():
        (tmp_path / name).write_text(body)
        with pytest.raises(audio.MediaError):
            audio.decode_pcm(str(tmp_path / name))
