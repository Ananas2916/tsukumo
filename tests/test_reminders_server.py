"""Promemoria dentro al companion: conferme immediate, etichette del cervello, scatto."""

import time

import pytest

from backend import server
from backend.llm.base import LLMClient
from backend.reminders import Reminder, ReminderStore


class Scripted(LLMClient):
    """Un cervello finto che risponde sempre con gli stessi pezzi."""

    name = "scripted"

    def __init__(self, pieces):
        self.pieces = pieces
        self.messages = None

    async def stream(self, messages):
        self.messages = messages
        for piece in self.pieces:
            yield piece

    async def health(self):
        return {"ok": True}


@pytest.fixture
def events(client, monkeypatch):
    """Promemoria in memoria (mai su disco) e registro di tutto quello che si manda ai client."""
    recorded = []

    async def record(message):
        recorded.append(message)

    store = ReminderStore(None)
    instance = server.app.state.companion
    monkeypatch.setattr(server, "REMINDERS", store)
    monkeypatch.setattr(instance, "reminders", store)
    monkeypatch.setattr(server.hub, "broadcast", record)
    monkeypatch.setattr(instance, "history", [])
    return recorded


def _wait_for(recorded, predicate, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = [message for message in recorded if predicate(message)]
        if found:
            return found
        time.sleep(0.02)
    raise AssertionError(f"Nessun messaggio atteso fra {[m.get('type') for m in recorded]}")


def test_a_timer_is_confirmed_without_the_brain(client, events, monkeypatch):
    instance = server.app.state.companion
    brain = Scripted(["non dovrei essere chiamato"])
    monkeypatch.setattr(instance, "llm", brain)
    reply = client.portal.call(instance.chat, "metti un timer di 5 minuti", server.hub.broadcast)
    assert reply == "Ok, timer di 5 minuti. Parte adesso!"
    assert brain.messages is None
    [timer] = server.REMINDERS.all()
    assert timer.kind == "timer" and timer.duration == 300
    assert any(m["type"] == "reminders" for m in events)
    assert [m["text"] for m in events if m["type"] == "reply"] == [reply]


def test_the_brain_can_schedule_with_a_hidden_tag(client, events, monkeypatch):
    instance = server.app.state.companion
    brain = Scripted(["Certo, ci penso io più tardi. [[remind ", '{"in": 120, "do": "controlla la build"}', "]]"])
    monkeypatch.setattr(instance, "llm", brain)
    client.portal.call(instance.chat, "quando hai tempo controlla la build", server.hub.broadcast)
    # Il cervello sa che puo' farlo, e sa che ore sono.
    assert "[[remind" in brain.messages[-2].content and "Local time" in brain.messages[-2].content
    [task] = server.REMINDERS.all()
    assert task.kind == "task" and task.text == "controlla la build"
    spoken = " ".join(m.get("text", "") for m in events if m["type"] in ("token", "speech", "caption", "reply"))
    assert "[[" not in spoken and "remind" not in spoken
    assert instance.history[-1].content == "Certo, ci penso io più tardi."


def test_a_due_reminder_is_announced(client, events):
    server.REMINDERS.add(Reminder(kind="reminder", due=time.time() - 5, text="bere un bicchiere d'acqua", language="it"))
    fired = client.portal.call(server._fire_due_reminders)
    assert [item.text for item in fired] == ["bere un bicchiere d'acqua"]
    assert server.REMINDERS.all() == []
    [message] = [m for m in events if m["type"] == "reminder"]
    assert message["event"] == "fired" and message["reminder"]["label"] == "Promemoria: bere un bicchiere d'acqua"
    [reply] = _wait_for(events, lambda m: m["type"] == "reply" and m.get("proactive"))
    assert reply["text"] == "Ehi, ti ricordo di bere un bicchiere d'acqua!"
    assert server.app.state.companion.history[-2].content.startswith("(Promemoria scattato")


def test_a_reminder_lost_long_ago_is_skipped(client, events):
    server.REMINDERS.add(Reminder(kind="reminder", due=time.time() - 2 * 86400, text="vecchio"))
    assert client.portal.call(server._fire_due_reminders) == []
    assert server.REMINDERS.all() == []


def test_hidden_messages_do_not_appear_as_the_user(client, events, monkeypatch):
    instance = server.app.state.companion
    monkeypatch.setattr(instance, "llm", Scripted(["Fatto!"]))
    client.portal.call(lambda: instance.chat("(Azione programmata) controlla", server.hub.broadcast, hidden=True))
    assert not [m for m in events if m["type"] == "user"]
    assert [m["text"] for m in events if m["type"] == "reply"] == ["Fatto!"]


def test_reminders_rest_api(client, events):
    created = client.post("/api/reminders", json={"phrase": "tra 20 minuti ricordami di bere"}).json()
    assert created["ok"] and created["reminder"]["text"] == "bere"
    timer = client.post("/api/reminders", json={"kind": "timer", "seconds": 90}).json()["reminder"]
    assert timer["duration"] == 90
    listed = client.get("/api/reminders").json()["reminders"]
    assert [item["id"] for item in listed] == [timer["id"], created["reminder"]["id"]]
    assert client.delete(f"/api/reminders/{timer['id']}").json() == {"ok": True}
    assert client.delete("/api/reminders/nope").status_code == 404
    assert client.post("/api/reminders", json={"phrase": "ciao come stai"}).status_code == 400
    assert client.post("/api/reminders", json={"kind": "reminder", "at": "2020-01-01T10:00"}).status_code == 400
