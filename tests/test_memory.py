"""Personalita' e ricordi uguali per ogni cervello."""

import asyncio

from backend.config import Settings
from backend.memory import MemoryStore, fact_from_tag, memory_command
from backend.pipeline import Companion

from helpers import Scripted


class Recorder:
    def __init__(self):
        self.messages = []

    async def __call__(self, message):
        self.messages.append(message)

    def of(self, kind):
        return [m for m in self.messages if m["type"] == kind]


def test_store_survives_a_restart_and_skips_duplicates(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    store.set_persona(name="Miku", traits="allegra e curiosa")
    assert store.add("Ha un gatto che si chiama Miso")
    assert store.add("ha un gatto che si chiama miso.") is None
    # Lo stesso ricordo con un dettaglio in piu' sostituisce il vecchio.
    assert store.add("Ha un gatto che si chiama Miso, ed e' arancione") is None
    again = MemoryStore(tmp_path / "memory.json")
    assert again.name == "Miku" and [f.text for f in again.facts()] == ["Ha un gatto che si chiama Miso, ed e' arancione"]


def test_voice_commands(tmp_path):
    store = MemoryStore(tmp_path / "m.json")
    assert memory_command("Ricordati che lavoro in Python", store, "it") == "Va bene, me lo ricordo."
    assert memory_command("ricorda che lavoro in Python", store, "it") == "Lo so già, me lo avevi detto."
    assert "lavoro in Python" in memory_command("Cosa ricordi di me?", store, "it")
    assert memory_command("dimentica che lavoro in python", store, "it") == "Fatto, l'ho dimenticato."
    assert memory_command("che tempo fa?", store, "it") is None
    assert memory_command("Remember that I like jazz", store, "en") == "Okay, I'll remember that."


def test_directive_carries_persona_and_facts(tmp_path):
    store = MemoryStore(tmp_path / "m.json")
    store.set_persona(name="Miku")
    store.add("si chiama Filippo")
    for agent in (True, False):
        directive = store.directive(agent=agent)
        assert "Miku" in directive and "si chiama Filippo" in directive and "[[remember:" in directive
    assert fact_from_tag("[[remember: le piace il jazz]]") == "le piace il jazz"
    assert fact_from_tag('[[remind {"in": 60, "text": "x"}]]') is None


def test_brain_can_save_a_fact_with_a_hidden_tag(tmp_path):
    emit = Recorder()
    companion = Companion(Settings.from_env())
    companion.memory = MemoryStore(tmp_path / "m.json")
    companion.llm = Scripted(["Che bello, un gatto! ", "[[remember: ha un gatto di nome Miso]]"])
    reply = asyncio.run(companion.chat("ho un gatto che si chiama Miso", emit))
    assert "remember" not in reply and "[[" not in "".join(m["text"] for m in emit.of("token"))
    assert [f.text for f in companion.memory.facts()] == ["ha un gatto di nome Miso"]
    assert companion.memory.facts()[0].source == "brain"
    # E al turno dopo il cervello lo sa.
    companion.llm = Scripted(["Ok."])
    asyncio.run(companion.chat("come si chiama il mio gatto?", emit))
    system = " ".join(m.content for m in companion.llm.messages if m.role == "system")
    assert "ha un gatto di nome Miso" in system


def test_remember_command_is_answered_without_a_brain(tmp_path):
    emit = Recorder()
    companion = Companion(Settings.from_env())
    companion.memory = MemoryStore(tmp_path / "m.json")
    brain = Scripted(["non dovrei rispondere io"])
    companion.llm = brain
    reply = asyncio.run(companion.chat("ricordati che mi chiamo Filippo", emit))
    assert reply == "Va bene, me lo ricordo." and brain.messages is None
    assert emit.of("reply")[0]["local"] is True


def test_a_reminder_with_a_time_is_not_a_memory(tmp_path):
    store = MemoryStore(tmp_path / "m.json")
    assert memory_command("ricordati che domani alle 9 ho il dentista", store, "it") is None
    assert memory_command("remember that tomorrow I have a call", store, "en") is None
    assert store.facts() == []
