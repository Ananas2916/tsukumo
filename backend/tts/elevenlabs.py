"""Sintesi tramite l'API di ElevenLabs.

Chiediamo deliberatamente ``output_format=pcm_24000``: ElevenLabs di default
restituisce MP3, e il progetto non ha un decoder audio. Il PCM grezzo a 16 bit
si converte in float32 con due righe di numpy, quindi questo motore non porta
alcuna dipendenza in piu' oltre ad ``httpx``, che c'e' gia'.
"""

from __future__ import annotations

import logging

import httpx
import numpy as np

from .base import Speech, TTSEngine

logger = logging.getLogger(__name__)

_SAMPLE_RATE = 24000
_BASE_URL = "https://api.elevenlabs.io/v1"


class ElevenLabsTTS(TTSEngine):
    """Client per le voci di ElevenLabs."""

    name = "elevenlabs"

    def __init__(
        self,
        api_key: str,
        default_voice: str = "Rachel",
        model: str = "eleven_multilingual_v2",
        default_speed: float = 1.0,
        timeout: float = 60.0,
    ) -> None:
        self.default_voice = default_voice
        self.model = model
        self.default_speed = default_speed
        self._client = httpx.Client(
            timeout=timeout,
            headers={"xi-api-key": api_key, "accept": "audio/pcm"},
        )
        self._voices: dict[str, str] | None = None

    # ------------------------------------------------------------------
    def _voice_map(self) -> dict[str, str]:
        """Nome leggibile -> id, perche' l'API accetta solo l'id."""
        if self._voices is None:
            try:
                response = self._client.get(f"{_BASE_URL}/voices", timeout=10.0)
                response.raise_for_status()
                self._voices = {
                    v["name"]: v["voice_id"] for v in response.json().get("voices", [])
                }
            except Exception as exc:
                logger.warning("Elenco voci ElevenLabs non disponibile: %s", exc)
                self._voices = {}
        return self._voices

    def voices(self) -> list[str]:
        return sorted(self._voice_map()) or [self.default_voice]

    # ------------------------------------------------------------------
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        clean = (text or "").strip()
        chosen = voice or self.default_voice
        chosen_speed = float(speed if speed is not None else self.default_speed)

        if not clean:
            return Speech(
                samples=np.zeros(0, dtype=np.float32),
                sample_rate=_SAMPLE_RATE,
                text="",
                meta={"engine": self.name},
            )

        # Se e' gia' un id lo usiamo com'e', altrimenti lo cerchiamo per nome.
        voice_id = self._voice_map().get(chosen, chosen)

        response = self._client.post(
            f"{_BASE_URL}/text-to-speech/{voice_id}",
            params={"output_format": f"pcm_{_SAMPLE_RATE}"},
            json={
                "text": clean,
                "model_id": self.model,
                "voice_settings": {"speed": chosen_speed},
            },
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"ElevenLabs ha risposto {response.status_code}: "
                f"{response.text[:300]}"
            )

        pcm = np.frombuffer(response.content, dtype="<i2").astype(np.float32) / 32768.0

        return Speech(
            samples=np.ascontiguousarray(pcm),
            sample_rate=_SAMPLE_RATE,
            text=clean,
            meta={"engine": self.name, "voice": chosen, "speed": chosen_speed},
        )

    # ------------------------------------------------------------------
    def close(self) -> None:
        self._client.close()
