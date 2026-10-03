"""Timer, promemoria, sveglie e azioni programmate: la parte "Alexa" del companion.

"Timer di 5 minuti", "ricordami di chiamare Marco tra mezz'ora", "il 29/12
alle 12 ricordami del dentista", "ogni giorno alle 9 ricordami di bere",
"remind me to stretch in 20 minutes": le richieste piu' comuni (in italiano e
in inglese) si capiscono qui, senza il cervello. Sono immediate e funzionano
anche col risponditore offline.

Tutto il resto lo capisce il cervello: gli si chiede (``action_directive``) di
aggiungere in fondo alla risposta un'etichetta ``[[remind {...}]]``, che il
pipeline toglie dal testo prima di leggerlo (``TagFilter``) e trasforma in un
promemoria (``from_tag``). Con ``"do"`` al posto di ``"text"`` e' un'azione:
all'ora giusta il testo va al cervello come un compito da svolgere.

I promemoria stanno in ``state/reminders.json``: sopravvivono ai riavvii, e
quelli scaduti mentre il PC era spento vengono detti al ritorno.
"""

from __future__ import annotations

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

#: Oltre questo ritardo un promemoria perso (PC spento) non si dice piu'.
MAX_LATE = 12 * 3600


# ---------------------------------------------------------------------------
# Modello e archivio
# ---------------------------------------------------------------------------
@dataclass
class Reminder:
    kind: str
    #: Istante in cui scatta (``time.time()``).
    due: float
    #: Cosa ricordare ("chiamare Marco"), cosa fare (``task``), o a cosa serve il timer.
    text: str = ""
    #: "" oppure "daily".
    repeat: str = ""
    #: Timer: durata totale in secondi ("il timer di 5 minuti e' finito").
    duration: float = 0.0
    #: Lingua in cui e' stato chiesto: in quella si conferma e si avvisa.
    language: str = "it"
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    created: float = field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["dueIso"] = datetime.fromtimestamp(self.due).isoformat(timespec="seconds")
        data["label"] = describe(self)
        return data


class ReminderStore:
    """I promemoria in attesa, salvati su disco a ogni modifica."""

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
            logger.warning("Promemoria non leggibili da %s: %s", self.path, exc)

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
            logger.warning("Promemoria non salvati in %s: %s", self.path, exc)

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
        """E' scattato: si toglie, o si sposta al giorno dopo se si ripete."""
        now = time.time() if now is None else now
        if reminder.repeat == "daily":
            # Stessa ora *sul tuo orologio*, non 86400 secondi dopo: col cambio
            # dell'ora una sveglia delle 7 scatterebbe alle 6 (o alle 8).
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
        """L'ultimo creato fra quelli di questi tipi ("annulla il timer")."""
        items = [item for item in self.all() if item.kind in kinds]
        return max(items, key=lambda item: item.created) if items else None


# ---------------------------------------------------------------------------
# Numeri e durate
# ---------------------------------------------------------------------------
_NUMBERS = {
    # italiano
    "un": 1, "uno": 1, "una": 1, "un'": 1, "due": 2, "tre": 3, "quattro": 4, "cinque": 5, "sei": 6,
    "sette": 7, "otto": 8, "nove": 9, "dieci": 10, "undici": 11, "dodici": 12, "tredici": 13,
    "quattordici": 14, "quindici": 15, "sedici": 16, "diciassette": 17, "diciotto": 18,
    "diciannove": 19, "venti": 20, "venticinque": 25, "trenta": 30, "quaranta": 40,
    "quarantacinque": 45, "cinquanta": 50, "sessanta": 60, "novanta": 90,
    # inglese
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
}
_UNIT = r"(?:" + "|".join(sorted(_UNITS, key=len, reverse=True)) + r")"
_SPECIAL = (
    (r"un'?\s?ora e mezz[ao]|an hour and a half|one and a half hours?", 5400),
    (r"mezz'?\s?ora|mezzora|half an hour|half hour", 1800),
    (r"un quarto d'?\s?ora|a quarter of an hour|quarter of an hour|quarter hour", 900),
)
_AMOUNT = r"(?<![\w'])" + _NUMBER + r"\s*" + _UNIT + r"\b"
#: Una durata: "5 minuti", "un'ora e mezza", "2 ore e 10 minuti", "1h 30m".
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
    """Secondi di una durata scritta a parole o in cifre, ``None`` se non c'e'."""
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
# Orari e date
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
    r"|(?:\b(?:next|prossimo|this|questo|on)\s+)?\b(?P<wd>" + _WEEKDAY + r")\b(?:\s+prossimo)?",
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
    """La prima occorrenza che ha davvero senso (non "12.30" come data)."""
    for match in pattern.finditer(text):
        value = resolve(match)
        if value is not None:
            return value, match
    return None, None


# ---------------------------------------------------------------------------
# Richieste in linguaggio naturale
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
#: Chiedono esplicitamente un promemoria: basta una data ("domani" = alle 9).
_REMIND_STRONG = re.compile(
    r"\b(?:ricordami|ricordarmi|rammentami|avvisami|promemoria|remind me|reminder)\b", re.IGNORECASE
)
#: Lo lasciano intendere: serve un orario o un "tra quanto" preciso.
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
    r"\b(?:ricordami|tra|fra|minut[oi]|or[ae]|second[oi]|domani|alle|sveglia|devo|dimmi|di|ogni giorno|oggi|stasera)\b",
    re.IGNORECASE,
)
_DAILY = re.compile(
    r"\b(?:ogni giorno|tutti i giorni|ogni mattina|ogni sera|every day|everyday|daily|every morning|every evening)\b",
    re.IGNORECASE,
)
_COMMAND_WORDS_IT = re.compile(
    r"\b(?:ricordami|ricordarmi|rammentami|avvisami|promemoria|dimmi|fammi sapere|timer|cronometro|sveglia|svegliami|"
    r"conto alla rovescia|per favore|perfavore|grazie|puoi|potresti|metti|mettimi|imposta|impostami|fai partire|avvia|"
    r"crea|segna|segnati)\b",
    re.IGNORECASE,
)
_COMMAND_WORDS_EN = re.compile(
    r"\b(?:please|can you|could you|would you|set(?: me)?(?: up)?|start|create|add|remind me|reminder|let me know|tell me|"
    r"timer|alarm|wake me(?: up)?|countdown)\b",
    re.IGNORECASE,
)
_LEADING_IT = re.compile(r"^(?:(?:di|a|ad|per|un|uno|una|e|poi|,|:|-)\s+)+", re.IGNORECASE)
_LEADING_EN = re.compile(r"^(?:(?:to|me|for|of|and|then|a|an|,|:|-)\s+)+", re.IGNORECASE)
_TRAILING = re.compile(r"\s+(?:di|per|a|alle|e|to|for|at|and|the|il|la)$", re.IGNORECASE)


def detect_language(text: str) -> str:
    italian = len(_ITALIAN_HINTS.findall(text))
    english = len(_ENGLISH_HINTS.findall(text))
    return "en" if english > italian else "it"


def parse_request(text: str, now: datetime | None = None) -> Request | None:
    """Una richiesta di timer, promemoria o sveglia, se il testo lo e'."""
    now = (now or datetime.now()).replace(microsecond=0)
    raw = " ".join(text.strip().split())
    if not raw or len(raw) > 300:
        return None
    lang = detect_language(raw)
    is_timer = bool(_TIMER.search(raw))
    is_alarm = bool(_ALARM.search(raw)) and not is_timer
    strong = bool(_REMIND_STRONG.search(raw))
    weak = bool(_REMIND_WEAK.search(raw))
    if not (is_timer or is_alarm or strong or weak):
        return None

    spans: list[tuple[int, int]] = []
    due: datetime | None = None
    duration = 0.0

    relative = _RELATIVE.search(raw)
    if relative and (seconds := parse_duration(relative.group("rel"))):
        duration = seconds
        due = now + timedelta(seconds=seconds)
        spans.append(relative.span())
    if is_timer and due is None:
        # "timer di 5 minuti", "set a timer for 10 minutes", "timer 25 min"
        found = _DURATION.search(raw)
        if found and (seconds := parse_duration(found.group("dur"))):
            duration = seconds
            due = now + timedelta(seconds=seconds)
            spans.append(found.span())
    if is_timer and due is None:
        return None

    repeat = ""
    daily = _DAILY.search(raw)
    if daily:
        repeat = "daily"
        spans.append(daily.span())

    if due is None:
        clock, time_match = _first(_TIME, raw, lambda match: _resolve_time(match, raw))
        day, date_match = _first(_DATE, raw, lambda match: _resolve_date(match, now.date(), lang))
        if clock is None and (day is None or not (strong or is_alarm)):
            return None
        if time_match:
            spans.append(time_match.span())
            part = _PART_OF_DAY.search(raw[time_match.end() : time_match.end() + 30])
            if part:
                spans.append((time_match.end() + part.start(), time_match.end() + part.end()))
        if date_match:
            spans.append(date_match.span())
        hour, minute = clock if clock else (9, 0)
        if date_match and re.fullmatch(r"stasera|tonight", date_match.group(0).strip(), re.IGNORECASE) and hour < 12:
            hour += 12
        if day is None:
            due = now.replace(hour=hour, minute=minute, second=0)
            if due <= now:
                due += timedelta(days=1)
        else:
            due = datetime.combine(day, datetime.min.time()).replace(hour=hour, minute=minute)
            if due <= now:
                return None

    kind = "timer" if is_timer else "alarm" if is_alarm else "reminder"
    left = _leftover(raw, spans, lang)
    return Request(kind=kind, due=due, text=left, repeat=repeat, duration=duration if kind == "timer" else 0.0, language=lang)


def _leftover(raw: str, spans: list[tuple[int, int]], lang: str) -> str:
    """Quello che resta tolti orari, date e parole di comando: la cosa da ricordare."""
    chars = list(raw)
    for start, end in spans:
        for index in range(start, end):
            chars[index] = " "
    text = "".join(chars)
    text = (_COMMAND_WORDS_EN if lang == "en" else _COMMAND_WORDS_IT).sub(" ", text)
    if lang == "it":
        # "mi" di "ricordami"/"mettimi" gia' tolto; qui quello isolato ("mi ricordi di...").
        text = re.sub(r"^\s*mi\s+", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[?!.;]+", " ", text)
    text = " ".join(text.split()).strip(" ,:-")
    leading = _LEADING_EN if lang == "en" else _LEADING_IT
    for _ in range(4):
        text = leading.sub("", text + " ").strip(" ,:-")
        text = _TRAILING.sub("", text).strip(" ,:-")
    return text


# ---------------------------------------------------------------------------
# Etichette del cervello: [[remind {...}]]
# ---------------------------------------------------------------------------
_TAG = re.compile(r"\[\[\s*remind\s+(\{.*?\})\s*\]\]", re.DOTALL)


class TagFilter:
    """Toglie le etichette ``[[...]]`` dal testo che arriva a pezzi.

    Il cervello puo' spezzarle fra un frammento e l'altro: quello che potrebbe
    essere l'inizio di un'etichetta resta da parte finche' non si capisce.
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
        """Fine della risposta: un'etichetta mai chiusa si butta, un "[" isolato no."""
        rest, self._pending = self._pending, ""
        return rest if rest == "[" else ""


def from_tag(tag: str, now: datetime | None = None, language: str = "it") -> Reminder | None:
    """``[[remind {"at": "...", "text": "..."}]]`` -> promemoria (o ``None`` se non vale)."""
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
    """Cosa dire al cervello perche' possa programmare promemoria e azioni."""
    now = now or datetime.now()
    stamp = now.strftime("%A %Y-%m-%d %H:%M")
    return (
        f"Local time: {stamp}. If the user asks you to remind them of something, to set a timer or an alarm, "
        "or to do something at a later time, confirm in one short sentence and append at the very end "
        '[[remind {"at": "YYYY-MM-DDTHH:MM", "text": "what to remind"}]] '
        '(use "in": seconds instead of "at" for relative times, "do": "the task" instead of "text" for '
        'something you must do yourself then, "repeat": "daily" if it repeats). Never read or mention the tag.'
    )


# ---------------------------------------------------------------------------
# Frasi: conferme, avvisi, comandi
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
    """Le frasi ci sono in italiano e in inglese: le altre lingue usano l'inglese."""
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
    """Quando scatta, detto a voce: "tra 20 minuti", "domani alle 9:00", "il 29 dicembre alle 12:00"."""
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
    """"devo chiamare mia madre" -> "devi chiamare tua madre" (il promemoria lo dice lei a te)."""
    table = _SWAP[_lang(lang)]

    def swap(match: re.Match) -> str:
        word = match.group(0)
        replacement = table.get(word.lower(), word)
        return replacement[:1].upper() + replacement[1:] if word[:1].isupper() and word.lower() != "i" else replacement

    return re.sub(r"[\w']+", swap, text)


def _about(text: str, lang: str) -> str:
    """Come si attacca la cosa da ricordare: "di chiamare", "del dentista", "che devi..."."""
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
    """Una riga per il pannello: "Timer 5 minuti", "Promemoria: chiamare Marco"."""
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
    """Cosa risponde quando ha preso nota."""
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


def announcement(reminder: Reminder, late: float = 0.0) -> str:
    """Cosa dice quando scatta."""
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
    """Il compito programmato, come messaggio per il cervello."""
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
    """Annulla, "quanto manca", elenco. ``(risposta, cambiato)`` o ``None`` se non e' un comando."""
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
