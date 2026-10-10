"""Adapter for a Kokoro-FastAPI server that's already running.

Handy if you already have the ``Kokoro-FastAPI`` project running (in Docker
with GPU acceleration too): Tsukumo talks to it through the
OpenAI-compatible ``POST /v1/audio/speech`` endpoint and gets a WAV back.

Turn it on with ``DC_TTS_ENGINE=kokoro_http`` (and ``DC_KOKORO_HTTP_URL`` if
the server isn't on http://127.0.0.1:8880).
"""

from __future__ import annotations

import logging

import httpx
import numpy as np

from ..audio import decode_wav
from .base import Speech, TTSEngine

logger = logging.getLogger(__name__)


class KokoroHTTPTTS(TTSEngine):
    """Synchronous client (it's called inside a thread pool) for Kokoro-FastAPI."""

    name = "kokoro_http"

    def __init__(
        self,
        base_url: str,
        default_voice: str = "af_heart",
        default_speed: float = 1.0,
        language: str = "en-us",
        timeout: float = 60.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.default_voice = default_voice
        self.default_speed = default_speed
        self.language = language
        self._client = httpx.Client(timeout=timeout)
        self._voices_cache: list[str] | None = None
        # Immediate check: better to fail at startup than at the first sentence.
        self._client.get(f"{self.base_url}/v1/audio/voices").raise_for_status()
        logger.info("Kokoro-FastAPI reachable at %s", self.base_url)

    # ------------------------------------------------------------------
    def voices(self) -> list[str]:
        if self._voices_cache is None:
            try:
                response = self._client.get(f"{self.base_url}/v1/audio/voices")
                response.raise_for_status()
                payload = response.json()
                raw = payload.get("voices", payload) if isinstance(payload, dict) else payload
                self._voices_cache = sorted(str(v) for v in raw)
            except Exception as exc:  # pragma: no cover - depends on the server
                logger.warning("Voice list unavailable: %s", exc)
                self._voices_cache = [self.default_voice]
        return list(self._voices_cache)

    # ------------------------------------------------------------------
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        clean = (text or "").strip()
        if not clean:
            return Speech(
                samples=np.zeros(0, dtype=np.float32),
                sample_rate=24000,
                text="",
                meta={"engine": self.name},
            )

        chosen_voice = voice or self.default_voice
        chosen_speed = float(speed if speed is not None else self.default_speed)

        response = self._client.post(
            f"{self.base_url}/v1/audio/speech",
            json={
                "model": "kokoro",
                "input": clean,
                "voice": chosen_voice,
                "speed": chosen_speed,
                "response_format": "wav",
            },
        )
        response.raise_for_status()
        samples, sample_rate = decode_wav(response.content)

        return Speech(
            samples=samples,
            sample_rate=sample_rate,
            text=clean,
            phonemes=None,  # the server doesn't expose the IPA: we use the internal G2P
            meta={"engine": self.name, "voice": chosen_voice, "speed": chosen_speed},
        )

    # ------------------------------------------------------------------
    def close(self) -> None:
        self._client.close()
