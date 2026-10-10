"""Timers and reminders: natural sentences, the brain's tags, store, commands."""

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
    confirmations,
    from_tag,
    parse_duration,
    parse_request,
    parse_requests,
    second_person,
    speak_duration,
)

NOW = datetime(2026, 9, 26, 1, 12)  # a Saturday at one in the morning


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
        # The day comes from "tra", the hour from the time: "alle 10" doesn't stay in the text.
        ("ricordami tra 2 giorni alle 10 dell'esame di analisi", "reminder", "28/09 10:00", "dell'esame di analisi", "it"),
        ("fra una settimana alle 18:30 ricordami la palestra", "reminder", "03/10 18:30", "la palestra", "it"),
        # "di sera" belongs to the time: it doesn't end up in the reminder text.
        ("ricordami tra 2 giorni alle 9 di sera di chiamare Marco", "reminder", "28/09 21:00", "chiamare Marco", "it"),
        ("remind me in 2 days at 7 in the morning to run", "reminder", "28/09 07:00", "run", "en"),
        ("remind me in 3 days at 9am to renew the passport", "reminder", "29/09 09:00", "renew the passport", "en"),
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
        "dimmi cosa fare domani",  # "dimmi" + only a date: not a reminder
        "devo studiare",
        "quanti giorni mancano a natale?",
        "che tempo fa domani?",
        "timer",  # no duration
        "ricordami di chiamare il 1/1/2020",  # in the past
        "come aggiungo un evento al calendario domani?",  # a question, not a request
        "cosa ho in agenda giovedì?",
    ],
)
def test_ordinary_sentences_are_not_reminders(phrase):
    assert parse_request(phrase, NOW) is None


@pytest.mark.parametrize(
    ("phrase", "explicit", "dues", "text"),
    [
        # Said in chat from the phone: "agenda"/"calendario" count as much as "ricordami".
        (
            "aggiungi al calendario un evento reti logiche compito e trovare compagno mettilo per giovedi venerdi sabato e domenica",
            False,
            ["01/10 09:00", "02/10 09:00", "03/10 09:00", "27/09 09:00"],
            "reti logiche compito e trovare compagno",
        ),
        ("ricordami giovedì e venerdì alle 18 di andare in palestra", False, ["01/10 18:00", "02/10 18:00"], "andare in palestra"),
        ("add the exam to my calendar on friday and saturday", False, ["02/10 09:00", "03/10 09:00"], "the exam"),
        # The Agenda's field is already a request: the day is enough.
        ("reti logiche compito giovedì, venerdì, sabato e domenica", True, ["01/10 09:00", "02/10 09:00", "03/10 09:00", "27/09 09:00"], "reti logiche compito"),
        ("domani dentista", True, ["27/09 09:00"], "dentista"),
        # A later date is part of the thing to remember, not of the list.
        ("ricordami domani di preparare la riunione di lunedì", False, ["27/09 09:00"], "preparare la riunione di lunedì"),
        # Every day already repeats by itself.
        ("ogni giorno ricordami di bere lunedì e martedì alle 9", False, ["28/09 09:00"], "bere"),
    ],
)
def test_one_phrase_several_days(phrase, explicit, dues, text):
    requests = parse_requests(phrase, NOW, explicit=explicit)
    assert sorted(request.due.strftime("%d/%m %H:%M") for request in requests) == sorted(dues)
    assert {request.text for request in requests} == {text}


def test_agenda_field_still_needs_a_day():
    assert parse_requests("riunione", NOW, explicit=True) == []
    assert parse_request("giovedì riunione", NOW) is None  # in chat, without "ricordami", the brain decides


def test_several_days_are_confirmed_together():
    requests = parse_requests("ricordami giovedì e venerdì alle 18 di andare in palestra", NOW)
    reminders = [request.to_reminder() for request in requests]
    assert confirmations(reminders, NOW) == "Va bene, giovedì 1 e venerdì 2 alle 18:00 ti ricordo di andare in palestra."
    assert confirmations(reminders[:1], NOW) == confirmation(reminders[0], NOW)


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
    """A 7 o'clock alarm stays at 7 even after the clock change (25 October 2026 in Italy)."""
    from datetime import datetime

    from backend.reminders import Reminder, ReminderStore

    store = ReminderStore(tmp_path / "reminders.json")
    due = datetime(2026, 10, 24, 7, 0).timestamp()
    reminder = store.add(Reminder(kind="alarm", due=due, text="sveglia", repeat="daily"))
    store.done(reminder, now=due + 1)
    following = datetime.fromtimestamp(store.get(reminder.id).due)
    assert (following.year, following.month, following.day, following.hour, following.minute) == (2026, 10, 25, 7, 0)


@pytest.mark.parametrize(
    ("phrase", "due", "text"),
    [
        # From the phone, on 6 October: "il 31" without a month and "aggiungi" without "calendario".
        ("Aggiungi il 31 Cinema con Giulia", "31/10 09:00", "Cinema con Giulia"),
        ("segna il 3 alle 18 dentista", "03/10 18:00", "dentista"),
        ("puoi aggiungere il 15 esame di analisi?", "15/10 09:00", "esame di analisi"),
        ("ricordami il 30 di pagare l'affitto", "30/09 09:00", "pagare l'affitto"),
    ],
)
def test_day_of_month_alone_and_add_first(phrase, due, text):
    # NOW is Saturday 26 September: September has no 31st, so it's 31 October.
    [request] = parse_requests(phrase, NOW)
    assert (request.due.strftime("%d/%m %H:%M"), request.text) == (due, text)


@pytest.mark.parametrize("phrase", ["il 31% delle persone", "aggiungi il sale", "ho preso 28 il 31 maggio", "come aggiungo il 31 al calendario?"])
def test_numbers_that_are_not_requests(phrase):
    assert parse_requests(phrase, NOW) == []
