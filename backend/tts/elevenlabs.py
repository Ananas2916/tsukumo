"""Synthesis through the ElevenLabs API.

Three choices that matter:

* ``output_format=pcm_24000``: by default ElevenLabs returns MP3 and the
  project has no audio decoder. Raw 16-bit PCM converts to float32 with one
  line of numpy.
* the ``with-timestamps`` endpoint: besides the audio it returns the start
  and end of every letter. That's what a lip-sync as precise as Kokoro's
  needs, instead of the alignment estimated on the energy. If the chosen
  model doesn't support it, it falls back to the plain endpoint.
* the check reads ``/user/subscription``: it's a pay-per-use service, and the
  panel shows how many characters are left in the month before they run out.
"""

from __future__ import annotations

import base64
import logging
import time
from typing import Any

import httpx

from ..phonemes import phones_for_letters
from .base import Speech, TTSEngine, VoiceInfo, pcm16_to_float, silence

logger = logging.getLogger(__name__)

_SAMPLE_RATE = 24000
_BASE_URL = "https://api.elevenlabs.io/v1"
#: Only these models accept ``language_code``: for the others it must be removed or they answer 400.
_LANGUAGE_MODELS = {"eleven_flash_v2_5", "eleven_turbo_v2_5"}
#: Speed range accepted by the API.
_SPEED_RANGE = (0.7, 1.2)


class ElevenLabsTTS(TTSEngine):
    """Client for the ElevenLabs voices."""

    name = "elevenlabs"

    def __init__(
        self,
        api_key: str,
        default_voice: str = "Rachel",
        model: str = "eleven_flash_v2_5",
        default_speed: float = 1.0,
        stability: float = 0.5,
        similarity: float = 0.75,
        style: float = 0.0,
        language: str = "",
        timeout: float = 60.0,
        base_url: str = _BASE_URL,
    ) -> None:
        self.default_voice = default_voice
        self.model = model
        self.default_speed = default_speed
        self.settings = {"stability": stability, "similarity_boost": similarity, "style": style}
        self.language = language.strip().lower()
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout, headers={"xi-api-key": api_key})
        self._catalog: list[VoiceInfo] | None = None
        self._catalog_error: str | None = None
        #: Becomes False at the first refusal of the endpoint with the timings.
        self._timestamps = True

    # ------------------------------------------------------------------ voices
    def voice_catalog(self) -> list[VoiceInfo]:
        if self._catalog is None:
            try:
                response = self._client.get(f"{self.base_url}/voices", timeout=10.0)
                response.raise_for_status()
                self._catalog = [_voice_info(v) for v in response.json().get("voices", [])]
                self._catalog.sort(key=lambda v: (v.language != (self.language or v.language), v.name.lower()))
                self._catalog_error = None
            except Exception as exc:
                self._catalog_error = _error_text(exc)
                logger.warning("ElevenLabs voice list unavailable: %s", self._catalog_error)
                return [VoiceInfo(id=self.default_voice)]
        return list(self._catalog)

    def voices(self) -> list[str]:
        return [voice.name or voice.id for voice in self.voice_catalog()] or [self.default_voice]

    def _voice_id(self, voice: str) -> str:
        """The API wants the id: the panel may save the name, for readability."""
        for info in self.voice_catalog():
            if voice in (info.id, info.name):
                return info.id
        return voice

    def language_of(self, voice: str | None) -> str | None:
        # ElevenLabs voices speak every language of the multilingual models: the
        # language is the one forced in the panel, if any.
        return self.language or None

    def resolve_voice(self, requested: str | None) -> str:
        if requested and any(requested in (v.id, v.name) for v in self.voice_catalog()):
            return requested
        return self.default_voice

    # -------------------------------------------------------------- check
    def check(self) -> dict[str, Any]:
        result: dict[str, Any] = {"ok": True}
        try:
            response = self._client.get(f"{self.base_url}/user/subscription", timeout=10.0)
        except httpx.HTTPError as exc:
            return {"ok": False, "detail": f"ElevenLabs unreachable: {_error_text(exc)}"}
        if response.status_code == 401:
            return {"ok": False, "detail": "Invalid API key"}
        if response.status_code < 400:
            data = response.json()
            used = int(data.get("character_count") or 0)
            limit = int(data.get("character_limit") or 0)
            reset = data.get("next_character_count_reset_unix")
            result["account"] = {
                "plan": data.get("tier") or "",
                "used": used,
                "limit": limit,
                "remaining": max(0, limit - used),
                "resetsAt": int(reset) if reset else None,
                "unit": "caratteri",
            }
        # A key with reduced permissions may not read the subscription (403) but
        # synthesize all the same: the voices show it.
        self._catalog = None
        catalog = self.voice_catalog()
        if self._catalog_error:
            return {"ok": False, "detail": self._catalog_error}
        result["detail"] = f"{len(catalog)} voices in your account"
        result["voices"] = [voice.as_dict() for voice in catalog]
        return result

    # ------------------------------------------------------------- synthesis
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        clean = (text or "").strip()
        if not clean:
            return silence(_SAMPLE_RATE, self.name)

        chosen = voice or self.default_voice
        chosen_speed = float(speed if speed is not None else self.default_speed)
        body: dict[str, Any] = {
            "text": clean,
            "model_id": self.model,
            "voice_settings": {
                **self.settings,
                "speed": min(_SPEED_RANGE[1], max(_SPEED_RANGE[0], chosen_speed)),
            },
        }
        if self.language and self.model in _LANGUAGE_MODELS:
            body["language_code"] = self.language

        voice_id = self._voice_id(chosen)
        started = time.perf_counter()
        timings = None
        if self._timestamps:
            response = self._post(f"/text-to-speech/{voice_id}/with-timestamps", body)
            if response.status_code < 400:
                payload = response.json()
                pcm = pcm16_to_float(base64.b64decode(payload.get("audio_base64") or ""))
                timings = _alignment_timings(payload.get("alignment") or payload.get("normalized_alignment"))
            elif response.status_code in (400, 404, 422):
                logger.warning(
                    "ElevenLabs gives no timings for %s (%s): using the plain endpoint",
                    self.model,
                    response.status_code,
                )
                self._timestamps = False
            else:
                _raise(response)
        if not self._timestamps:
            response = self._post(f"/text-to-speech/{voice_id}", body)
            if response.status_code >= 400:
                _raise(response)
            pcm = pcm16_to_float(response.content)

        return Speech(
            samples=pcm,
            sample_rate=_SAMPLE_RATE,
            text=clean,
            timings=timings or None,
            meta={
                "engine": self.name,
                "voice": chosen,
                "speed": chosen_speed,
                "latencyMs": int((time.perf_counter() - started) * 1000),
            },
        )

    def _post(self, path: str, body: dict[str, Any]) -> httpx.Response:
        return self._client.post(
            f"{self.base_url}{path}",
            params={"output_format": f"pcm_{_SAMPLE_RATE}"},
            json=body,
        )

    def close(self) -> None:
        self._client.close()


# ---------------------------------------------------------------------------
def _voice_info(voice: dict[str, Any]) -> VoiceInfo:
    labels = voice.get("labels") or {}
    language = str(labels.get("language") or "")
    fine = voice.get("fine_tuning") or {}
    if not language and isinstance(fine.get("language"), str):
        language = fine["language"]
    description = ", ".join(
        str(labels[key]) for key in ("accent", "age", "description", "use_case") if labels.get(key)
    )
    return VoiceInfo(
        id=str(voice.get("voice_id") or ""),
        name=str(voice.get("name") or ""),
        language=language.lower()[:2],
        gender=str(labels.get("gender") or "").lower(),
        description=description.replace("_", " "),
        preview=str(voice.get("preview_url") or ""),
    )


def _alignment_timings(alignment: dict[str, Any] | None):
    if not alignment:
        return None
    return phones_for_letters(
        alignment.get("characters") or [],
        alignment.get("character_start_times_seconds") or [],
        alignment.get("character_end_times_seconds") or [],
    )


def _error_text(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return _status_message(exc.response)
    return str(exc) or type(exc).__name__


def _status_message(response: httpx.Response) -> str:
    try:
        detail = response.json().get("detail")
        if isinstance(detail, dict):
            detail = detail.get("message") or detail.get("status")
    except ValueError:
        detail = response.text[:200]
    known = {401: "invalid API key", 402: "crediti esauriti", 429: "troppe richieste o quota finita"}
    reason = known.get(response.status_code) or f"error {response.status_code}"
    return f"ElevenLabs: {reason}" + (f" ({detail})" if detail else "")


def _raise(response: httpx.Response) -> None:
    raise RuntimeError(_status_message(response))
