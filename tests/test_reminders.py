"""Timer e promemoria: frasi naturali, etichette del cervello, archivio, comandi."""

import json
from datetime import datetime, timedelta

import pytest

from backend.reminders import (
    Reminder,
    ReminderStore,
    TagFilter,
    announcement,
    command_reply,
    confirmation,
    from_tag,
    parse_duration,
    parse_request,
    second_person,
    speak_duration,
)

NOW = datetime(2026, 9, 26, 1, 12)  # un sabato all'una di notte


@pytest.mark.parametrize(
    ("phrase", "kind", "due", "text", "language"),
    [
        ("metti un timer di 5 minuti", "timer", "26/09 01:17", "", "it"),
        ("timer 25 min per la pasta", "timer", "26/09 01:37", "la pasta", "it"),
        ("set a timer for 10 minutes", "timer", "26/09 01:22", "", "en"),
        ("ricordami di chiamare Marco tra mezz'ora", "reminder", "26/09 01:42", "chiamare Marco", "it"),
        ("tra 30 min devo fare quello", "reminder", "26/09 01:42", "devo fare quello", "it"),
        ("alle 12:00 del 29/12/2027 ricordami di andare dal dentista", "reminder", "29/12 12:00", "andare dal dentista", "it"),
        ("ricordami del dentista il 29 dicembre alle 12", "reminder", "29/12 12:00", "del dentista", "it"),
        ("ricordami domani di comprare il latte", "reminder", "27/09 09:00", "comprare il latte", "it"),
        ("ricordami stasera alle 8 di chiamare la nonna", "reminder", "26/09 20:00", "chiamare la nonna", "it"),
        ("alle 5 di pomeriggio ricordami di uscire", "reminder", "26/09 17:00", "uscire", "it"),
        ("ricordami lunedì alle 10 di pagare la bolletta", "reminder", "28/09 10:00", "pagare la bolletta", "it"),
        ("ricordami tra un'ora e mezza di togliere il bucato", "reminder", "26/09 02:42", "togliere il bucato", "it"),
        ("ricordami tra 2 ore e 10 minuti di spegnere il forno", "reminder", "26/09 03:22", "spegnere il forno", "it"),
        ("all'una e mezza ricordami di dormire", "reminder", "26/09 01:30", "dormire", "it"),
        ("svegliami alle 7 e mezza", "alarm", "26/09 07:30", "", "it"),
        ("remind me to stretch in 20 minutes", "reminder", "26/09 01:32", "stretch", "en"),
        ("remind me tomorrow at 5pm to call mom", "reminder", "27/09 17:00", "call mom", "en"),
        ("wake me up at 6:30 am", "alarm", "26/09 06:30", "", "en"),
        ("remind me on 12/29/2026 at noon to buy gifts", "reminder", "29/12 12:00", "buy gifts", "en"),
    ],
)
def test_natural_requests(phrase, kind, due, text, language):
    request = parse_request(phrase, NOW)
    assert request is not None, phrase
    assert (request.kind, request.due.strftime("%d/%m %H:%M"), request.text, request.language) == (kind, due, text, language)


@pytest.mark.parametrize(
    "phrase",
    [
        "dimmi una barzelletta",
        "dimmi cosa fare domani",  # "dimmi" + solo una data: non e' un promemoria
        "devo studiare",
        "quanti giorni mancano a natale?",
        "che tempo fa domani?",
        "timer",  # senza durata
        "ricordami di chiamare il 1/1/2020",  # nel passato
    ],
)
def test_ordinary_sentences_are_not_reminders(phrase):
    assert parse_request(phrase, NOW) is None


def test_every_day_repeats_from_the_next_occurrence():
    request = parse_request("ogni giorno alle 9 ricordami di bere", NOW)
    assert request.repeat == "daily" and request.due == datetime(2026, 9, 26, 9, 0)
    store = ReminderStore(None)
    reminder = store.add(request.to_reminder())
    store.done(reminder, now=reminder.due + 1)
    assert store.get(reminder.id).due == datetime(2026, 9, 27, 9, 0).timestamp()


def test_durations():
    assert parse_duration("5 minuti") == 300
    assert parse_duration("un'ora e mezza") == 5400
    assert parse_duration("2 ore e mezza") == 9000
    assert parse_duration("1h 30m") == 5400
    assert parse_duration("a quarter of an hour") == 900
    assert parse_duration("ciao") is None
    assert speak_duration(200, "it") == "3 minuti e 20 secondi"
    assert speak_duration(3660, "en") == "one hour and one minute"


def test_phrases_speak_to_the_user():
    assert second_person("devo chiamare mia madre", "it") == "devi chiamare tua madre"
    assert second_person("I have to call my mom", "en") == "you have to call your mom"
    request = parse_request("tra 30 min devo fare quello", NOW)
    reminder = request.to_reminder()
    assert confirmation(reminder, NOW) == "Va bene, tra 30 minuti ti ricordo che devi fare quello."
    assert announcement(reminder) == "Ehi, ti ricordo che devi fare quello!"
    assert announcement(reminder, late=600).startswith("Scusa il ritardo")
    timer = parse_request("timer 25 min per la pasta", NOW).to_reminder()
    assert announcement(timer) == "Il timer di 25 minuti per la pasta è finito!"


def test_tag_filter_hides_tags_split_across_pieces():
    tags = TagFilter()
    pieces = ["Certo, te lo ricordo! [", '[remind {"in": 60, ', '"text": "bere"}', "]] Ok?"]
    visible = "".join(tags.feed(piece) for piece in pieces) + tags.flush()
    assert visible == "Certo, te lo ricordo!  Ok?"
    assert len(tags.tags) == 1
    reminder = from_tag(tags.tags[0], NOW)
    assert reminder.kind == "reminder" and reminder.text == "bere"
    assert reminder.due == (NOW + timedelta(seconds=60)).timestamp()
    lonely = TagFilter()
    assert lonely.feed("array[") == "array" and lonely.flush() == "["


def test_tags_for_tasks_and_absolute_times():
    task = from_tag('[[remind {"at": "2026-12-29T12:00", "do": "controlla le mail"}]]', NOW)
    assert task.kind == "task" and task.text == "controlla le mail"
    assert datetime.fromtimestamp(task.due) == datetime(2026, 12, 29, 12, 0)
    assert from_tag('[[remind {"at": "2020-01-01T00:00", "text": "x"}]]', NOW) is None
    assert from_tag("[[remind non-json]]", NOW) is None
    daily = from_tag('[[remind {"in": 10, "text": "x", "repeat": "daily"}]]', NOW)
    assert daily.repeat == "daily"


def test_store_persists_and_orders(tmp_path):
    path = tmp_path / "reminders.json"
    store = ReminderStore(path)
    later = store.add(Reminder(kind="reminder", due=NOW.timestamp() + 600, text="dopo"))
    sooner = store.add(Reminder(kind="timer", due=NOW.timestamp() + 60, duration=60))
    reloaded = ReminderStore(path)
    assert [item.id for item in reloaded.all()] == [sooner.id, later.id]
    assert reloaded.next_due() == sooner.due
    assert [item.id for item in reloaded.due(NOW.timestamp() + 120)] == [sooner.id]
    assert json.loads(path.read_text(encoding="utf-8"))["reminders"][0]["kind"] in ("timer", "reminder")


def test_commands_cancel_remaining_and_list():
    store = ReminderStore(None)
    store.add(Reminder(kind="timer", due=NOW.timestamp() + 200, duration=300))
    store.add(Reminder(kind="reminder", due=NOW.timestamp() + 3600, text="bere"))
    assert command_reply("quanto manca?", store, NOW) == ("Mancano 3 minuti e 20 secondi.", False)
    reply, changed = command_reply("quali promemoria ho?", store, NOW)
    assert "Timer 5 minuti" in reply and "Promemoria: bere" in reply and not changed
    assert command_reply("annulla il timer", store, NOW) == ("Fatto, ho annullato: Timer 5 minuti.", True)
    assert command_reply("cancel the timer", store, NOW) == ("There's nothing to cancel.", False)
    assert command_reply("che ore sono?", store, NOW) is None


def test_daily_reminder_keeps_the_wall_clock_across_dst(tmp_path):
    """Una sveglia delle 7 resta alle 7 anche dopo il cambio dell'ora (25 ottobre 2026 in Italia)."""
    from datetime import datetime

    from backend.reminders import Reminder, ReminderStore

    store = ReminderStore(tmp_path / "reminders.json")
    due = datetime(2026, 10, 24, 7, 0).timestamp()
    reminder = store.add(Reminder(kind="alarm", due=due, text="sveglia", repeat="daily"))
    store.done(reminder, now=due + 1)
    following = datetime.fromtimestamp(store.get(reminder.id).due)
    assert (following.year, following.month, following.day, following.hour, following.minute) == (2026, 10, 25, 7, 0)
