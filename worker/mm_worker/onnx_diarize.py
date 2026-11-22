"""Speaker diarization on the CPU, without torch or a GPU: sherpa-onnx.

pyannote's segmentation-3.0 model (ONNX, MIT licence) finds who speaks
when in short windows; the same 3D-Speaker ERes2Net model that makes voice
fingerprints (onnx_voice) embeds each piece, and the pieces are clustered into
speakers. Nothing leaves the machine. Measured on a 4-core test machine: about
8 minutes of CPU time per hour of audio with 4 threads.

It is less accurate than pyannote community-1 on a GPU or pyannoteAI; with an
automatic speaker count it can split one person into two, so an exact count
(or a range) from the upload page helps most here.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Callable, List, Optional, Tuple

import numpy as np

from .onnx_voice import SAMPLE_RATE, VoiceModelUnavailable, ensure_model

log = logging.getLogger("mm_worker.onnx_diarize")

SEGMENTATION_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
SEGMENTATION_SHA256 = "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"
# The full-precision model: as fast as the int8 one here, and the int8 one found a fifth
# speaker in a 4-speaker Mandarin sample where this one found the right four.
SEGMENTATION_MEMBER = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
SEGMENTATION_MEMBER_SHA256 = "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"
SEGMENTATION_FILE = "pyannote-segmentation-3.0.onnx"

Turn = Tuple[float, float, str]


def default_threads() -> int:
    explicit = os.environ.get("DIARIZATION_CPU_THREADS", "").strip()
    if explicit.isdigit() and int(explicit) > 0:
        return int(explicit)
    return max(1, min(8, os.cpu_count() or 1))


class OnnxDiarizer:
    """Same interface as diarize.Diarizer: run() for turns, embed() for voice fingerprints."""

    def __init__(self, model_dir: Path, embedder, threads: Optional[int] = None, threshold: Optional[float] = None):
        self.model_dir = Path(model_dir)
        self.embedder = embedder
        self.threads = threads or default_threads()
        env = os.environ.get("DIARIZATION_CPU_THRESHOLD", "").strip()
        # sherpa-onnx's default: a larger threshold gives fewer speakers.
        self.threshold = threshold if threshold is not None else (float(env) if env else 0.5)

    @property
    def voice_model(self) -> str:
        return self.embedder.voice_model

    def _config(self, num_clusters: int):
        import sherpa_onnx

        segmentation = ensure_model(
            self.model_dir,
            url=SEGMENTATION_URL,
            sha256=SEGMENTATION_SHA256,
            filename=SEGMENTATION_FILE,
            member=SEGMENTATION_MEMBER,
            member_sha256=SEGMENTATION_MEMBER_SHA256,
        )
        embedding = ensure_model(self.model_dir)
        return sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation)),
                num_threads=self.threads,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding), num_threads=self.threads),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_clusters, threshold=self.threshold),
            min_duration_on=0.3,
            min_duration_off=0.5,
        )

    def load(self):
        """Download both models now (for `worker.sh check`)."""
        try:
            import sherpa_onnx  # noqa: F401
        except ImportError as e:
            raise VoiceModelUnavailable(f"sherpa-onnx is not installed ({e}); run scripts/install.sh again.") from e
        self._config(-1)
        return self

    def run(
        self,
        wav: np.ndarray,
        sr: int,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
        progress: Optional[Callable[[float], None]] = None,
    ) -> List[Turn]:
        import sherpa_onnx

        if sr != SAMPLE_RATE:
            raise ValueError(f"Speaker separation on the CPU expects {SAMPLE_RATE} Hz audio, not {sr} Hz.")
        x = np.ascontiguousarray(wav, dtype=np.float32)
        exact = int(num_speakers) if num_speakers else -1
        sd = sherpa_onnx.OfflineSpeakerDiarization(self._config(exact))
        # With a range, a second pass with the nearest allowed count may be needed: give each half the bar.
        passes = 2 if exact < 0 and (min_speakers or max_speakers) else 1

        def once(pass_index: int):
            raised: list = []

            def callback(done: int, total: int) -> int:
                if progress is not None and total:
                    try:
                        progress(min(1.0, (pass_index + done / total) / passes))
                    except BaseException as e:  # cancellation: stop sherpa-onnx by raising through it
                        raised.append(e)
                        raise
                return 0

            try:
                return sd.process(x, callback=callback).sort_by_start_time()
            except BaseException:
                if raised:
                    raise raised[0] from None
                raise

        segments = once(0)
        found = len({s.speaker for s in segments})
        lo, hi = int(min_speakers or 0), int(max_speakers or 0)
        target = None
        if exact < 0 and lo and found < lo:
            target = lo
        elif exact < 0 and hi and found > hi:
            target = hi
        if target:
            log.info("found %d speakers, outside %s-%s; separating into %d", found, lo or "", hi or "", target)
            sd.set_config(self._config(target))
            segments = once(1)
        if progress is not None:
            progress(1.0)
        return [(float(s.start), float(s.end), f"SPEAKER_{int(s.speaker):02d}") for s in segments if s.end > s.start]

    def embed(self, clips, sr: int) -> np.ndarray:
        return self.embedder.embed(clips, sr)

