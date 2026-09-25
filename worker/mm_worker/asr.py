"""Speech recognition with Qwen3-ASR."""

from __future__ import annotations

from typing import Callable, List, Optional, Sequence, Tuple

import numpy as np


class Transcriber:
    def __init__(self, model: str, device: str, backend: str = "transformers", batch_size: int = 16, max_new_tokens: int = 512):
        self.model_name = model
        self.device = device
        self.backend = backend
        self.batch_size = max(1, batch_size)
        self.max_new_tokens = max_new_tokens
        self._model = None

    def load(self):
        if self._model is not None:
            return self._model
        import torch
        from qwen_asr import Qwen3ASRModel

        if self.backend == "vllm":
            self._model = Qwen3ASRModel.LLM(
                model=self.model_name,
                gpu_memory_utilization=0.6,
                max_inference_batch_size=self.batch_size * 4,
                max_new_tokens=self.max_new_tokens,
            )
        else:
            self._model = Qwen3ASRModel.from_pretrained(
                self.model_name,
                dtype=torch.bfloat16,
                device_map=self.device,
                max_inference_batch_size=self.batch_size,
                max_new_tokens=self.max_new_tokens,
            )
        return self._model

    def transcribe(
        self,
        clips: Sequence[np.ndarray],
        sr: int,
        context: str = "",
        language: Optional[str] = None,
        progress: Optional[Callable[[float], bool]] = None,
    ) -> List[Tuple[str, str]]:
        """Transcribe clips in batches. Returns (language, text) per clip.

        ``progress`` receives the completed fraction after each batch and may
        return False to abort.
        """
        model = self.load()
        results: List[Tuple[str, str]] = []
        step = self.batch_size if self.backend != "vllm" else self.batch_size * 4
        for i in range(0, len(clips), step):
            batch = [(np.ascontiguousarray(c, dtype=np.float32), sr) for c in clips[i : i + step]]
            out = model.transcribe(audio=batch, context=context, language=language)
            results.extend((r.language or "", r.text or "") for r in out)
            if progress is not None and progress(min(1.0, (i + len(batch)) / max(1, len(clips)))) is False:
                raise InterruptedError("canceled")
        return results
