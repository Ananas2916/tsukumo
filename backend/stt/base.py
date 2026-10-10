"""Common interface of the speech-recognition engines.

It mirrors ``backend/tts/base.py``: there you go from text to audio, here from
audio to text. The incoming audio format is the same the TTS produces —
**mono float32 in -1..1** — so the two sides of the voice chain speak the same
language and no intermediate conversion is needed.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import numpy as np

#: Whisper and almost all recognition models work at 16 kHz.
#: The frontend already resamples to this rate before sending.
SAMPLE_RATE = 16000


@dataclass
class Transcript:
    """The result of a transcription."""

    text: str
    #: Recognized language (ISO code), if the engine exposes it.
    language: str | None = None
    #: Average confidence 0-1, if available: handy to discard noise.
    confidence: float | None = None
    #: Length of the transcribed audio, in seconds.
    duration: float = 0.0
    meta: dict = field(default_factory=dict)

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


class STTEngine(ABC):
    """Minimal contract every recognition backend must follow."""

    #: Short name of the engine, exposed via /api/health.
    name: str = "stt"

    @abstractmethod
    def transcribe(
        self,
        samples: np.ndarray,
        sample_rate: int = SAMPLE_RATE,
        language: str | None = None,
    ) -> Transcript:
        """Transcribes mono float32 audio in -1..1.

        It's called inside a thread pool, so it may block.
        """

    def prepare(self) -> None:
        """Loads (and downloads, the first time) what's needed, before the first sentence.

        Blocking: call it in a thread. Engines without a model do nothing.
        """

    def close(self) -> None:
        """Releases any resources (loaded models, HTTP clients, ...)."""


def to_pcm16(samples: np.ndarray) -> bytes:
    """float32 -1..1 -> 16-bit little-endian PCM, the format servers want."""
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def from_pcm16(raw: bytes) -> np.ndarray:
    """16-bit little-endian PCM -> float32 -1..1 (what comes from the browser)."""
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
