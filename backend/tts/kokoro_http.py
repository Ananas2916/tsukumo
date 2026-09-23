"""Adapter verso un server Kokoro-FastAPI gia' in esecuzione.

Utile se hai gia' il progetto ``Kokoro-FastAPI`` avviato (anche in Docker con
accelerazione GPU): il Desk Companion gli parla via l'endpoint
OpenAI-compatible ``POST /v1/audio/speech`` e riceve un WAV.

Attivalo con ``DC_TTS_ENGINE=kokoro_http`` (e ``DC_KOKORO_HTTP_URL`` se il
server non e' su http://127.0.0.1:8880).
"""

from __future__ import annotations

import logging

import httpx
import numpy as np

from ..audio import decode_wav
from .base import Speech, TTSEngine

logger = logging.getLogger(__name__)


class KokoroHTTPTTS(TTSEngine):
    """Client sincrono (viene chiamato dentro un thread pool) per Kokoro-FastAPI."""

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
        # Verifica immediata: meglio fallire all'avvio che alla prima frase.
        self._client.get(f"{self.base_url}/v1/audio/voices").raise_for_status()
        logger.info("Kokoro-FastAPI raggiungibile su %s", self.base_url)

    # ------------------------------------------------------------------
    def voices(self) -> list[str]:
        if self._voices_cache is None:
            try:
                response = self._client.get(f"{self.base_url}/v1/audio/voices")
                response.raise_for_status()
                payload = response.json()
                raw = payload.get("voices", payload) if isinstance(payload, dict) else payload
                self._voices_cache = sorted(str(v) for v in raw)
            except Exception as exc:  # pragma: no cover - dipende dal server
                logger.warning("Elenco voci non disponibile: %s", exc)
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
            phonemes=None,  # il server non espone l'IPA: usiamo il G2P interno
            meta={"engine": self.name, "voice": chosen_voice, "speed": chosen_speed},
        )

    # ------------------------------------------------------------------
    def close(self) -> None:
        self._client.close()
