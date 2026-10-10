"""Timers, reminders, alarms and scheduled actions: the companion's "Alexa" part.

"Timer di 5 minuti", "ricordami di chiamare Marco tra mezz'ora", "il 29/12
alle 12 ricordami del dentista", "ogni giorno alle 9 ricordami di bere",
"remind me to stretch in 20 minutes": the most common requests (in Italian
and in English) are understood here, without the brain. They're immediate
and work with the offline answerer too.

Everything else is understood by the brain: it's asked
(``action_directive``) to add a ``[[remind {...}]]`` tag at the end of the
reply, which the pipeline removes from the text before reading it
(``TagFilter``) and turns into a reminder (``from_tag``). With ``"do"``
instead of ``"text"`` it's an action: at the right time the text goes to
the brain as a task to carry out.

Reminders live in ``state/reminders.json``: they survive restarts, and those
that came due while the PC was off are said on return.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

KINDS = ("timer", "reminder", "alarm", "task")

#: Beyond this delay a missed reminder (PC off) isn't said any more.
MAX_LATE = 12 * 3600


# ---------------------------------------------------------------------------
# Model and store
# ---------------------------------------------------------------------------
@dataclass
class Reminder:
    kind: str
    #: When it goes off (``time.time()``).
    due: float
    #: What to remember ("chiamare Marco"), what to do (``task``), or what the timer is for.
    text: str = ""
    #: "" or "daily".
    repeat: str = ""
    #: Timer: total length in seconds ("the 5-minute timer is over").
    duration: float = 0.0
    #: The language it was asked in: it's confirmed and announced in that language.
    language: str = "it"
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    created: float = field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["dueIso"] = datetime.fromtimestamp(self.due).isoformat(timespec="seconds")
        data["label"] = describe(self)
        return data


class ReminderStore:
    """The pending reminders, saved to disk at every change."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._items: dict[str, Reminder] = {}
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        if not self.path or not self.path.is_file():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            for item in raw.get("reminders", []):
                reminder = Reminder(**{k: v for k, v in item.items() if k in Reminder.__dataclass_fields__})
                if reminder.kind in KINDS:
                    self._items[reminder.id] = reminder
        except Exception as exc:
            logger.warning("Reminders unreadable from %s: %s", self.path, exc)

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"reminders": [asdict(item) for item in self.all()]}
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError as exc:
            logger.warning("Reminders not saved in %s: %s", self.path, exc)

    def all(self) -> list[Reminder]:
        with self._lock:
            return sorted(self._items.values(), key=lambda item: item.due)

    def get(self, reminder_id: str) -> Reminder | None:
        return self._items.get(reminder_id)

    def add(self, reminder: Reminder) -> Reminder:
        with self._lock:
            self._items[reminder.id] = reminder
        self._save()
        return reminder

    def remove(self, reminder_id: str) -> Reminder | None:
        with self._lock:
            removed = self._items.pop(reminder_id, None)
        if removed:
            self._save()
        return removed

    def due(self, now: float | None = None) -> list[Reminder]:
        now = time.time() if now is None else now
        return [item for item in self.all() if item.due <= now]

    def next_due(self) -> float | None:
        items = self.all()
        return items[0].due if items else None

    def done(self, reminder: Reminder, now: float | None = None) -> None:
        """It went off: it's removed, or moved to the next day if it repeats."""
        now = time.time() if now is None else now
        if reminder.repeat == "daily":
            # The same time *on your clock*, not 86400 seconds later: with the
            # daylight-saving change a 7 o'clock alarm would go off at 6 (or 8).
            moment = datetime.fromtimestamp(reminder.due)
            while moment.timestamp() <= now:
                moment += timedelta(days=1)
            reminder.due = moment.timestamp()
            with self._lock:
                self._items[reminder.id] = reminder
            self._save()
        else:
            self.remove(reminder.id)

    def latest(self, kinds: tuple[str, ...]) -> Reminder | None:
        """The last one created among those of these kinds ("cancel the timer")."""
        items = [item for item in self.all() if item.kind in kinds]
        return max(items, key=lambda item: item.created) if items else None


# ---------------------------------------------------------------------------
# Numbers and durations
# ---------------------------------------------------------------------------
_NUMBERS = {
    # Italian
    "un": 1, "uno": 1, "una": 1, "un'": 1, "due": 2, "tre": 3, "quattro": 4, "cinque": 5, "sei": 6,
    "sette": 7, "otto": 8, "nove": 9, "dieci": 10, "undici": 11, "dodici": 12, "tredici": 13,
    "quattordici": 14, "quindici": 15, "sedici": 16, "diciassette": 17, "diciotto": 18,
    "diciannove": 19, "venti": 20, "venticinque": 25, "trenta": 30, "quaranta": 40,
    "quarantacinque": 45, "cinquanta": 50, "sessanta": 60, "novanta": 90,
    # English
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20,
    "twenty-five": 25, "thirty": 30, "forty": 40, "forty-five": 45, "fifty": 50, "sixty": 60, "ninety": 90,
}
_NUMBER = r"(?:\d+(?:[.,]\d+)?|" + "|".join(sorted((re.escape(k) for k in _NUMBERS), key=len, reverse=True)) + r")"
_UNITS = {
    "s": 1, "sec": 1, "secs": 1, "secondo": 1, "secondi": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "mins": 60, "minuto": 60, "minuti": 60, "minute": 60, "minutes": 60,
    "h": 3600, "ora": 3600, "ore": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    "giorno": 86400, "giorni": 86400, "day": 86400, "days": 86400,
    "settimana": 604800, "settimane": 604800, "week": 604800, "weeks": 604800,
}
_UNIT = r"(?:" + "|".join(sorted(_UNITS, key=len, reverse=True)) + r")"
_SPECIAL = (
    (r"un'?\s?ora e mezz[ao]|an hour and a half|one and a half hours?", 5400),
    (r"mezz'?\s?ora|mezzora|half an hour|half hour", 1800),
    (r"un quarto d'?\s?ora|a quarter of an hour|quarter of an hour|quarter hour", 900),
)
_AMOUNT = r"(?<![\w'])" + _NUMBER + r"\s*" + _UNIT + r"\b"
#: A duration: "5 minuti", "un'ora e mezza", "2 ore e 10 minuti", "1h 30m".
_DURATION_CORE = (
    r"(?:" + "|".join(p for p, _ in _SPECIAL) + r"|"
    + _AMOUNT + r"(?:\s*(?:e|and|,)?\s*(?:mezz[ao]\b|" + _AMOUNT + r"))*)"
)
_DURATION = re.compile(r"(?P<dur>" + _DURATION_CORE + r")", re.IGNORECASE)
_RELATIVE = re.compile(r"\b(?:tra|fra|in|entro|within)\s+(?P<rel>" + _DURATION_CORE + r")", re.IGNORECASE)


def _number(token: str) -> float:
    token = token.strip().lower()
    if token in _NUMBERS:
        return float(_NUMBERS[token])
    return float(token.replace(",", "."))


def parse_duration(text: str) -> float | None:
    """Seconds of a duration written in words or digits, ``None`` if there isn't one."""
    lowered = " ".join(text.lower().split())
    for pattern, seconds in _SPECIAL:
        if re.fullmatch(pattern, lowered):
            return float(seconds)
    total = 0.0
    found = False
    for number, unit in re.findall(r"(?<![\w'])(" + _NUMBER + r")\s*(" + _UNIT + r")\b", lowered):
        total += _number(number) * _UNITS[unit]
        found = True
    if found and re.search(r"\be mezz[ao]\b", lowered):
        total += 1800 if re.search(r"\b(?:ora|ore)\b", lowered) else 30
    return total if found and total > 0 else None


# ---------------------------------------------------------------------------
# Times and dates
# ---------------------------------------------------------------------------
_MONTHS = {
    "gennaio": 1, "febbraio": 2, "marzo": 3, "aprile": 4, "maggio": 5, "giugno": 6, "luglio": 7,
    "agosto": 8, "settembre": 9, "ottobre": 10, "novembre": 11, "dicembre": 12,
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7,
    "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}
_MONTH = r"(?:" + "|".join(_MONTHS) + r")"
_WEEKDAYS = {
    "lunedi": 0, "lunedì": 0, "martedi": 1, "martedì": 1, "mercoledi": 2, "mercoledì": 2, "giovedi": 3,
    "giovedì": 3, "venerdi": 4, "venerdì": 4, "sabato": 5, "domenica": 6,
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6,
}
_WEEKDAY = r"(?:" + "|".join(sorted(_WEEKDAYS, key=len, reverse=True)) + r")"

_DATE = re.compile(
    r"(?P<word>\b(?:oggi|today|stasera|tonight|stanotte|domani|tomorrow|dopodomani|the day after tomorrow)\b)"
    r"|(?:\b(?:il|del|per il|on|the)\s+)?\b(?P<d1>\d{1,2})[/-](?P<m1>\d{1,2})(?:[/-](?P<y1>\d{2,4}))?\b"
    r"|(?:\b(?:il|del|per il|on)\s+)?\b(?P<iso>\d{4}-\d{2}-\d{2})\b"
    r"|(?:\b(?:il|del|per il|on|on the|the)\s+)?\b(?P<d2>\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<m2>" + _MONTH + r")\b(?:,?\s+(?P<y2>\d{4}))?"
    r"|(?:\bon\s+)?\b(?P<m3>" + _MONTH + r")\s+(?P<d3>\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(?P<y3>\d{4}))?"
    r"|(?:\b(?:next|prossimo|this|questo|on)\s+)?\b(?P<wd>" + _WEEKDAY + r")\b(?:\s+prossimo)?"
    # "il 31", "entro il 5": only the day of the month (after all the others, which have the month too).
    r"|\b(?:il|del|per il|entro il|on the)\s+(?P<d4>\d{1,2})(?:st|nd|rd|th)?\b(?![/.:,]\d|\s*(?:%|°|ore\b|minut|second))",
    re.IGNORECASE,
)

_TIME = re.compile(
    r"\b(?:a|at)\s+(?P<word>mezzogiorno|mezzanotte|noon|midnight)\b"
    r"|(?P<una>\ball'una)\b(?:\s+e\s+(?P<frac1>mezza|un quarto|\d{1,2}))?"
    r"|(?:\b(?:alle|alla|verso le|entro le|at|by|around)\s+)(?P<h>\d{1,2})"
    r"(?:[:.](?P<mm>\d{2})|\s+e\s+(?P<frac>mezza|un quarto|trenta|quindici|\d{1,2})\b)?"
    r"(?:\s*(?P<ampm>am|pm|a\.m\.|p\.m\.))?"
    r"(?P<tail>)(?!\s*(?:" + _UNIT + r"\b|%|/|\d))"
    r"|\b(?P<h2>\d{1,2})(?::(?P<mm2>\d{2}))?\s*(?P<ampm2>am|pm)\b",
    re.IGNORECASE,
)
_PART_OF_DAY = re.compile(
    r"\b(?:di|del|della|in the)\s+(?P<part>mattina|mattino|pomeriggio|sera|notte|morning|afternoon|evening)\b|\bat night\b",
    re.IGNORECASE,
)


def _make_date(day: int, month: int, year: str | None, today: date) -> date | None:
    try:
        if year:
            value = int(year)
            return date(value + 2000 if value < 100 else value, month, day)
        candidate = date(today.year, month, day)
        return candidate if candidate >= today else date(today.year + 1, month, day)
    except ValueError:
        return None


def _resolve_date(match: re.Match, today: date, lang: str) -> date | None:
    word = (match.group("word") or "").lower()
    if word:
        if word in ("dopodomani", "the day after tomorrow"):
            return today + timedelta(days=2)
        if word in ("domani", "tomorrow"):
            return today + timedelta(days=1)
        return today
    if match.group("iso"):
        try:
            return date.fromisoformat(match.group("iso"))
        except ValueError:
            return None
    if match.group("d1"):
        first, second = int(match.group("d1")), int(match.group("m1"))
        day, month = (second, first) if lang == "en" and first <= 12 else (first, second)
        return _make_date(day, month, match.group("y1"), today)
    if match.group("d2"):
        return _make_date(int(match.group("d2")), _MONTHS[match.group("m2").lower()], match.group("y2"), today)
    if match.group("d3"):
        return _make_date(int(match.group("d3")), _MONTHS[match.group("m3").lower()], match.group("y3"), today)
    if match.group("wd"):
        target = _WEEKDAYS[match.group("wd").lower()]
        ahead = (target - today.weekday()) % 7 or 7
        return today + timedelta(days=ahead)
    if match.group("d4"):
        # The next month that has that day: "il 31" at the end of September is 31 October.
        day = int(match.group("d4"))
        for ahead in range(13):
            month, year = (today.month - 1 + ahead) % 12 + 1, today.year + (today.month - 1 + ahead) // 12
            with contextlib.suppress(ValueError):
                candidate = date(year, month, day)
                if candidate >= today:
                    return candidate
        return None
    return None


def _resolve_time(match: re.Match, text: str) -> tuple[int, int] | None:
    word = (match.group("word") or "").lower()
    if word in ("mezzogiorno", "noon"):
        return 12, 0
    if word in ("mezzanotte", "midnight"):
        return 0, 0
    if match.group("una"):
        hour, minute_text, frac = 1, None, (match.group("frac1") or "").lower()
    else:
        hour_text = match.group("h") or match.group("h2")
        if hour_text is None:
            return None
        hour = int(hour_text)
        minute_text = match.group("mm") or match.group("mm2")
        frac = (match.group("frac") or "").lower()
    minute = int(minute_text or 0)
    if frac:
        minute = {"mezza": 30, "un quarto": 15, "trenta": 30, "quindici": 15}.get(frac) or int(frac)
    ampm = (match.group("ampm") or match.group("ampm2") or "").lower().replace(".", "")
    part_match = _PART_OF_DAY.search(text[match.end() : match.end() + 30])
    part = (part_match.group("part") or "night").lower() if part_match else ""
    if ampm == "pm" or part in ("pomeriggio", "sera", "afternoon", "evening"):
        if hour < 12:
            hour += 12
    if part in ("notte", "night") and hour >= 7 and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    return hour, minute


def _first(pattern: re.Pattern, text: str, resolve) -> tuple[Any, re.Match] | tuple[None, None]:
    """The first occurrence that really makes sense (not "12.30" as a date)."""
    for match in pattern.finditer(text):
        value = resolve(match)
        if value is not None:
            return value, match
    return None, None


# ---------------------------------------------------------------------------
# Natural-language requests
# ---------------------------------------------------------------------------
@dataclass
class Request:
    kind: str
    due: datetime
    text: str = ""
    repeat: str = ""
    duration: float = 0.0
    language: str = "it"

    def to_reminder(self) -> Reminder:
        return Reminder(
            kind=self.kind,
            due=self.due.timestamp(),
            text=self.text,
            repeat=self.repeat,
            duration=self.duration,
            language=self.language,
        )


_TIMER = re.compile(r"\btimer\b|\bcronometro\b|\bcountdown\b|\bconto alla rovescia\b", re.IGNORECASE)
_ALARM = re.compile(r"\b(?:sveglia|svegliami|wake me(?: up)?|alarm)\b", re.IGNORECASE)
#: They explicitly ask for a reminder: a date is enough ("domani" = at 9).
_REMIND_STRONG = re.compile(
    r"\b(?:ricordami|ricordarmi|rammentami|avvisami|promemoria|remind me|reminder)\b", re.IGNORECASE
)
#: "Aggiungi al calendario...", "mettimi in agenda...": the Agenda is these
#: reminders, so it counts as much as a "ricordami".
_AGENDA_ADD = re.compile(
    r"\b(?:aggiung(?:i|ere|imi|ilo|ila|ili|ile)|mett(?:i|ere|imi|ilo|ila|ili|ile)|segn(?:a|are|ami|alo|ala|ali|ale)|"
    r"inserisc(?:i|ilo|ila)|inserire|add|put|schedule)\b[^.?!\n]{0,60}?\b(?:agenda|calendario|calendar)\b",
    re.IGNORECASE,
)
#: "Aggiungi il 31 cinema con Giulia", "segna giovedì dentista": at the start of the sentence it's an order.
_ADD_FIRST = re.compile(
    r"^\s*(?:(?:ehi|tsukumo|per favore|puoi|potresti|mi)[\s,]+)*"
    r"(?:aggiungi|aggiungimi|segna|segnami|segnati|annota|annotami|appunta|appuntami|aggiungere|segnare|annotare|"
    r"appuntare|add|note down|put)\b",
    re.IGNORECASE,
)
#: ...but "come aggiungo un evento al calendario domani?" is a question, not a request.
_QUESTION = re.compile(r"^\s*(?:come|perch[eé]|dove|how|why|where)\b", re.IGNORECASE)
#: They imply it: a precise time or "in how long" is needed.
_REMIND_WEAK = re.compile(
    r"\b(?:dimmi|fammi sapere|devo|dovrò|dovro|ho da|let me know|tell me)\b|\bI (?:have to|need to|must|gotta)\b",
    re.IGNORECASE,
)
_ENGLISH_HINTS = re.compile(
    r"\b(?:remind|reminder|timer for|set a|in \d+|minutes?|hours?|seconds?|tomorrow|wake me|at \d|I have to|I need to|"
    r"every day|today|tonight|the|my|what|how|please|cancel|delete|left)\b",
    re.IGNORECASE,
)
_ITALIAN_HINTS = re.compile(
    r"\b(?:ricordami|tra|fra|minut[oi]|or[ae]|second[oi]|domani|alle|sveglia|devo|dimmi|di|ogni giorno|oggi|stasera|"
    r"calendario|aggiungi)\b",
    re.IGNORECASE,
)
_DAILY = re.compile(
    r"\b(?:ogni giorno|tutti i giorni|ogni mattina|ogni sera|every day|everyday|daily|every morning|every evening)\b",
    re.IGNORECASE,
)
_COMMAND_WORDS_IT = re.compile(
    r"\b(?:ricordami|ricordarmi|rammentami|avvisami|promemoria|dimmi|fammi sapere|timer|cronometro|sveglia|svegliami|"
    r"conto alla rovescia|per favore|perfavore|grazie|puoi|potresti|metti|mettimi|imposta|impostami|fai partire|avvia|"
    r"crea|segna|segnati|segnalo|segnala|segnami|aggiungi|aggiungimi|aggiungilo|aggiungila|mettilo|mettila|inserisci|"
    r"annota|annotami|appunta|appuntami|aggiungere|segnare|annotare|appuntare|un evento|(?:all'|in |nell'|sull')agenda|(?:al|nel|in|sul) calendario)\b",
    re.IGNORECASE,
)
_COMMAND_WORDS_EN = re.compile(
    r"\b(?:please|can you|could you|would you|set(?: me)?(?: up)?|start|create|add|remind me|reminder|let me know|tell me|"
    r"timer|alarm|wake me(?: up)?|countdown|put|schedule|an event|(?:to|in|on) (?:my|the) (?:agenda|calendar))\b",
    re.IGNORECASE,
)
#: Between two days of a list: "giovedì, venerdì e sabato", "domani and Friday".
_LIST_GAP = re.compile(r"[\s,/&]*(?:(?:e|ed|and|poi)\b[\s,]*)?", re.IGNORECASE)
_LEADING_IT = re.compile(r"^(?:(?:di|a|ad|per|un|uno|una|e|poi|,|:|-)\s+)+", re.IGNORECASE)
_LEADING_EN = re.compile(r"^(?:(?:to|me|for|of|and|then|a|an|,|:|-)\s+)+", re.IGNORECASE)
_TRAILING = re.compile(r"\s+(?:di|per|a|alle|e|to|for|at|and|the|il|la)$", re.IGNORECASE)


def detect_language(text: str) -> str:
    italian = len(_ITALIAN_HINTS.findall(text))
    english = len(_ENGLISH_HINTS.findall(text))
    return "en" if english > italian else "it"


def _part_of_day_span(raw: str, time_match: re.Match) -> list[tuple[int, int]]:
    """ "alle 9 di sera": the words after the time belong to the time, not to the reminder text."""
    part = _PART_OF_DAY.search(raw[time_match.end() : time_match.end() + 30])
    return [(time_match.end() + part.start(), time_match.end() + part.end())] if part else []


def parse_request(text: str, now: datetime | None = None, explicit: bool = False) -> Request | None:
    """A timer, reminder or alarm request, if the text is one (the first, if there are several days)."""
    requests = parse_requests(text, now, explicit)
    return requests[0] if requests else None


def parse_requests(text: str, now: datetime | None = None, explicit: bool = False) -> list[Request]:
    """Like ``parse_request``, but "giovedì, venerdì e sabato alle 9" makes three reminders.

    ``explicit``: the text is already a request (the Agenda's field), so a date
    is enough, as after a "ricordami".
    """
    now = (now or datetime.now()).replace(microsecond=0)
    raw = " ".join(text.strip().split())
    if not raw or len(raw) > 300:
        return []
    lang = detect_language(raw)
    is_timer = bool(_TIMER.search(raw))
    is_alarm = bool(_ALARM.search(raw)) and not is_timer
    asked = bool(_AGENDA_ADD.search(raw) or _ADD_FIRST.match(raw)) and not _QUESTION.match(raw)
    strong = explicit or bool(_REMIND_STRONG.search(raw)) or asked
    weak = bool(_REMIND_WEAK.search(raw))
    if not (is_timer or is_alarm or strong or weak):
        return []

    spans: list[tuple[int, int]] = []
    dues: list[datetime] = []
    duration = 0.0

    relative = _RELATIVE.search(raw)
    if relative and (seconds := parse_duration(relative.group("rel"))):
        duration = seconds
        due = now + timedelta(seconds=seconds)
        spans.append(relative.span())
        # "tra 2 giorni alle 10": the "tra" gives the day, the time gives the hour.
        if not is_timer and seconds % 86400 == 0:
            clock, time_match = _first(_TIME, raw, lambda match: _resolve_time(match, raw))
            if clock is not None and (time_match.start() >= relative.end() or time_match.end() <= relative.start()):
                due = due.replace(hour=clock[0], minute=clock[1], second=0, microsecond=0)
                spans.append(time_match.span())
                spans.extend(_part_of_day_span(raw, time_match))
        dues = [due]
    if is_timer and not dues:
        # "timer di 5 minuti", "set a timer for 10 minutes", "timer 25 min"
        found = _DURATION.search(raw)
        if found and (seconds := parse_duration(found.group("dur"))):
            duration = seconds
            dues = [now + timedelta(seconds=seconds)]
            spans.append(found.span())
    if is_timer and not dues:
        return []

    repeat = ""
    daily = _DAILY.search(raw)
    if daily:
        repeat = "daily"
        spans.append(daily.span())

    if not dues:
        clock, time_match = _first(_TIME, raw, lambda match: _resolve_time(match, raw))
        days = _date_list(raw, now.date(), lang)
        if clock is None and (not days or not (strong or is_alarm)):
            return []
        if time_match:
            spans.append(time_match.span())
            spans.extend(_part_of_day_span(raw, time_match))
        spans.extend(match.span() for _, match in days)
        hour, minute = clock if clock else (9, 0)
        if days and re.fullmatch(r"stasera|tonight", days[0][1].group(0).strip(), re.IGNORECASE) and hour < 12:
            hour += 12
        if not days:
            due = now.replace(hour=hour, minute=minute, second=0)
            dues = [due + timedelta(days=1) if due <= now else due]
        else:
            # Every day already repeats by itself: the first is enough.
            listed = days[:1] if repeat else days
            moments = {datetime.combine(day, datetime.min.time()).replace(hour=hour, minute=minute) for day, _ in listed}
            dues = sorted(moment for moment in moments if moment > now)
            if not dues:
                return []

    kind = "timer" if is_timer else "alarm" if is_alarm else "reminder"
    left = _leftover(raw, spans, lang)
    return [
        Request(kind=kind, due=due, text=left, repeat=repeat, duration=duration if kind == "timer" else 0.0, language=lang)
        for due in dues
    ]


def _date_list(raw: str, today: date, lang: str) -> list[tuple[date, re.Match]]:
    """The first valid date, plus those listed right after ("giovedì, venerdì e sabato").

    A date further on in the sentence is part of the thing to remember
    ("domani ricordami di preparare la riunione di lunedì"), not of the list.
    """
    found: list[tuple[date, re.Match]] = []
    for match in _DATE.finditer(raw):
        value = _resolve_date(match, today, lang)
        if value is None:
            continue
        if found and not _LIST_GAP.fullmatch(raw[found[-1][1].end() : match.start()]):
            break
        found.append((value, match))
    return found


def _leftover(raw: str, spans: list[tuple[int, int]], lang: str) -> str:
    """What's left once times, dates and command words are removed: the thing to remember."""
    chars = list(raw)
    for start, end in spans:
        for index in range(start, end):
            chars[index] = " "
    text = "".join(chars)
    text = (_COMMAND_WORDS_EN if lang == "en" else _COMMAND_WORDS_IT).sub(" ", text)
    if lang == "it":
        # "mi" of "ricordami"/"mettimi" already removed; here the standalone one ("mi ricordi di...").
        text = re.sub(r"^\s*mi\s+", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[?!.;]+", " ", text)
    text = " ".join(text.split()).strip(" ,:-")
    leading = _LEADING_EN if lang == "en" else _LEADING_IT
    for _ in range(4):
        text = leading.sub("", text + " ").strip(" ,:-")
        text = _TRAILING.sub("", text).strip(" ,:-")
    return text


# ---------------------------------------------------------------------------
# The brain's tags: [[remind {...}]]
# ---------------------------------------------------------------------------
_TAG = re.compile(r"\[\[\s*remind\s+(\{.*?\})\s*\]\]", re.DOTALL)


class TagFilter:
    """Removes the ``[[...]]`` tags from text that arrives in pieces.

    The brain may split them between one chunk and the next: whatever could be
    the start of a tag is kept aside until it's clear.
    """

    def __init__(self) -> None:
        self._pending = ""
        self.tags: list[str] = []

    def feed(self, piece: str) -> str:
        text = self._pending + piece
        self._pending = ""
        visible: list[str] = []
        while text:
            start = text.find("[[")
            if start < 0:
                if text.endswith("["):
                    visible.append(text[:-1])
                    self._pending = "["
                else:
                    visible.append(text)
                break
            visible.append(text[:start])
            end = text.find("]]", start)
            if end < 0:
                self._pending = text[start:]
                break
            self.tags.append(text[start : end + 2])
            text = text[end + 2 :]
        return "".join(visible)

    def flush(self) -> str:
        """End of the reply: a tag never closed is dropped, a lone "[" isn't."""
        rest, self._pending = self._pending, ""
        return rest if rest == "[" else ""


def from_tag(tag: str, now: datetime | None = None, language: str = "it") -> Reminder | None:
    """``[[remind {"at": "...", "text": "..."}]]`` -> reminder (or ``None`` if it isn't valid)."""
    now = now or datetime.now()
    found = _TAG.search(tag)
    if not found:
        return None
    try:
        data = json.loads(found.group(1))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    due: datetime | None = None
    if data.get("in") is not None:
        try:
            due = now + timedelta(seconds=float(data["in"]))
        except (TypeError, ValueError):
            return None
    elif data.get("at"):
        try:
            due = datetime.fromisoformat(str(data["at"]).replace("Z", "+00:00"))
        except ValueError:
            return None
        if due.tzinfo is not None:
            due = due.astimezone().replace(tzinfo=None)
    if due is None or due <= now - timedelta(seconds=5):
        return None
    task = str(data.get("do") or "").strip()
    text = task or str(data.get("text") or "").strip()
    kind = "task" if task else str(data.get("kind") or "reminder")
    if kind not in KINDS:
        kind = "reminder"
    duration = float(data["in"]) if kind == "timer" and data.get("in") is not None else 0.0
    repeat = "daily" if str(data.get("repeat") or "").lower() in ("daily", "day", "every day") else ""
    return Reminder(kind=kind, due=due.timestamp(), text=text, repeat=repeat, duration=duration, language=language)


def action_directive(now: datetime | None = None) -> str:
    """What to tell the brain so it can schedule reminders and actions."""
    now = now or datetime.now()
    stamp = now.strftime("%A %Y-%m-%d %H:%M")
    example = now + timedelta(days=1)
    return (
        f"Local time: {stamp}. The user's agenda (the calendar in Tsukumo's panel, also on their phone) is made "
        "of these reminders, and this tag is how you add to it: never say you have no access to their calendar, "
        "and don't look for another calendar tool. If the user asks you to remind them of something, to set a "
        "timer or an alarm, to put an event, appointment or deadline in their agenda or calendar, or to do "
        "something at a later time, confirm in one short sentence and append at the very end "
        '[[remind {"at": "YYYY-MM-DDTHH:MM", "text": "what to remind"}]], one tag per day when it spans several days '
        '(no time given: 09:00; use "in": seconds instead of "at" for relative times, "do": "the task" instead of "text" for '
        'something you must do yourself then, "repeat": "daily" if it repeats). Never read or mention the tag. '
        f'Example: "aggiungi domani cinema con Giulia" -> reply "Segnato per domani!" and append '
        f'[[remind {{"at": "{example:%Y-%m-%d}T09:00", "text": "cinema con Giulia"}}]]. Writing the tag IS adding it to '
        "their calendar: it appears on the PC and on the phone at once, so never say you can't."
    )


# ---------------------------------------------------------------------------
# Phrases: confirmations, notices, commands
# ---------------------------------------------------------------------------
_MONTH_NAMES = {
    "it": ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
    "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
}
_UNIT_WORDS = {
    "it": (("un giorno", "giorni"), ("un'ora", "ore"), ("un minuto", "minuti"), ("un secondo", "secondi"), " e "),
    "en": (("one day", "days"), ("one hour", "hours"), ("one minute", "minutes"), ("one second", "seconds"), " and "),
}


def _lang(language: str | None) -> str:
    """The phrases exist in Italian and English: the other languages use English."""
    return "it" if language == "it" else "en"


def speak_duration(seconds: float, lang: str) -> str:
    """``200`` -> "3 minuti e 20 secondi" / "3 minutes and 20 seconds"."""
    words = _UNIT_WORDS[_lang(lang)]
    seconds = int(round(max(0, seconds)))
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    parts = [
        singular if value == 1 else f"{value} {plural}"
        for value, (singular, plural) in zip((days, hours, minutes, secs), words[:4])
        if value
    ]
    if not parts:
        return f"0 {words[3][1]}"
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + words[4] + parts[-1]


def speak_when(due: float, lang: str, now: datetime | None = None) -> str:
    """When it goes off, said aloud: "in 20 minutes", "tomorrow at 9:00", "on 29 December at 12:00"."""
    lang = _lang(lang)
    now = now or datetime.now()
    moment = datetime.fromtimestamp(due)
    delta = moment - now
    clock = moment.strftime("%H:%M")
    if delta <= timedelta(hours=2):
        amount = speak_duration(max(1, delta.total_seconds()), lang)
        return f"tra {amount}" if lang == "it" else f"in {amount}"
    days = (moment.date() - now.date()).days
    if lang == "it":
        if days == 0:
            return f"alle {clock}"
        if days == 1:
            return f"domani alle {clock}"
        return f"il {moment.day} {_MONTH_NAMES['it'][moment.month - 1]} alle {clock}"
    if days == 0:
        return f"at {clock}"
    if days == 1:
        return f"tomorrow at {clock}"
    return f"on {_MONTH_NAMES['en'][moment.month - 1]} {moment.day} at {clock}"


_SWAP = {
    "it": {"devo": "devi", "dovrò": "dovrai", "dovro": "dovrai", "ho": "hai", "mio": "tuo", "mia": "tua", "miei": "tuoi", "mie": "tue", "mi": "ti", "me": "te"},
    "en": {"i": "you", "i'm": "you're", "my": "your", "mine": "yours", "me": "you", "am": "are", "i've": "you've", "myself": "yourself"},
}


def second_person(text: str, lang: str) -> str:
    """"devo chiamare mia madre" -> "devi chiamare tua madre" (she says the reminder to you)."""
    table = _SWAP[_lang(lang)]

    def swap(match: re.Match) -> str:
        word = match.group(0)
        replacement = table.get(word.lower(), word)
        return replacement[:1].upper() + replacement[1:] if word[:1].isupper() and word.lower() != "i" else replacement

    return re.sub(r"[\w']+", swap, text)


def _about(text: str, lang: str) -> str:
    """How the thing to remember is attached: "di chiamare", "del dentista", "che devi..."."""
    if not text:
        return ""
    if lang == "en":
        if re.match(r"(?:you|about|that)\b", text, re.IGNORECASE):
            return f" {text}" if not text.lower().startswith("you") else f" that {text}"
        return f" to {text}"
    if re.match(r"(?:del|della|dello|dei|degli|delle|dell'|che)\b", text, re.IGNORECASE):
        return f" {text}"
    if re.match(r"(?:devi|dovrai|hai|sei|ti)\b", text, re.IGNORECASE):
        return f" che {text}"
    return f" di {text}"


def describe(reminder: Reminder) -> str:
    """A line for the panel: "Timer 5 minutes", "Reminder: call Marco"."""
    lang = _lang(reminder.language)
    text = reminder.text
    if reminder.kind == "timer":
        base = f"Timer {speak_duration(reminder.duration, lang)}" if reminder.duration else "Timer"
        return f"{base}: {text}" if text else base
    names = {
        "it": {"reminder": "Promemoria", "alarm": "Sveglia", "task": "Azione"},
        "en": {"reminder": "Reminder", "alarm": "Alarm", "task": "Task"},
    }
    base = names[lang].get(reminder.kind, reminder.kind)
    return f"{base}: {text}" if text else base


def confirmation(reminder: Reminder, now: datetime | None = None) -> str:
    """What she answers when she has taken note."""
    lang = _lang(reminder.language)
    when = speak_when(reminder.due, lang, now)
    about = _about(second_person(reminder.text, lang), lang)
    clock = datetime.fromtimestamp(reminder.due).strftime("%H:%M")
    daily = reminder.repeat == "daily"
    if lang == "en":
        if reminder.kind == "timer":
            return f"Okay, {speak_duration(reminder.duration, lang)} on the clock{' for ' + reminder.text if reminder.text else ''}. Starting now!"
        if reminder.kind == "alarm":
            return f"Alarm set {'every day at ' + clock if daily else when}."
        if reminder.kind == "task":
            return f"Got it, I'll take care of it {when}."
        if daily:
            return f"Sure, every day at {clock} I'll remind you{about}."
        return f"Sure, {when} I'll remind you{about}."
    if reminder.kind == "timer":
        return f"Ok, timer di {speak_duration(reminder.duration, lang)}{' per ' + reminder.text if reminder.text else ''}. Parte adesso!"
    if reminder.kind == "alarm":
        return f"Sveglia impostata {'ogni giorno alle ' + clock if daily else when}."
    if reminder.kind == "task":
        return f"Segnato, ci penso io {when}."
    if daily:
        return f"Va bene, ogni giorno alle {clock} ti ricordo{about}."
    return f"Va bene, {when} ti ricordo{about}."


_WEEKDAY_NAMES = {
    "it": ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"],
    "en": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
}


def confirmations(reminders: list[Reminder], now: datetime | None = None) -> str:
    """A single confirmation for several days: "Okay, Thursday 8, Friday 9 and Saturday 10 at 09:00 I'll remind you...".

    They all come from the same sentence: same time, same thing to remember.
    """
    if len(reminders) == 1:
        return confirmation(reminders[0], now)
    first = reminders[0]
    lang = _lang(first.language)
    moments = [datetime.fromtimestamp(item.due) for item in reminders]
    days = [f"{_WEEKDAY_NAMES[lang][moment.weekday()]} {moment.day}" for moment in moments]
    joined = ", ".join(days[:-1]) + _UNIT_WORDS[lang][4] + days[-1]
    clock = moments[0].strftime("%H:%M")
    about = _about(second_person(first.text, lang), lang)
    if lang == "en":
        if first.kind == "alarm":
            return f"Alarms set for {joined} at {clock}."
        return f"Sure, I'll remind you{about} on {joined} at {clock}."
    if first.kind == "alarm":
        return f"Sveglie impostate {joined} alle {clock}."
    return f"Va bene, {joined} alle {clock} ti ricordo{about}."


def announcement(reminder: Reminder, late: float = 0.0) -> str:
    """What she says when it goes off."""
    lang = _lang(reminder.language)
    about = _about(second_person(reminder.text, lang), lang)
    clock = datetime.fromtimestamp(reminder.due).strftime("%H:%M")
    is_late = late > 120
    if lang == "en":
        if reminder.kind == "timer":
            what = f"{speak_duration(reminder.duration, lang)}{' for ' + reminder.text if reminder.text else ''}"
            return f"Sorry I'm late: your timer of {what} is done!" if is_late else f"Time's up! That was {what}."
        if reminder.kind == "alarm":
            return f"Wake up! It's {clock}." if not reminder.text else f"It's {clock}: time{about}!"
        body = f"a reminder{about}!" if about else "it's the time you asked me to remind you about!"
        return f"Sorry I'm late, but {body}" if is_late else f"Hey, {body}"
    if reminder.kind == "timer":
        what = f"timer di {speak_duration(reminder.duration, lang)}{' per ' + reminder.text if reminder.text else ''}"
        return f"Scusa il ritardo: il {what} è finito!" if is_late else f"Il {what} è finito!"
    if reminder.kind == "alarm":
        return f"Sveglia! Sono le {clock}." if not reminder.text else f"Sono le {clock}: ti ricordo{about}!"
    body = f"ti ricordo{about}!" if about else "è l'ora che mi avevi chiesto!"
    return f"Scusa il ritardo, ma {body}" if is_late else f"Ehi, {body}"


def task_prompt(reminder: Reminder) -> str:
    """The scheduled task, as a message for the brain."""
    if reminder.language == "en":
        return f"(Scheduled task, it's time now) {reminder.text}. Do it and tell me briefly how it went."
    return f"(Azione programmata, è il momento) {reminder.text}. Falla e dimmi in breve com'è andata."


_CANCEL = re.compile(
    r"\b(?:annulla|cancella|elimina|togli|ferma|spegni|cancel|delete|remove|turn off|stop)\b.*?\b(?P<what>timer|promemoria|sveglia|sveglie|reminders?|alarms?)\b",
    re.IGNORECASE,
)
_REMAINING = re.compile(
    r"\bquanto manca\b|\bquanto tempo (?:manca|resta)\b|\bhow (?:much time|long)(?: is)? left\b|\btime left\b",
    re.IGNORECASE,
)
_LIST = re.compile(
    r"\b(?:che|quali|quanti) (?:promemoria|timer|sveglie)\b|\bi miei promemoria\b|\bmy reminders\b|\bwhat reminders\b|\bany reminders\b",
    re.IGNORECASE,
)


def command_reply(text: str, store: ReminderStore, now: datetime | None = None) -> tuple[str, bool] | None:
    """Cancel, "how long left", list. ``(reply, changed)`` or ``None`` if it isn't a command."""
    now = now or datetime.now()
    lang = detect_language(text)
    cancel = _CANCEL.search(text)
    if cancel:
        what = cancel.group("what").lower().rstrip("s")
        kinds = {"timer": ("timer",), "svegli": ("alarm",), "sveglia": ("alarm",), "alarm": ("alarm",)}.get(what, ("reminder", "task"))
        everything = re.search(r"\b(?:tutti|tutte|all)\b", text, re.IGNORECASE)
        latest = store.latest(kinds)
        targets = [item for item in store.all() if item.kind in kinds] if everything else ([latest] if latest else [])
        if not targets:
            return ("Non c'è niente da annullare." if lang == "it" else "There's nothing to cancel."), False
        for item in targets:
            store.remove(item.id)
        if len(targets) > 1:
            return (f"Fatto, ne ho annullati {len(targets)}." if lang == "it" else f"Done, I cancelled {len(targets)} of them."), True
        label = describe(targets[0])
        return (f"Fatto, ho annullato: {label}." if lang == "it" else f"Done, cancelled: {label}."), True
    if _REMAINING.search(text):
        item = store.latest(("timer",)) or next(iter(store.all()), None)
        if not item:
            return ("Non c'è nessun timer in corso." if lang == "it" else "There's no timer running."), False
        left = speak_duration(item.due - now.timestamp(), lang)
        return (f"Mancano {left}." if lang == "it" else f"{left} left."), False
    if _LIST.search(text):
        items = store.all()
        if not items:
            return ("Non hai promemoria." if lang == "it" else "You have no reminders."), False
        parts = [f"{describe(item)}, {speak_when(item.due, lang, now)}" for item in items[:4]]
        more = len(items) - len(parts)
        tail = (f"; e altri {more}" if lang == "it" else f"; and {more} more") if more > 0 else ""
        return "; ".join(parts) + tail + ".", False
    return None
