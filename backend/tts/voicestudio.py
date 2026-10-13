"""VoiceStudio: the voices you cloned or designed in that app, spoken by Tsukumo.

VoiceStudio (github.com/debpalash/VoiceStudio) runs a local server, on port
3900 by default, with an OpenAI-compatible ``/v1/audio/speech``. A voice
profile's id goes in ``voice`` and the server pulls in its reference audio
and transcript, so the cloning setup stays in VoiceStudio and Tsukumo only
has to name the profile.

Its engine (OmniVoice by default) speaks hundreds of languages with any
voice: a profile's language is the reference clip's, not a limit.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..audio import decode_wav
from ..languages import short_language
from .base import Speech, TTSEngine, VoiceInfo, silence

logger = logging.getLogger(__name__)

DEFAULT_URL = "http://127.0.0.1:3900"


def _error_message(response: httpx.Response) -> str:
    """The server's own explanation: it says what to fix inside VoiceStudio."""
    try:
        payload = response.json()
    except ValueError:
        return response.text.strip()[:240] or f"error {response.status_code}"
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    detail = payload.get("detail") if isinstance(payload, dict) else None
    return str(detail or payload)[:240]


class VoiceStudioTTS(TTSEngine):
    """Synchronous client (it's called inside a thread pool) for VoiceStudio."""

    name = "voicestudio"

    def __init__(
        self,
        base_url: str = DEFAULT_URL,
        voice: str = "",
        language: str = "auto",
        model: str = "tts-1",
        api_key: str = "",
        default_speed: float = 1.0,
        timeout: float = 120.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        # "auto" and empty mean the engine's language-agnostic mode.
        code = (language or "").strip().lower()
        self.language = "" if code in ("", "auto") else (short_language(code) or code)
        self.model = model or "tts-1"
        self.default_speed = default_speed
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        # The first sentence after a while loads the model again (VoiceStudio
        # unloads it when idle to free the GPU): seconds, not milliseconds.
        self._client = httpx.Client(timeout=timeout, headers=headers, transport=transport)
        # Better to fail at startup, and fall back with a reason, than at the
        # first sentence.
        catalog = self._catalog = self._fetch_catalog()
        self.default_voice = voice or (catalog[0].id if catalog else "default")
        logger.info("VoiceStudio reachable at %s, %d voices", self.base_url, len(catalog))

    # ------------------------------------------------------------------
    def _fetch_catalog(self) -> list[VoiceInfo]:
        try:
            response = self._client.get(f"{self.base_url}/v1/audio/voices", timeout=10.0)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"VoiceStudio unreachable at {self.base_url}: is the app open? ({exc})") from exc
        if response.status_code >= 400:
            raise RuntimeError(f"VoiceStudio: {_error_message(response)}")
        catalog = []
        for item in response.json().get("voices", []):
            # The OpenAI names only stand for the engine's default voice: the
            # user's own profiles are what this engine is for.
            if not isinstance(item, dict) or item.get("type") != "profile":
                continue
            reference = str(item.get("language") or "")
            catalog.append(
                VoiceInfo(
                    id=str(item["voice_id"]),
                    name=str(item.get("name") or item["voice_id"]),
                    description=f"Reference audio in {reference}" if reference else "",
                )
            )
        return catalog

    def voice_catalog(self) -> list[VoiceInfo]:
        # The list from startup (or the last Check): closing VoiceStudio later
        # must not break the panel, only the synthesis says so.
        return list(self._catalog)

    def voices(self) -> list[str]:
        return [voice.id for voice in self.voice_catalog()]

    def language_of(self, voice: str | None) -> str | None:
        # Every voice speaks every language; only a fixed language setting
        # pins what she answers in.
        return self.language or None

    def check(self) -> dict[str, Any]:
        try:
            catalog = self._catalog = self._fetch_catalog()
        except RuntimeError as exc:
            return {"ok": False, "detail": str(exc)}
        if not catalog:
            return {"ok": False, "detail": "No voices yet: create or clone one in VoiceStudio"}
        return {
            "ok": True,
            "detail": f"{len(catalog)} voices in VoiceStudio",
            "voices": [voice.as_dict() for voice in catalog],
        }

    # ------------------------------------------------------------------
    def synthesize(self, text: str, voice: str | None = None, speed: float | None = None) -> Speech:
        clean = (text or "").strip()
        if not clean:
            return silence(24000, self.name)
        chosen = voice or self.default_voice
        body: dict[str, Any] = {
            "model": self.model,
            "input": clean,
            "voice": chosen,
            # WAV carries its own sample rate, whatever engine VoiceStudio runs.
            "response_format": "wav",
            "speed": float(speed if speed is not None else self.default_speed),
        }
        if self.language:
            body["language"] = self.language
        try:
            response = self._client.post(f"{self.base_url}/v1/audio/speech", json=body)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"VoiceStudio unreachable: {str(exc) or type(exc).__name__}") from exc
        if response.status_code >= 400:
            raise RuntimeError(f"VoiceStudio: {_error_message(response)}")
        samples, sample_rate = decode_wav(response.content)
        return Speech(
            samples=samples,
            sample_rate=sample_rate,
            text=clean,
            meta={"engine": self.name, "voice": chosen, "language": self.language or "auto"},
        )

    # ------------------------------------------------------------------
    def close(self) -> None:
        self._client.close()
