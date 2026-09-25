"""Versetti: frasi nella lingua della voce, cache per voce, mai in conversazione."""

import random

import pytest

from backend import server
from backend.tts.base import VoiceInfo
from backend.vocals import EVENTS, LINES, language_key, vocal_line


def test_every_event_has_english_lines():
    for event in EVENTS:
        assert LINES[event]["en"], event


def test_language_codes_are_normalized():
    assert language_key("en-us") == "en"
    assert language_key("it-IT") == "it"
    assert language_key("pt_BR") == "pt"
    assert language_key("cmn") == "zh"
    assert language_key(None) == "en"


def test_lines_follow_the_voice_language():
    rng = random.Random(1)
    assert vocal_line("greet", "it", rng) in LINES["greet"]["it"]
    assert vocal_line("greet", "cmn", rng) in LINES["greet"]["zh"]
    # Lingua sconosciuta: inglese.
    assert vocal_line("poke", "xx", rng) in LINES["poke"]["en"]
    # Manca l'evento per la lingua: meglio un saluto nella lingua giusta.
    assert vocal_line("welcome", "hi", rng) in LINES["greet"]["hi"]
    with pytest.raises(KeyError):
        vocal_line("dance", "en")


def test_vocal_speaks_with_the_current_voice_and_is_cached(client, monkeypatch):
    instance = server.app.state.companion
    calls = []
    original = instance.tts.synthesize

    def counting(text, voice=None, speed=None):
        calls.append(text)
        return original(text, voice, speed)

    monkeypatch.setattr(instance.tts, "synthesize", counting)
    monkeypatch.setattr(instance, "_vocals", {})
    history = list(instance.history)

    first = client.post("/api/vocal", json={"event": "pat"}).json()
    assert first["ok"] is True
    speech = first["speech"]
    assert speech["type"] == "speech" and speech["vocal"] == "pat"
    assert speech["audio"] and speech["duration"] > 0
    assert speech["text"] in {line for lines in LINES["pat"].values() for line in lines}

    for _ in range(6):
        again = client.post("/api/vocal", json={"event": "pat"}).json()
        assert again["ok"] is True
    # Al massimo una sintesi per variante: le altre richieste vengono dalla cache.
    assert len(calls) == len(set(calls)) <= len(LINES["pat"]["en"])
    assert instance.history == history


def test_vocal_stays_quiet_when_muted_and_rejects_unknown_events(client, monkeypatch):
    instance = server.app.state.companion
    monkeypatch.setattr(instance, "muted", True)
    assert client.post("/api/vocal", json={"event": "greet"}).json() == {"ok": False, "reason": "busy"}
    assert client.post("/api/vocal", json={"event": "sing"}).status_code == 400


def test_without_a_chosen_voice_the_system_language_picks_it(client, monkeypatch):
    instance = server.app.state.companion
    catalog = [VoiceInfo(id="af_heart", language="en", gender="female"), VoiceInfo(id="if_sara", language="it", gender="female")]
    monkeypatch.setattr(instance.tts, "voice_catalog", lambda: catalog)
    monkeypatch.setattr(instance.tts, "default_voice", "af_heart", raising=False)
    monkeypatch.setattr(instance.settings, "system_language", "it")
    monkeypatch.setattr(instance, "voice", "af_heart")
    monkeypatch.setattr(instance, "voice_chosen", False)
    client.portal.call(instance.load_voices)
    assert instance.voice == "if_sara"
    # Una voce scelta dal pannello vince, anche se le voci si ricaricano dopo.
    instance.update_settings(voice="af_heart")
    client.portal.call(instance.load_voices)
    assert instance.voice == "af_heart"
