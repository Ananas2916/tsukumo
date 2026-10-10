"""Speech-recognition engines running behind an HTTP server.

Two variants, same shape: a WAV goes up and text comes back.

* ``WhisperCppSTT`` talks to a local ``whisper.cpp`` server — handy for
  whoever already has one, maybe compiled with acceleration.
* ``WhisperAPISTT`` talks to any OpenAI-compatible endpoint
  (``POST /audio/transcriptions``): the official API, Groq, or a proxy.

Both are synchronous clients, because they're called inside a thread pool.
"""

from __future__ import annotations

import logging

import httpx
import numpy as np

from ..audio import encode_wav
from .base import SAMPLE_RATE, STTEngine, Transcript

logger = logging.getLogger(__name__)


class WhisperCppSTT(STTEngine):
    """Client for a whisper.cpp server that's already running."""

    name = "whisper_cpp"

    def __init__(self, base_url: str = "http://127.0.0.1:8080", timeout: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout)

    def transcribe(
        self,
        samples: np.ndarray,
        sample_rate: int = SAMPLE_RATE,
        language: str | None = None,
    ) -> Transcript:
        duration = len(samples) / float(sample_rate or SAMPLE_RATE)
        if duration < 0.2:
            return Transcript(text="", duration=duration, meta={"engine": self.name})

        wav = encode_wav(samples, sample_rate)
        data = {"response_format": "json"}
        if language:
            data["language"] = language

        response = self._client.post(
            f"{self.base_url}/inference",
            files={"file": ("speech.wav", wav, "audio/wav")},
            data=data,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"whisper.cpp answered {response.status_code}: {response.text[:300]}"
            )

        payload = response.json()
        return Transcript(
            text=str(payload.get("text", "")).strip(),
            language=language,
            duration=duration,
            meta={"engine": self.name},
        )

    def close(self) -> None:
        self._client.close()


class WhisperAPISTT(STTEngine):
    """Client for an OpenAI-compatible transcription endpoint."""

    name = "openai_whisper_api"

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.openai.com/v1",
        model: str = "whisper-1",
        timeout: float = 60.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._client = httpx.Client(
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    def transcribe(
        self,
        samples: np.ndarray,
        sample_rate: int = SAMPLE_RATE,
        language: str | None = None,
    ) -> Transcript:
        duration = len(samples) / float(sample_rate or SAMPLE_RATE)
        if duration < 0.2:
            return Transcript(text="", duration=duration, meta={"engine": self.name})

        wav = encode_wav(samples, sample_rate)
        data = {"model": self.model}
        if language:
            data["language"] = language

        response = self._client.post(
            f"{self.base_url}/audio/transcriptions",
            files={"file": ("speech.wav", wav, "audio/wav")},
            data=data,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"The transcription service answered {response.status_code}: "
                f"{response.text[:300]}"
            )

        payload = response.json()
        return Transcript(
            text=str(payload.get("text", "")).strip(),
            language=payload.get("language") or language,
            duration=duration,
            meta={"engine": self.name, "model": self.model},
        )

    def close(self) -> None:
        self._client.close()
