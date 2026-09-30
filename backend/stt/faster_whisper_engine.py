"""Riconoscimento vocale locale con Faster-Whisper.

E' Whisper reimplementato su CTranslate2: stessa qualita' dell'originale ma
molto piu' rapido e con meno memoria, il che conta perche' qui gira accanto a
un LLM e a un motore TTS che si contendono la stessa macchina.

Il modello si carica pigramente alla prima frase: caricarlo all'avvio
rallenterebbe l'accensione del companion anche a chi non usa la voce.
"""

from __future__ import annotations

import logging
import threading

import numpy as np

from .base import SAMPLE_RATE, STTEngine, Transcript

logger = logging.getLogger(__name__)

#: "auto" significa "lascia decidere al modello": lo traduciamo in None.
_AUTO = {"", "auto", "any"}


class FasterWhisperSTT(STTEngine):
    """Trascrizione locale tramite il pacchetto ``faster-whisper``."""

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
                "Il riconoscimento vocale locale richiede 'faster-whisper'. "
                "Installalo con: pip install faster-whisper"
            ) from exc

        self.model_name = model
        self.device = device
        self.language = None if language.lower() in _AUTO else language
        self._model = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    def _load(self, device: str, compute: str):
        """Carica il modello e lo prova davvero, per non fallire dopo.

        Costruire ``WhisperModel`` su GPU riesce anche quando mancano le
        librerie CUDA: l'errore salta fuori solo alla prima trascrizione. Qui
        facciamo subito un giro a vuoto su mezzo secondo di silenzio, cosi' un
        ambiente senza cuBLAS viene scoperto adesso e non a microfono aperto.
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
        """Carica il modello alla prima richiesta, una volta sola."""
        if self._model is not None:
            return self._model

        # int8 sulla CPU dimezza la memoria e accelera parecchio, con una
        # perdita trascurabile su frasi brevi come quelle dette a un companion.
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
                    "Carico Whisper '%s' (device=%s, compute=%s)...",
                    self.model_name,
                    device,
                    compute,
                )
                self._model = self._load(device, compute)
                logger.info("Whisper pronto su %s", device)
                return self._model
            except Exception as exc:
                last = exc
                logger.warning("Whisper non parte su %s: %s", device, str(exc)[:120])

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

        if duration < 0.2:  # troppo corto per contenere parole: e' un click
            return Transcript(text="", duration=duration, meta={"engine": self.name})

        with self._lock:
            model = self._ensure_model()
            segments, info = model.transcribe(
                audio,
                language=language or self.language,
                # Il VAD interno scarta i silenzi: senza, Whisper tende a
                # "allucinare" frasi di cortesia sui tratti muti.
                vad_filter=True,
                beam_size=1,
            )
            pieces = list(segments)

        text = " ".join(segment.text.strip() for segment in pieces).strip()
        confidence = None
        if pieces:
            # avg_logprob e' un logaritmo negativo: lo riportiamo in 0-1.
            mean_logprob = sum(s.avg_logprob for s in pieces) / len(pieces)
            confidence = float(np.exp(mean_logprob))

        return Transcript(
            text=text,
            language=getattr(info, "language", None),
            confidence=confidence,
            duration=duration,
            meta={"engine": self.name, "model": self.model_name},
        )
