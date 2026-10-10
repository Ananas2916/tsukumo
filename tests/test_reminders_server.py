"""Reminders inside the companion: immediate confirmations, the brain's tags, firing."""

import time

import pytest

from backend import server
from backend.reminders import Reminder, ReminderStore
from helpers import Scripted


@pytest.fixture
def events(client, monkeypatch):
    """Reminders in memory (never on disk) and a log of everything sent to the clients."""
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
    # The brain knows it can do it, and knows what time it is.
    assert "[[remind" in brain.messages[-2].content and "Local time" in brain.messages[-2].content
    [task] = server.REMINDERS.all()
    assert task.kind == "task" and task.text == "controlla la build"
    spoken = " ".join(m.get("text", "") for m in events if m["type"] in ("token", "speech", "caption", "reply"))
    assert "[[" not in spoken and "remind" not in spoken
    assert instance.history[-1].content == "Certo, ci penso io più tardi."


def test_the_agenda_is_reachable_from_chat(client, events, monkeypatch):
    """From the phone: "aggiungi al calendario..." ends up in the Agenda, one reminder per day."""
    instance = server.app.state.companion
    brain = Scripted(["non dovrei essere chiamato"])
    monkeypatch.setattr(instance, "llm", brain)
    reply = client.portal.call(
        instance.chat, "aggiungi al calendario reti logiche compito mettilo per giovedì venerdì e sabato", server.hub.broadcast
    )
    assert brain.messages is None
    # The days come out in date order: which comes first depends on today.
    assert reply.startswith("Va bene, ")
    assert all(day in reply for day in ("giovedì", "venerdì", "sabato"))
    assert [item.text for item in server.REMINDERS.all()] == ["reti logiche compito"] * 3


def test_the_brain_knows_the_agenda_is_its_calendar(client, events, monkeypatch):
    instance = server.app.state.companion
    tags = '[[remind {"at": "2099-01-01T09:00", "text": "esame"}]][[remind {"at": "2099-01-02T09:00", "text": "esame"}]]'
    brain = Scripted(["Fatto, l'ho messo in agenda. ", tags])
    monkeypatch.setattr(instance, "llm", brain)
    client.portal.call(instance.chat, "metti l'esame nel mio calendario il primo e il due gennaio 2099", server.hub.broadcast)
    directive = brain.messages[-2].content
    assert "calendar" in directive and "one tag per day" in directive
    assert [item.text for item in server.REMINDERS.all()] == ["esame", "esame"]


def test_a_due_reminder_is_announced(client, events):
    server.REMINDERS.add(Reminder(kind="reminder", due=time.time() - 5, text="bere un bicchiere d'acqua", language="it"))
    fired = client.portal.call(server._fire_due_reminders)
    assert [item.text for item in fired] == ["bere un bicchiere d'acqua"]
    assert server.REMINDERS.all() == []
    [message] = [m for m in events if m["type"] == "reminder"]
    assert message["event"] == "fired" and message["reminder"]["label"] == "Promemoria: bere un bicchiere d'acqua"
    [reply] = _wait_for(events, lambda m: m["type"] == "reply" and m.get("proactive"))
    assert reply["text"] == "Ehi, ti ricordo di bere un bicchiere d'acqua!"
    assert server.app.state.companion.history[-2].content.startswith("(Reminder due")


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


def test_the_agenda_field_adds_one_reminder_per_day(client, events):
    created = client.post("/api/reminders", json={"phrase": "compito reti logiche giovedì, venerdì e sabato"}).json()
    assert created["ok"] and len(created["reminders"]) == 3
    assert created["reminder"] == created["reminders"][0]
    assert {item["text"] for item in created["reminders"]} == {"compito reti logiche"}
    assert len(client.get("/api/reminders").json()["reminders"]) == 3
    assert client.post("/api/reminders", json={"phrase": "compito reti logiche"}).status_code == 400
    assert client.post("/api/reminders", json={"phrase": "ciao come stai"}).status_code == 400
    assert client.post("/api/reminders", json={"kind": "reminder", "at": "2020-01-01T10:00"}).status_code == 400
