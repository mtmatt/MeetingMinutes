"""Speaker diarization with pyannote.audio (community-1 pipeline)."""

from __future__ import annotations

import os
from typing import Callable, List, Optional, Tuple

import numpy as np

# Opt out of pyannote's anonymous usage telemetry.
os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "false")

Turn = Tuple[float, float, str]


class DiarizationUnavailable(Exception):
    """Raised when the pipeline cannot be loaded (e.g. missing HF token or unaccepted license)."""


class Diarizer:
    def __init__(self, model: str, device: str, hf_token: Optional[str]):
        self.model = model
        self.device = device
        self.hf_token = hf_token
        self._pipeline = None

    def load(self):
        if self._pipeline is not None:
            return self._pipeline
        try:
            import torch
            from pyannote.audio import Pipeline
        except ImportError as e:  # pragma: no cover
            raise DiarizationUnavailable(f"pyannote.audio is not installed: {e}") from e
        try:
            pipeline = Pipeline.from_pretrained(self.model, token=self.hf_token)
        except Exception as e:
            raise DiarizationUnavailable(
                f"Could not load {self.model}: {e}. Set HF_TOKEN and accept the model's conditions on Hugging Face."
            ) from e
        if pipeline is None:
            raise DiarizationUnavailable(
                f"Could not load {self.model}. Set HF_TOKEN and accept the model's conditions on Hugging Face."
            )
        if self.device.startswith("cuda"):
            pipeline.to(torch.device(self.device))
        self._pipeline = pipeline
        return pipeline

    def run(
        self,
        wav: np.ndarray,
        sr: int,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
        progress: Optional[Callable[[float], None]] = None,
    ) -> List[Turn]:
        import torch

        pipeline = self.load()
        kwargs = {}
        if num_speakers:
            kwargs["num_speakers"] = int(num_speakers)
        else:
            if min_speakers:
                kwargs["min_speakers"] = int(min_speakers)
            if max_speakers:
                kwargs["max_speakers"] = int(max_speakers)

        # pyannote reports progress per internal step; weight the slow ones.
        steps = ["segmentation", "speaker_counting", "embeddings", "discrete_diarization"]
        weights = {"segmentation": 0.45, "speaker_counting": 0.05, "embeddings": 0.45, "discrete_diarization": 0.05}

        def hook(step_name, step_artifact, file=None, total=None, completed=None):
            if progress is None or step_name not in weights:
                return
            base = sum(weights[k] for k in steps[: steps.index(step_name)])
            frac = (completed / total) if total and completed is not None else 1.0
            progress(min(1.0, base + weights[step_name] * frac))

        waveform = torch.from_numpy(np.ascontiguousarray(wav)).unsqueeze(0)
        output = pipeline({"waveform": waveform, "sample_rate": sr}, hook=hook, **kwargs)
        # community-1 returns DiarizeOutput; legacy pipelines return an Annotation.
        annotation = getattr(output, "exclusive_speaker_diarization", None) or getattr(output, "speaker_diarization", output)
        turns: List[Turn] = []
        for segment, _, speaker in annotation.itertracks(yield_label=True):
            turns.append((float(segment.start), float(segment.end), str(speaker)))
        return turns
