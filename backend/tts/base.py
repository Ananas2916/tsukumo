"""Interfaccia comune ai motori di sintesi vocale."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import numpy as np


@dataclass
class Speech:
    """Il risultato di una sintesi: audio + metadati utili al lip-sync."""

    samples: np.ndarray
    sample_rate: int
    text: str
    #: Trascrizione IPA, se il motore riesce a fornirla (migliora il lip-sync).
    phonemes: str | None = None
    #: Timing esatti per fonema ``[(simbolo, inizio_s, fine_s), ...]``, se il
    #: modello li espone: e' la sorgente migliore in assoluto per il lip-sync.
    timings: list[tuple[str, float, float]] | None = None
    #: Informazioni libere per il debug (voce usata, engine, ...).
    meta: dict = field(default_factory=dict)

    @property
    def duration(self) -> float:
        if self.sample_rate <= 0:
            return 0.0
        return float(len(self.samples)) / float(self.sample_rate)


class TTSEngine(ABC):
    """Contratto minimo che ogni backend TTS deve rispettare."""

    #: Nome breve dell'engine, esposto via /api/health.
    name: str = "tts"

    @abstractmethod
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        """Sintetizza ``text`` e restituisce audio mono float32 in -1..1."""

    @abstractmethod
    def voices(self) -> list[str]:
        """Elenco delle voci disponibili."""

    def phonemize(self, text: str, lang: str | None = None) -> str | None:
        """Trascrizione IPA del testo, se il motore la espone."""
        return None

    def close(self) -> None:
        """Rilascia eventuali risorse (sessioni ONNX, client HTTP, ...)."""
