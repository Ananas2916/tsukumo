"""VoiceStudio engine: the server's real replies, sent back by a MockTransport."""

from __future__ import annotations

import io
import json
import wave

import httpx
import numpy as np
import pytest

from backend.providers import TTS_REGISTRY
from backend.tts.voicestudio import VoiceStudioTTS

# GET /v1/audio/voices from VoiceStudio 0.5.6, trimmed to two aliases.
VOICES = {
    "voices": [
        {"voice_id": "alloy", "name": "Alloy", "type": "openai_alias", "description": "..."},
        {"voice_id": "coral", "name": "Coral", "type": "openai_alias", "description": "..."},
        {"voice_id": "ead845a6", "name": "C.", "type": "profile", "language": "English"},
        {"voice_id": "demo0001", "name": "VoiceStudio Demo Voice", "type": "profile", "language": "English"},
    ],
    "engines": [{"id": "omnivoice", "available": True}],
}

# A 59 s reference with no speech-to-text model installed in VoiceStudio.
NO_ASR = {
    "error": {
        "message": "Automatic reference transcription needs an installed speech-to-text model. "
        "Provide a matching reference transcript, or install and select a speech-to-text "
        "model in Model Catalogue, then try again.",
        "type": "server_error",
        "param": None,
        "code": None,
    }
}


def _wav(seconds: float = 0.1, rate: int = 24000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(np.zeros(int(seconds * rate), dtype="<i2").tobytes())
    return buffer.getvalue()


def _server(sent: list[dict], speech: httpx.Response | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/audio/voices":
            return httpx.Response(200, json=VOICES)
        if request.url.path == "/v1/audio/speech":
            sent.append(json.loads(request.content))
            return speech or httpx.Response(200, content=_wav(), headers={"content-type": "audio/wav"})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def test_lists_only_the_users_profiles() -> None:
    engine = VoiceStudioTTS(transport=_server([]))
    catalog = engine.voice_catalog()
    assert [voice.id for voice in catalog] == ["ead845a6", "demo0001"]
    assert catalog[0].name == "C."
    # The profile's language is the reference clip's: the voice is multilingual.
    assert catalog[0].language == ""
    assert engine.default_voice == "ead845a6"
    assert engine.language_of("ead845a6") is None


def test_sends_the_profile_and_reads_the_wav() -> None:
    sent: list[dict] = []
    engine = VoiceStudioTTS(voice="demo0001", transport=_server(sent))
    speech = engine.synthesize("Ciao, sono Tsukumo.", speed=1.1)
    assert speech.sample_rate == 24000
    assert speech.duration == pytest.approx(0.1)
    assert sent == [
        {"model": "tts-1", "input": "Ciao, sono Tsukumo.", "voice": "demo0001", "response_format": "wav", "speed": 1.1}
    ]


def test_a_fixed_language_is_sent_and_pins_the_reply() -> None:
    sent: list[dict] = []
    engine = VoiceStudioTTS(language="Italian", transport=_server(sent))
    engine.synthesize("Ciao.")
    assert sent[0]["language"] == "it"
    assert engine.language_of("ead845a6") == "it"


def test_the_servers_own_reason_reaches_the_panel() -> None:
    engine = VoiceStudioTTS(transport=_server([], httpx.Response(500, json=NO_ASR)))
    with pytest.raises(RuntimeError, match="speech-to-text model"):
        engine.synthesize("Ciao.")


def test_app_closed_fails_at_startup_but_not_the_voice_list() -> None:
    def closed(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(RuntimeError, match="is the app open"):
        VoiceStudioTTS(transport=httpx.MockTransport(closed))

    engine = VoiceStudioTTS(transport=_server([]))
    engine._client._transport = httpx.MockTransport(closed)
    assert engine.check()["ok"] is False
    assert engine.voices() == ["ead845a6", "demo0001"]


def test_registered_as_a_local_engine() -> None:
    spec = TTS_REGISTRY.get("voicestudio")
    assert spec is not None and spec.local
    assert TTS_REGISTRY.resolve("omnivoice") == "voicestudio"
