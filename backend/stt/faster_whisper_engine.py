"""Local speech recognition with Faster-Whisper.

It's Whisper reimplemented on CTranslate2: the same quality as the original
but much faster and with less memory, which matters because here it runs
beside an LLM and a TTS engine competing for the same machine.

The model loads lazily at the first sentence: loading it at startup would
slow down the companion's start even for those who don't use the voice.
"""

from __future__ import annotations

import logging
import threading

import numpy as np

from .base import SAMPLE_RATE, STTEngine, Transcript

logger = logging.getLogger(__name__)

#: "auto" means "let the model decide": we turn it into None.
_AUTO = {"", "auto", "any"}


class FasterWhisperSTT(STTEngine):
    """Local transcription through the ``faster-whisper`` package."""

    name = "faster_whisper"

    def __init__(
        self,
        model: str = "base",
        device: str = "auto",
        language: str = "auto",
    ) -> None:
        try:
            from faster_whisper import WhisperModel  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "Local speech recognition needs 'faster-whisper'. "
                "Install it with: pip install faster-whisper"
            ) from exc

        self.model_name = model
        self.device = device
        self.language = None if language.lower() in _AUTO else language
        self._model = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    def _load(self, device: str, compute: str):
        """Loads the model and really tries it, so as not to fail later.

        Building ``WhisperModel`` on the GPU succeeds even when the CUDA libraries
        are missing: the error shows up only at the first transcription. Here we do
        a dry run on half a second of silence right away, so an environment
        without cuBLAS is found now and not with the microphone open.
        """
        from faster_whisper import WhisperModel

        model = WhisperModel(self.model_name, device=device, compute_type=compute)
        probe = np.zeros(SAMPLE_RATE // 2, dtype=np.float32)
        list(model.transcribe(probe, beam_size=1)[0])
        return model

    def prepare(self) -> None:
        with self._lock:
            self._ensure_model()

    def _ensure_model(self):
        """Loads the model at the first request, only once."""
        if self._model is not None:
            return self._model

        # int8 on the CPU halves the memory and speeds things up a lot, with a
        # negligible loss on short sentences like those said to a companion.
        attempts: list[tuple[str, str]] = []
        if self.device == "auto":
            attempts = [("cuda", "float16"), ("cpu", "int8")]
        elif self.device == "cuda":
            attempts = [("cuda", "float16")]
        else:
            attempts = [("cpu", "int8")]

        last: Exception | None = None
        for device, compute in attempts:
            try:
                logger.info(
                    "Loading Whisper '%s' (device=%s, compute=%s)...",
                    self.model_name,
                    device,
                    compute,
                )
                self._model = self._load(device, compute)
                logger.info("Whisper ready on %s", device)
                return self._model
            except Exception as exc:
                last = exc
                logger.warning("Whisper doesn't start on %s: %s", device, str(exc)[:120])

        raise RuntimeError(f"Impossibile caricare Whisper '{self.model_name}': {last}")

    # ------------------------------------------------------------------
    def transcribe(
        self,
        samples: np.ndarray,
        sample_rate: int = SAMPLE_RATE,
        language: str | None = None,
    ) -> Transcript:
        audio = np.ascontiguousarray(samples, dtype=np.float32)
        duration = len(audio) / float(sample_rate or SAMPLE_RATE)

        if duration < 0.2:  # too short to contain words: it's a click
            return Transcript(text="", duration=duration, meta={"engine": self.name})

        with self._lock:
            model = self._ensure_model()
            segments, info = model.transcribe(
                audio,
                language=language or self.language,
                # The internal VAD drops the silences: without it, Whisper tends to
                # "hallucinate" polite phrases over the mute stretches.
                vad_filter=True,
                beam_size=1,
            )
            pieces = list(segments)

        text = " ".join(segment.text.strip() for segment in pieces).strip()
        confidence = None
        if pieces:
            # avg_logprob is a negative logarithm: we bring it back to 0-1.
            mean_logprob = sum(s.avg_logprob for s in pieces) / len(pieces)
            confidence = float(np.exp(mean_logprob))

        return Transcript(
            text=text,
            language=getattr(info, "language", None),
            confidence=confidence,
            duration=duration,
            meta={"engine": self.name, "model": self.model_name},
        )
