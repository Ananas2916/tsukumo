"""Live words while you talk: ``voice_partial`` -> ``transcript_partial`` to the speaker only."""

from __future__ import annotations

import base64

import numpy as np
import pytest

from backend import server
from backend.stt.base import STTEngine, Transcript
from backend.stt.parakeet_engine import ParakeetSTT


class Ear(STTEngine):
    name = "ear"

    def __init__(self, live: bool, text: str = "ciao come") -> None:
        self.live = live
        self.text = text
        self.calls = 0

    def transcribe(self, samples, sample_rate=16000, language=None):
        self.calls += 1
        return Transcript(text=self.text, duration=len(samples) / sample_rate)


def pcm(seconds: float) -> str:
    samples = (np.sin(np.arange(int(16000 * seconds)) / 9) * 8000).astype("<i2")
    return base64.b64encode(samples.tobytes()).decode()


def partial(client, audio: str, sentence: int = 7) -> dict:
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_json({"type": "voice_partial", "audio": audio, "sentence": sentence})
        while True:
            message = ws.receive_json()
            if message["type"] == "transcript_partial":
                return message


def test_only_parakeet_is_live():
    assert ParakeetSTT.live is True
    assert STTEngine.live is False


def test_live_engine_sends_the_words_back(client, monkeypatch):
    ear = Ear(live=True)
    monkeypatch.setattr(server.app.state.companion, "stt", ear)
    message = partial(client, pcm(1.0))
    assert message == {"type": "transcript_partial", "sentence": 7, "live": True, "text": "ciao come"}
    assert ear.calls == 1
    # A preview: it never lands in the transcript a reconnecting client catches up on.
    assert all("ciao come" not in line.get("text", "") for line in server.hub.transcript.recent())


@pytest.mark.parametrize("engine", [Ear(live=False), None])
def test_slow_or_missing_engine_says_not_live(client, monkeypatch, engine):
    monkeypatch.setattr(server.app.state.companion, "stt", engine)
    message = partial(client, pcm(1.0), sentence=2)
    assert message["live"] is False and message["sentence"] == 2
    assert engine is None or engine.calls == 0


def test_long_sentences_stop_the_live_words(client, monkeypatch):
    ear = Ear(live=True)
    monkeypatch.setattr(server.app.state.companion, "stt", ear)
    message = partial(client, pcm(17.0))
    assert message["live"] is True and message["text"] == ""
    assert ear.calls == 0
    assert not server.PARTIAL_CLIENTS
