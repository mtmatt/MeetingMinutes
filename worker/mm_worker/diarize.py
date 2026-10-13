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
        # Voice fingerprints are only comparable when made by the same model.
        self.voice_model = model

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

    def embed(self, clips: List[np.ndarray], sr: int, batch_size: int = 32) -> np.ndarray:
        """One speaker embedding per mono clip, with the pipeline's own embedding model.

        Clips of different lengths share a batch: each is zero-padded to the
        longest, and a weight mask keeps the padding out of the statistics
        pooling. Rows are NaN for clips the model cannot embed.
        """
        import torch

        model = getattr(self.load(), "_embedding", None)
        if model is None:
            raise DiarizationUnavailable(f"{self.model} has no speaker embedding model.")
        if getattr(model, "sample_rate", sr) != sr:
            raise ValueError(f"The speaker embedding model expects {model.sample_rate} Hz audio, not {sr} Hz.")
        out: List[np.ndarray] = []
        frames_per_sec = 100
        for i in range(0, len(clips), batch_size):
            batch = clips[i : i + batch_size]
            longest = max(len(c) for c in batch)
            waveforms = np.zeros((len(batch), 1, longest), dtype=np.float32)
            num_frames = max(1, int(np.ceil(longest / sr * frames_per_sec)))
            masks = np.zeros((len(batch), num_frames), dtype=np.float32)
            for j, c in enumerate(batch):
                waveforms[j, 0, : len(c)] = c
                masks[j, : max(1, int(round(len(c) / longest * num_frames)))] = 1.0
            out.append(model(torch.from_numpy(waveforms), masks=torch.from_numpy(masks)))
        dimension = out[0].shape[1] if out else 0
        return np.vstack(out) if out else np.zeros((0, dimension), dtype=np.float32)
