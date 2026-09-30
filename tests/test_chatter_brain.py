"""Il cervello delle chiacchiere: notizie e curiosita' scritte da un modello a parte."""

import dataclasses
import random
from datetime import datetime

import pytest

from backend import proactive, server
from backend.config import Settings
from backend.context import PCContext
from backend.llm import FallbackLLM, OpenAICompatibleClient, create_chatter_llm
from backend.llm.base import LLMClient
from backend.news import Headline
from backend.pipeline import Companion
from backend.preferences import Preferences
from backend.proactive import Proactive

from helpers import Scripted


class Agent(Scripted):
    """Come Claude Code: tiene la sessione da se'."""

    stateful = True


class Broken(LLMClient):
    name = "broken"

    def __init__(self, after=()):
        self.after = after
        self.calls = 0

    async def stream(self, messages):
        self.calls += 1
        for piece in self.after:
            yield piece
        raise RuntimeError("429 rate-limited upstream")

    async def health(self):
        return {"ok": False}


class FakeNews:
    async def pick(self, language="it"):
        return Headline("Scoperto un nuovo pianeta", "Il Post")


def collect(stream):
    async def run():
        return [piece async for piece in stream]

    return run


@pytest.fixture
def rig(client, monkeypatch):
    """Claude Code come cervello principale, un modello finto per le chiacchiere."""
    instance = server.app.state.companion
    sent = []

    async def record(message):
        sent.append(message)

    agent = Agent(["Certo, ecco i dettagli."])
    chatter = Scripted(["Hai visto? Hanno scoperto un nuovo pianeta!"])
    built = []

    def fake_create(settings, engine, models=""):
        built.append((engine, models))
        return chatter

    monkeypatch.setattr(server.hub, "broadcast", record)
    monkeypatch.setattr(instance, "history", [])
    monkeypatch.setattr(instance, "llm", agent)
    monkeypatch.setattr(instance, "last_errors", {})
    monkeypatch.setattr(Companion, "voice_language", property(lambda self: "it"))
    monkeypatch.setattr(proactive, "create_chatter_llm", fake_create)
    context = PCContext()
    context.update(200, False, {"title": "Meteo - Google Chrome", "exe": "chrome.exe", "fullscreen": False, "own": False})
    prefs = Preferences(None)
    prefs.update({"topics": {"facts": False, "films": False}, "brain": "openrouter", "brainModels": "a:free, b:free"}, save=False)
    engine = Proactive(
        companion=lambda: instance,
        context=context,
        preferences=prefs,
        broadcast=record,
        news=FakeNews(),
        battery_reader=lambda: None,
        rng=random.Random(3),
    )
    engine.next_break_minutes = 10**9
    engine.next_chatter_at = 0
    yield engine, instance, agent, chatter, sent, built
    instance._asides.clear()


def test_the_news_is_written_by_the_chatter_brain_not_the_agent(client, rig):
    engine, instance, agent, chatter, sent, built = rig
    said = client.portal.call(engine.tick, datetime.now().replace(hour=18))
    assert said == "news:Scoperto un nuovo pianeta"
    assert built == [("openrouter", "a:free, b:free")]
    assert agent.messages is None  # Claude Code non ha speso niente
    assert "Scoperto un nuovo pianeta" in chatter.messages[-1].content
    assert [m["text"] for m in sent if m["type"] == "reply"] == ["Hai visto? Hanno scoperto un nuovo pianeta!"]


def test_the_agent_hears_what_she_said_on_the_next_turn(client, rig):
    engine, instance, agent, chatter, sent, built = rig
    client.portal.call(engine.tick, datetime.now().replace(hour=18))
    client.portal.call(lambda: instance.chat("dimmi di più", server.hub.broadcast))
    asked = agent.messages[-1].content
    assert "Hanno scoperto un nuovo pianeta" in asked and asked.endswith("dimmi di più")
    client.portal.call(lambda: instance.chat("grazie", server.hub.broadcast))
    assert agent.messages[-1].content == "grazie"  # detto una volta sola
    # E in chat resta la domanda dell'utente, non la nota per l'agente.
    assert [m["text"] for m in sent if m["type"] == "user"] == ["dimmi di più", "grazie"]


def test_the_chatter_brain_sees_only_the_last_exchanges(client, rig):
    engine, instance, agent, chatter, sent, built = rig
    from backend.llm.base import Message

    instance.history.extend(Message("user", f"messaggio {n}") for n in range(20))
    client.portal.call(engine.tick, datetime.now().replace(hour=18))
    history = [m.content for m in chatter.messages if m.role == "user"][:-1]
    assert history == [f"messaggio {n}" for n in range(14, 20)]


def test_a_failing_chatter_brain_stays_quiet(client, rig, monkeypatch):
    engine, instance, agent, chatter, sent, built = rig
    broken = Broken()
    monkeypatch.setattr(proactive, "create_chatter_llm", lambda settings, engine, models="": broken)
    client.portal.call(engine.tick, datetime.now().replace(hour=18))
    assert broken.calls == 1
    assert agent.messages is None  # niente ripiego sull'agente
    assert not [m for m in sent if m["type"] == "error"]  # niente bolla rossa
    assert "llm" not in instance.last_errors
    assert "429" in instance.last_errors["chatter"]
    assert "429" in engine.status()["brainError"]


def test_a_brain_that_cannot_start_means_no_chatter(client, rig, monkeypatch):
    engine, instance, agent, chatter, sent, built = rig

    def missing_key(settings, engine, models=""):
        raise RuntimeError("Manca la chiave API di openrouter.")

    monkeypatch.setattr(proactive, "create_chatter_llm", missing_key)
    assert client.portal.call(engine.tick, datetime.now().replace(hour=18)) is None
    assert agent.messages is None
    assert "chiave" in engine.status()["brainError"]


def test_without_a_choice_the_main_brain_writes(client, rig, monkeypatch):
    engine, instance, agent, chatter, sent, built = rig
    engine.preferences.update({"brain": ""}, save=False)
    monkeypatch.setattr(Proactive, "_brain_ready", lambda self, companion: True)
    client.portal.call(engine.tick, datetime.now().replace(hour=18))
    assert built == [] and chatter.messages is None
    assert "Scoperto un nuovo pianeta" in agent.messages[-1].content


def test_fallback_tries_the_next_model_only_before_the_first_words(client):
    good = Scripted(["Ciao", "!"])
    assert client.portal.call(collect(FallbackLLM([Broken(), good], name="openrouter").stream([]))) == ["Ciao", "!"]
    half = FallbackLLM([Broken(after=["Ci"]), good], name="openrouter")
    with pytest.raises(RuntimeError):
        client.portal.call(collect(half.stream([])))
    with pytest.raises(RuntimeError, match="Nessun modello"):
        client.portal.call(collect(FallbackLLM([Broken(), Broken()], name="openrouter").stream([])))


def test_create_chatter_llm_builds_a_queue_of_models():
    base = Settings.from_env()
    settings = dataclasses.replace(base, provider_options={**base.provider_options, "OPENROUTER_API_KEY": "sk-test"})
    brain = create_chatter_llm(settings, "openrouter", "a:free, b:free")
    assert isinstance(brain, FallbackLLM)
    assert [client.model for client in brain.clients] == ["a:free", "b:free"]
    single = create_chatter_llm(settings, "openrouter", "a:free")
    assert isinstance(single, OpenAICompatibleClient) and single.model == "a:free"
    with pytest.raises(ValueError):
        create_chatter_llm(settings, "claude_code")  # gli agenti no
    # Senza chiave: tolta apposta, il .env di chi lancia i test potrebbe averla.
    keyless = dataclasses.replace(
        base, provider_options={k: v for k, v in base.provider_options.items() if k != "OPENROUTER_API_KEY"}
    )
    with pytest.raises(RuntimeError, match="chiave"):
        create_chatter_llm(keyless, "openrouter")


def test_brain_preferences_are_validated():
    prefs = Preferences(None)
    prefs.update({"brain": "openrouter", "brainModels": " a:free ,, b:free "}, save=False)
    assert prefs.brain == "openrouter" and prefs.brain_models == "a:free, b:free"
    prefs.update({"brain": "../../etc"}, save=False)
    assert prefs.brain == "openrouter"


def test_a_key_is_saved_without_switching_the_main_brain(client, monkeypatch):
    saved = []

    def fake_save_dotenv(updates, path=None):
        saved.append(dict(updates))
        for key, value in updates.items():
            monkeypatch.setenv(key, value)

    instance = server.app.state.companion
    monkeypatch.setattr(server, "save_dotenv", fake_save_dotenv)
    monkeypatch.setattr(server, "SETTINGS", server.SETTINGS)
    monkeypatch.setattr(instance, "settings", instance.settings)
    response = client.post(
        "/api/providers/options",
        json={"kind": "llm", "provider": "openrouter", "options": {"OPENROUTER_API_KEY": "sk-or-test"}},
    ).json()
    assert response["ok"] and response["saved"]["OPENROUTER_API_KEY"] is True
    assert saved == [{"DC_OPENROUTER_API_KEY": "sk-or-test"}]
    assert server.SETTINGS.selected("llm") == "mock"
    assert instance.settings.provider_config("llm", "openrouter")["OPENROUTER_API_KEY"] == "sk-or-test"
    active = client.post("/api/providers/options", json={"kind": "llm", "provider": "mock", "options": {}})
    assert active.status_code == 400
