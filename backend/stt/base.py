"""Interfaccia comune ai motori di riconoscimento vocale.

Speculare a ``backend/tts/base.py``: la' si va da testo ad audio, qui da audio
a testo. Il formato dell'audio in ingresso e' lo stesso che il TTS produce in
uscita — **mono float32 in -1..1** — cosi' i due lati della catena vocale
parlano la stessa lingua e non serve alcuna conversione intermedia.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import numpy as np

#: Whisper e quasi tutti i modelli di riconoscimento lavorano a 16 kHz.
#: Il frontend ricampiona gia' a questa frequenza prima di inviare.
SAMPLE_RATE = 16000


@dataclass
class Transcript:
    """Il risultato di una trascrizione."""

    text: str
    #: Lingua riconosciuta (codice ISO), se il motore la espone.
    language: str | None = None
    #: Confidenza media 0-1, se disponibile: utile per scartare il rumore.
    confidence: float | None = None
    #: Durata dell'audio trascritto, in secondi.
    duration: float = 0.0
    meta: dict = field(default_factory=dict)

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


class STTEngine(ABC):
    """Contratto minimo che ogni backend di riconoscimento deve rispettare."""

    #: Nome breve del motore, esposto via /api/health.
    name: str = "stt"

    @abstractmethod
    def transcribe(
        self,
        samples: np.ndarray,
        sample_rate: int = SAMPLE_RATE,
        language: str | None = None,
    ) -> Transcript:
        """Trascrive audio mono float32 in -1..1.

        Viene chiamato dentro un thread pool, quindi puo' essere bloccante.
        """

    def close(self) -> None:
        """Rilascia eventuali risorse (modelli caricati, client HTTP, ...)."""


def to_pcm16(samples: np.ndarray) -> bytes:
    """float32 -1..1 -> PCM 16 bit little-endian, il formato che i server vogliono."""
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def from_pcm16(raw: bytes) -> np.ndarray:
    """PCM 16 bit little-endian -> float32 -1..1 (quello che arriva dal browser)."""
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
