"""Local speech recognition with NVIDIA Parakeet TDT, through ``onnx-asr``.

Parakeet TDT 0.6B v3 is multilingual (25 European languages, Italian among
them), writes punctuation and capitals by itself, and in int8 runs many times
faster than real time on the CPU. That last point is why it's here: the GPU is
usually busy with the TTS voice, and speech recognition can live without it.

``onnx-asr`` runs the exported ONNX model with onnxruntime alone, so there's no
NeMo or PyTorch to install. Like Whisper, the model loads at the first sentence.
"""

from __future__ import annotations

import logging
import threading

import numpy as np

from .base import SAMPLE_RATE, STTEngine, Transcript

logger = logging.getLogger(__name__)

#: The model names ``onnx-asr`` downloads from Hugging Face.
MODELS = {
    "v3": "nemo-parakeet-tdt-0.6b-v3",
    "v2": "nemo-parakeet-tdt-0.6b-v2",
}


class ParakeetSTT(STTEngine):
    """Local transcription through the ``onnx-asr`` package."""

    name = "parakeet"

    def __init__(self, model: str = "v3", quantization: str = "int8") -> None:
        try:
            import onnx_asr  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "Parakeet needs 'onnx-asr'. Install it with: pip install \"onnx-asr[cpu,hub]\""
            ) from exc

        self.model_name = MODELS.get(model, model)
        # "none" means the full-precision weights (about four times larger).
        self.quantization = None if quantization in ("", "none", "fp32") else quantization
        self._model = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    def prepare(self) -> None:
        with self._lock:
            self._ensure_model()

    def _ensure_model(self):
        if self._model is not None:
            return self._model
        import onnx_asr

        logger.info(
            "Loading Parakeet '%s' (quantization=%s)...", self.model_name, self.quantization or "none"
        )
        # CPU on purpose: it's fast enough there, and the GPU belongs to the voice.
        model = onnx_asr.load_model(
            self.model_name, quantization=self.quantization, providers=["CPUExecutionProvider"]
        )
        # A dry run now, so a broken runtime shows up here and not with the
        # microphone open (same reasoning as the Whisper engine).
        model.recognize(np.zeros(SAMPLE_RATE // 2, dtype=np.float32), sample_rate=SAMPLE_RATE)
        self._model = model
        logger.info("Parakeet ready")
        return model

    # ------------------------------------------------------------------
    def transcribe(
        self,
        samples: np.ndarray,
        sample_rate: int = SAMPLE_RATE,
        language: str | None = None,
    ) -> Transcript:
        audio = np.ascontiguousarray(samples, dtype=np.float32)
        rate = int(sample_rate or SAMPLE_RATE)
        duration = len(audio) / float(rate)

        if duration < 0.2:  # too short to contain words: it's a click
            return Transcript(text="", duration=duration, meta={"engine": self.name})

        # Parakeet detects the language by itself and takes no hint: ``language``
        # is accepted for the common contract and otherwise ignored.
        with self._lock:
            model = self._ensure_model()
            text = model.recognize(audio, sample_rate=rate)

        return Transcript(
            text=str(text or "").strip(),
            duration=duration,
            meta={"engine": self.name, "model": self.model_name},
        )
