"""Voci in rete con una chiave API: OpenAI, Azure, Google Cloud, Cartesia.

Stesso schema per tutti: si chiede audio **PCM grezzo** (o un WAV, che la
libreria standard sa leggere) perche' il progetto non ha un decoder MP3, e la
verifica del pannello fa una chiamata leggera che dice subito se la chiave e'
buona, prima di sentire la prima frase fallire.

ElevenLabs sta nel suo modulo perche' fa di piu' (tempi per lettera, quota).
"""

from __future__ import annotations

import base64
import io
import logging
import wave
from typing import Any
from xml.sax.saxutils import escape

import httpx
import numpy as np

from .base import Speech, TTSEngine, VoiceInfo, locale_language, pcm16_to_float, silence

logger = logging.getLogger(__name__)

_RATE = 24000


def _status_error(service: str, response: httpx.Response) -> RuntimeError:
    known = {
        400: "richiesta rifiutata",
        401: "chiave API non valida",
        402: "credito esaurito",
        403: "chiave senza permessi per questo servizio",
        404: "voce o modello inesistente",
        429: "troppe richieste o quota esaurita",
    }
    reason = known.get(response.status_code, f"errore {response.status_code}")
    body = response.text.strip().replace("\n", " ")[:240]
    return RuntimeError(f"{service}: {reason}" + (f" — {body}" if body else ""))


def _network_error(service: str, exc: Exception) -> str:
    return f"{service} non raggiungibile: {str(exc) or type(exc).__name__}"


def _wav_to_float(data: bytes) -> tuple[np.ndarray, int]:
    """WAV PCM 16 bit (quello di Google con LINEAR16) in float32 mono."""
    with wave.open(io.BytesIO(data)) as reader:
        rate = reader.getframerate()
        channels = reader.getnchannels()
        frames = reader.readframes(reader.getnframes())
    samples = pcm16_to_float(frames)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


# ---------------------------------------------------------------------------
# OpenAI (e qualunque server /v1/audio/speech)
# ---------------------------------------------------------------------------
OPENAI_VOICES = (
    "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
    "marin", "nova", "onyx", "sage", "shimmer", "verse",
)


class OpenAITTS(TTSEngine):
    """``POST /audio/speech`` con ``response_format=pcm`` (24 kHz, 16 bit, mono)."""

    name = "openai_tts"

    def __init__(
        self,
        api_key: str,
        voice: str = "coral",
        model: str = "gpt-4o-mini-tts",
        instructions: str = "",
        base_url: str = "https://api.openai.com/v1",
        default_speed: float = 1.0,
        timeout: float = 60.0,
    ) -> None:
        self.default_voice = voice
        self.model = model
        self.instructions = instructions.strip()
        self.base_url = base_url.rstrip("/")
        self.default_speed = default_speed
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = httpx.Client(timeout=timeout, headers=headers)
        self._voices: list[str] | None = None

    @property
    def _official(self) -> bool:
        return "api.openai.com" in self.base_url

    def voices(self) -> list[str]:
        if self._voices is None:
            self._voices = list(OPENAI_VOICES)
            if not self._official:
                # Un server compatibile (Kokoro-FastAPI, openedai-speech...) ha
                # le sue voci: se sa elencarle, meglio quelle.
                try:
                    response = self._client.get(f"{self.base_url}/audio/voices", timeout=5.0)
                    if response.status_code < 400:
                        payload = response.json()
                        raw = payload.get("voices", payload) if isinstance(payload, dict) else payload
                        found = [str(v.get("id", v)) if isinstance(v, dict) else str(v) for v in raw]
                        self._voices = found or self._voices
                except (httpx.HTTPError, ValueError):
                    pass
        return list(self._voices)

    def language_of(self, voice: str | None) -> str | None:
        # Le voci OpenAI parlano la lingua del testo; quelle di un server
        # compatibile potrebbero essere voci Kokoro, che invece ne hanno una.
        return None if self._official else super().language_of(voice)

    def check(self) -> dict[str, Any]:
        if not self._official:
            return {"ok": True, "detail": f"{len(self.voices())} voci sul server"}
        try:
            response = self._client.get(f"{self.base_url}/models", timeout=10.0)
        except httpx.HTTPError as exc:
            return {"ok": False, "detail": _network_error("OpenAI", exc)}
        if response.status_code >= 400:
            return {"ok": False, "detail": str(_status_error("OpenAI", response))}
        return {"ok": True, "detail": "Chiave valida", "voices": [VoiceInfo(id=v).as_dict() for v in self.voices()]}

    def synthesize(self, text: str, voice: str | None = None, speed: float | None = None) -> Speech:
        clean = (text or "").strip()
        if not clean:
            return silence(_RATE, self.name)
        chosen = voice or self.default_voice
        body: dict[str, Any] = {
            "model": self.model,
            "input": clean,
            "voice": chosen,
            "response_format": "pcm",
            "speed": float(speed if speed is not None else self.default_speed),
        }
        if self.instructions and "tts-1" not in self.model:
            body["instructions"] = self.instructions
        try:
            response = self._client.post(f"{self.base_url}/audio/speech", json=body)
        except httpx.HTTPError as exc:
            raise RuntimeError(_network_error("OpenAI TTS", exc)) from exc
        if response.status_code >= 400:
            raise _status_error("OpenAI TTS", response)
        return Speech(
            samples=pcm16_to_float(response.content),
            sample_rate=_RATE,
            text=clean,
            meta={"engine": self.name, "voice": chosen},
        )

    def close(self) -> None:
        self._client.close()


# ---------------------------------------------------------------------------
# Azure Speech
# ---------------------------------------------------------------------------
class AzureTTS(TTSEngine):
    """REST di Azure Speech con SSML e ``raw-24khz-16bit-mono-pcm``."""

    name = "azure"

    def __init__(
        self,
        api_key: str,
        region: str = "westeurope",
        voice: str = "it-IT-IsabellaMultilingualNeural",
        default_speed: float = 1.0,
        timeout: float = 30.0,
    ) -> None:
        self.region = (region or "westeurope").strip()
        self.default_voice = voice
        self.default_speed = default_speed
        self.base_url = f"https://{self.region}.tts.speech.microsoft.com/cognitiveservices"
        self._client = httpx.Client(
            timeout=timeout,
            headers={"Ocp-Apim-Subscription-Key": api_key, "User-Agent": "tsukumo"},
        )
        self._catalog: list[VoiceInfo] | None = None
        self._error: str | None = None

    def voice_catalog(self) -> list[VoiceInfo]:
        if self._catalog is None:
            try:
                response = self._client.get(f"{self.base_url}/voices/list", timeout=10.0)
                if response.status_code >= 400:
                    raise _status_error("Azure", response)
                self._catalog = [
                    VoiceInfo(
                        id=v["ShortName"],
                        name=f"{v.get('LocalName') or v.get('DisplayName')} · {v.get('LocaleName', v.get('Locale', ''))}",
                        language="" if "Multilingual" in v["ShortName"] else locale_language(v["ShortName"]),
                        gender=str(v.get("Gender", "")).lower(),
                        description=str(v.get("VoiceType", "")),
                    )
                    for v in response.json()
                    if v.get("ShortName")
                ]
                self._error = None
            except (httpx.HTTPError, RuntimeError, ValueError) as exc:
                self._error = str(exc) if isinstance(exc, RuntimeError) else _network_error("Azure", exc)
                logger.warning("Voci Azure non disponibili: %s", self._error)
                return [VoiceInfo(id=self.default_voice, language=locale_language(self.default_voice))]
        return list(self._catalog)

    def voices(self) -> list[str]:
        return [voice.id for voice in self.voice_catalog()]

    def language_of(self, voice: str | None) -> str | None:
        voice = voice or self.default_voice
        return None if "Multilingual" in voice else (locale_language(voice) or None)

    def check(self) -> dict[str, Any]:
        self._catalog = None
        catalog = self.voice_catalog()
        if self._error:
            return {"ok": False, "detail": self._error}
        return {
            "ok": True,
            "detail": f"{len(catalog)} voci nell'area {self.region}",
            "voices": [voice.as_dict() for voice in catalog],
        }

    def synthesize(self, text: str, voice: str | None = None, speed: float | None = None) -> Speech:
        clean = (text or "").strip()
        if not clean:
            return silence(_RATE, self.name)
        chosen = voice or self.default_voice
        rate = float(speed if speed is not None else self.default_speed)
        locale = "-".join(chosen.split("-")[:2]) or "it-IT"
        ssml = (
            f"<speak version='1.0' xml:lang='{locale}'><voice name='{escape(chosen)}'>"
            f"<prosody rate='{int(round((rate - 1) * 100)):+d}%'>{escape(clean)}</prosody>"
            "</voice></speak>"
        )
        try:
            response = self._client.post(
                f"{self.base_url}/v1",
                content=ssml.encode("utf-8"),
                headers={
                    "Content-Type": "application/ssml+xml",
                    "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
                },
            )
        except httpx.HTTPError as exc:
            raise RuntimeError(_network_error("Azure", exc)) from exc
        if response.status_code >= 400:
            raise _status_error("Azure", response)
        return Speech(
            samples=pcm16_to_float(response.content),
            sample_rate=_RATE,
            text=clean,
            meta={"engine": self.name, "voice": chosen, "speed": rate},
        )

    def close(self) -> None:
        self._client.close()


# ---------------------------------------------------------------------------
# Google Cloud Text-to-Speech
# ---------------------------------------------------------------------------
class GoogleTTS(TTSEngine):
    """``text:synthesize`` con ``LINEAR16`` (un WAV) e chiave API."""

    name = "google_tts"
    base_url = "https://texttospeech.googleapis.com/v1"

    def __init__(
        self,
        api_key: str,
        voice: str = "it-IT-Chirp3-HD-Aoede",
        default_speed: float = 1.0,
        timeout: float = 30.0,
    ) -> None:
        self.api_key = api_key
        self.default_voice = voice
        self.default_speed = default_speed
        self._client = httpx.Client(timeout=timeout)
        self._catalog: list[VoiceInfo] | None = None
        self._error: str | None = None

    def voice_catalog(self) -> list[VoiceInfo]:
        if self._catalog is None:
            try:
                response = self._client.get(f"{self.base_url}/voices", params={"key": self.api_key}, timeout=10.0)
                if response.status_code >= 400:
                    raise _status_error("Google", response)
                self._catalog = sorted(
                    (
                        VoiceInfo(
                            id=v["name"],
                            name=v["name"],
                            language=locale_language(v["name"]),
                            gender=str(v.get("ssmlGender", "")).lower().replace("neutral", ""),
                        )
                        for v in response.json().get("voices", [])
                        if v.get("name")
                    ),
                    key=lambda v: v.id,
                )
                self._error = None
            except (httpx.HTTPError, RuntimeError, ValueError) as exc:
                self._error = str(exc) if isinstance(exc, RuntimeError) else _network_error("Google", exc)
                logger.warning("Voci Google non disponibili: %s", self._error)
                return [VoiceInfo(id=self.default_voice, language=locale_language(self.default_voice))]
        return list(self._catalog)

    def voices(self) -> list[str]:
        return [voice.id for voice in self.voice_catalog()]

    def check(self) -> dict[str, Any]:
        self._catalog = None
        catalog = self.voice_catalog()
        if self._error:
            return {"ok": False, "detail": self._error}
        return {"ok": True, "detail": f"{len(catalog)} voci", "voices": [voice.as_dict() for voice in catalog]}

    def synthesize(self, text: str, voice: str | None = None, speed: float | None = None) -> Speech:
        clean = (text or "").strip()
        if not clean:
            return silence(_RATE, self.name)
        chosen = voice or self.default_voice
        rate = float(speed if speed is not None else self.default_speed)
        audio: dict[str, Any] = {"audioEncoding": "LINEAR16", "sampleRateHertz": _RATE}
        if abs(rate - 1.0) > 0.01:
            audio["speakingRate"] = rate
        body = {
            "input": {"text": clean},
            "voice": {"languageCode": "-".join(chosen.split("-")[:2]), "name": chosen},
            "audioConfig": audio,
        }
        try:
            response = self._client.post(f"{self.base_url}/text:synthesize", params={"key": self.api_key}, json=body)
        except httpx.HTTPError as exc:
            raise RuntimeError(_network_error("Google TTS", exc)) from exc
        if response.status_code >= 400:
            raise _status_error("Google TTS", response)
        samples, sample_rate = _wav_to_float(base64.b64decode(response.json().get("audioContent", "")))
        return Speech(samples=samples, sample_rate=sample_rate, text=clean, meta={"engine": self.name, "voice": chosen})

    def close(self) -> None:
        self._client.close()


# ---------------------------------------------------------------------------
# Cartesia
# ---------------------------------------------------------------------------
class CartesiaTTS(TTSEngine):
    """``/tts/bytes`` con contenitore ``raw`` e ``pcm_s16le``."""

    name = "cartesia"
    base_url = "https://api.cartesia.ai"
    api_version = "2025-04-16"

    def __init__(
        self,
        api_key: str,
        voice: str = "",
        model: str = "sonic-2",
        language: str = "it",
        timeout: float = 30.0,
    ) -> None:
        self.default_voice = voice
        self.model = model or "sonic-2"
        self.language = (language or "").strip().lower()
        self._client = httpx.Client(
            timeout=timeout,
            headers={
                "X-API-Key": api_key,
                "Authorization": f"Bearer {api_key}",
                "Cartesia-Version": self.api_version,
            },
        )
        self._catalog: list[VoiceInfo] | None = None
        self._error: str | None = None

    def voice_catalog(self) -> list[VoiceInfo]:
        if self._catalog is None:
            try:
                response = self._client.get(f"{self.base_url}/voices", params={"limit": 100}, timeout=10.0)
                if response.status_code >= 400:
                    raise _status_error("Cartesia", response)
                payload = response.json()
                raw = payload.get("data", []) if isinstance(payload, dict) else payload
                self._catalog = [
                    VoiceInfo(
                        id=str(v.get("id")),
                        name=str(v.get("name") or v.get("id")),
                        language=str(v.get("language") or "")[:2],
                        gender=str(v.get("gender") or "").lower().replace("masculine", "male").replace("feminine", "female"),
                        description=str(v.get("description") or "")[:120],
                    )
                    for v in raw
                    if v.get("id")
                ]
                self._catalog.sort(key=lambda v: (v.language != self.language, v.name.lower()))
                self._error = None
            except (httpx.HTTPError, RuntimeError, ValueError) as exc:
                self._error = str(exc) if isinstance(exc, RuntimeError) else _network_error("Cartesia", exc)
                logger.warning("Voci Cartesia non disponibili: %s", self._error)
                return [VoiceInfo(id=self.default_voice)] if self.default_voice else []
        return list(self._catalog)

    def voices(self) -> list[str]:
        return [voice.id for voice in self.voice_catalog()] or ([self.default_voice] if self.default_voice else [])

    def language_of(self, voice: str | None) -> str | None:
        return self.language or None

    def check(self) -> dict[str, Any]:
        self._catalog = None
        catalog = self.voice_catalog()
        if self._error:
            return {"ok": False, "detail": self._error}
        return {"ok": True, "detail": f"{len(catalog)} voci", "voices": [voice.as_dict() for voice in catalog]}

    def synthesize(self, text: str, voice: str | None = None, speed: float | None = None) -> Speech:
        clean = (text or "").strip()
        if not clean:
            return silence(_RATE, self.name)
        chosen = voice or self.default_voice
        if not chosen:
            raise RuntimeError("Cartesia: scegli una voce nel pannello (premi Verifica per l'elenco)")
        body: dict[str, Any] = {
            "model_id": self.model,
            "transcript": clean,
            "voice": {"mode": "id", "id": chosen},
            "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": _RATE},
        }
        if self.language:
            body["language"] = self.language
        try:
            response = self._client.post(f"{self.base_url}/tts/bytes", json=body)
        except httpx.HTTPError as exc:
            raise RuntimeError(_network_error("Cartesia", exc)) from exc
        if response.status_code >= 400:
            raise _status_error("Cartesia", response)
        return Speech(
            samples=pcm16_to_float(response.content),
            sample_rate=_RATE,
            text=clean,
            meta={"engine": self.name, "voice": chosen},
        )

    def close(self) -> None:
        self._client.close()
