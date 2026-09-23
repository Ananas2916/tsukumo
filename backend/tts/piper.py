"""Sintesi locale con Piper.

Piper e' molto piu' leggero di Kokoro: gira bene anche su CPU modeste e su
Raspberry Pi, al prezzo di una voce un po' meno espressiva. Ogni voce e' una
coppia di file (``.onnx`` + ``.onnx.json``) da scaricare da
huggingface.co/rhasspy/piper-voices.

Restituisce PCM a 16 bit, quindi non serve alcun decoder audio.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from .base import Speech, TTSEngine

logger = logging.getLogger(__name__)


class PiperTTS(TTSEngine):
    """Sintesi locale tramite il pacchetto ``piper-tts``."""

    name = "piper"

    def __init__(self, model_path: str | Path, default_speed: float = 1.0) -> None:
        try:
            from piper import PiperVoice
        except ImportError as exc:
            raise RuntimeError(
                "Il motore Piper richiede il pacchetto 'piper-tts'. "
                "Installalo con: pip install piper-tts"
            ) from exc

        path = Path(model_path).expanduser()
        if not path.is_file():
            raise RuntimeError(
                f"Voce Piper non trovata: {path}. Scaricane una da "
                "huggingface.co/rhasspy/piper-voices e indicala in DC_PIPER_MODEL."
            )

        self.model_path = path
        self.default_speed = default_speed
        self._voice = PiperVoice.load(str(path))
        logger.info("Piper caricato: %s", path.name)

    # ------------------------------------------------------------------
    def voices(self) -> list[str]:
        # Una installazione di Piper = una voce: per cambiarla si cambia file.
        return [self.model_path.stem]

    # ------------------------------------------------------------------
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        clean = (text or "").strip()
        chosen_speed = float(speed if speed is not None else self.default_speed)
        sample_rate = int(self._voice.config.sample_rate)

        if not clean:
            return Speech(
                samples=np.zeros(0, dtype=np.float32),
                sample_rate=sample_rate,
                text="",
                meta={"engine": self.name},
            )

        # In Piper la "lunghezza" e' l'inverso della velocita'.
        length_scale = 1.0 / chosen_speed if chosen_speed > 0 else 1.0

        chunks: list[np.ndarray] = []
        for chunk in self._voice.synthesize(clean, length_scale=length_scale):
            raw = getattr(chunk, "audio_int16_bytes", None)
            if raw is None:  # versioni piu' vecchie restituiscono i byte grezzi
                raw = bytes(chunk)
            chunks.append(np.frombuffer(raw, dtype="<i2"))

        samples = (
            np.concatenate(chunks).astype(np.float32) / 32768.0
            if chunks
            else np.zeros(0, dtype=np.float32)
        )

        return Speech(
            samples=np.ascontiguousarray(samples),
            sample_rate=sample_rate,
            text=clean,
            meta={"engine": self.name, "voice": self.model_path.stem, "speed": chosen_speed},
        )
