"""The to-do list and the notes: what to do without a time, and what to keep.

The reminders (``reminders.py``) ring at a time. A to-do waits in a list
("chiamare il dentista"), maybe with a "by when", and she brings it up in a
free moment (``secretary.py``); a note is something to keep and find again
("prendi nota: la chiave del garage è nel secondo cassetto").

Quick capture without the brain, in Italian and English:

* "segnati che devo chiamare il dentista", "aggiungi alla lista il pane",
  "to-do: pay the gas bill", "add milk to my list";
* "prendi nota: ...", "take a note: ...";
* "cosa ho da fare?", "what's on my list?";
* "fatto il pane", "ho chiamato il dentista", "mark the gas bill done" (only
  if it matches something in the list: otherwise it's just a sentence).

With a date or a time it's a reminder, not a to-do: those phrases are left to
``reminders.py``. The brain adds them with ``[[todo {...}]]``, ``[[note: ...]]``
and ``[[done: ...]]`` (``run_tags``).

Everything lives in ``state/notebook.json``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import unicodedata
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Done to-dos stay this long (for the evening recap and "what did I do?"), then go.
KEEP_DONE = 7 * 86400
MAX_TEXT = 300


@dataclass
class Todo:
    text: str
    #: By when: the end of that day (a timestamp), or None = whenever.
    due: float | None = None
    important: bool = False
    #: When it was done, None while open.
    done: float | None = None
    #: "voice", "brain", "panel", "mail" (suggested from a mail, see secretary.py).
    source: str = "voice"
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    created: float = field(default_factory=time.time)
    #: When she last brought it up (the nudges don't repeat it every hour).
    nudged: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["dueIso"] = datetime.fromtimestamp(self.due).date().isoformat() if self.due else None
        return data


@dataclass
class Note:
    text: str
    source: str = "voice"
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    created: float = field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def end_of_day(day: date) -> float:
    return datetime.combine(day, datetime.max.time()).replace(microsecond=0).timestamp()


def fold(text: str) -> str:
    """Lowercase, no accents, no punctuation: for matching "perché" with "perche"."""
    plain = unicodedata.normalize("NFKD", text.lower())
    plain = "".join(ch for ch in plain if not unicodedata.combining(ch))
    return " ".join(re.sub(r"[^\w\s]", " ", plain).split())


_STOP = set(
    "il lo la i gli le un uno una di a da in con su per tra fra e o ma che del della dei delle al alla ai alle "
    "nel nella mi ti si ci the a an of to in on for and or my your with at by from is are it this that".split()
)


def words(text: str) -> set[str]:
    return {word for word in fold(text).split() if word not in _STOP and len(word) > 1}


def match_score(query: str, text: str) -> float:
    """How well ``query`` matches ``text`` (0..1): the share of the query's words found, by prefix."""
    wanted = words(query)
    if not wanted:
        return 0.0
    have = words(text)
    hits = sum(1 for word in wanted if any(other.startswith(word[:5]) or word.startswith(other[:5]) for other in have if len(other) > 2))
    return hits / len(wanted)


class Notebook:
    """The to-dos and the notes, saved at every change."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._todos: dict[str, Todo] = {}
        self._notes: dict[str, Note] = {}
        self._lock = threading.Lock()
        #: Called when a to-do gets ticked off (stats.py counts them).
        self.on_done: Callable[[], None] | None = None
        self._load()

    # ------------------------------------------------------------ storage
    def _load(self) -> None:
        if not self.path or not self.path.is_file():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            for item in raw.get("todos", []):
                todo = Todo(**{k: v for k, v in item.items() if k in Todo.__dataclass_fields__})
                self._todos[todo.id] = todo
            for item in raw.get("notes", []):
                note = Note(**{k: v for k, v in item.items() if k in Note.__dataclass_fields__})
                self._notes[note.id] = note
        except Exception as exc:
            logger.warning("Notebook unreadable from %s: %s", self.path, exc)

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"todos": [asdict(item) for item in self._todos.values()], "notes": [asdict(item) for item in self._notes.values()]}
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError as exc:
            logger.warning("Notebook not saved in %s: %s", self.path, exc)

    # ------------------------------------------------------------ to-dos
    def todos(self, include_done: bool = False, now: float | None = None) -> list[Todo]:
        """Open ones first: important, then by date (none last), then oldest; done ones after."""
        now = time.time() if now is None else now
        with self._lock:
            items = [item for item in self._todos.values() if include_done or item.done is None]
        open_items = sorted(
            (item for item in items if item.done is None),
            key=lambda item: (not item.important, item.due if item.due else float("inf"), item.created),
        )
        done = sorted((item for item in items if item.done is not None and now - item.done < KEEP_DONE), key=lambda item: -item.done)
        return open_items + done

    def add_todo(self, text: str, due: float | None = None, important: bool = False, source: str = "voice") -> Todo | None:
        text = " ".join(str(text or "").split())[:MAX_TEXT]
        if not text:
            return None
        # The same thing said twice is one to-do (the brain and the capture may both catch it).
        for item in self.todos():
            if fold(item.text) == fold(text):
                if due and not item.due:
                    item.due = due
                item.important = item.important or important
                self._save()
                return item
        todo = Todo(text=text, due=due, important=important, source=source)
        with self._lock:
            self._todos[todo.id] = todo
        self._save()
        return todo

    def find_todo(self, query: str, threshold: float = 0.6) -> Todo | None:
        """The open to-do that best matches ``query`` (an id works too)."""
        if query in self._todos:
            return self._todos[query]
        best, score = None, 0.0
        for item in self.todos():
            value = match_score(query, item.text)
            if value > score:
                best, score = item, value
        return best if score >= threshold else None

    def complete(self, todo_id: str, done: bool = True, now: float | None = None) -> Todo | None:
        item = self._todos.get(todo_id)
        if item is None:
            return None
        ticked = done and not item.done
        item.done = (time.time() if now is None else now) if done else None
        self._save()
        if ticked and self.on_done is not None:
            self.on_done()
        return item

    def update_todo(self, todo_id: str, *, text: str | None = None, due: float | None | bool = False, important: bool | None = None) -> Todo | None:
        """``due=False`` leaves it, ``None`` clears it."""
        item = self._todos.get(todo_id)
        if item is None:
            return None
        if text is not None and text.strip():
            item.text = " ".join(text.split())[:MAX_TEXT]
        if due is not False:
            item.due = due  # type: ignore[assignment]
        if important is not None:
            item.important = important
        self._save()
        return item

    def nudged(self, todo_id: str, now: float | None = None) -> None:
        item = self._todos.get(todo_id)
        if item is not None:
            item.nudged = time.time() if now is None else now
            self._save()

    def remove_todo(self, todo_id: str) -> Todo | None:
        with self._lock:
            removed = self._todos.pop(todo_id, None)
        if removed:
            self._save()
        return removed

    def done_since(self, since: float) -> list[Todo]:
        return [item for item in self.todos(include_done=True) if item.done is not None and item.done >= since]

    def prune(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            old = [key for key, item in self._todos.items() if item.done is not None and now - item.done >= KEEP_DONE]
            for key in old:
                del self._todos[key]
        if old:
            self._save()

    # ------------------------------------------------------------ notes
    def notes(self) -> list[Note]:
        with self._lock:
            return sorted(self._notes.values(), key=lambda item: -item.created)

    def add_note(self, text: str, source: str = "voice") -> Note | None:
        text = " ".join(str(text or "").split())[: MAX_TEXT * 4]
        if not text:
            return None
        for item in self.notes():
            if fold(item.text) == fold(text):
                return item
        note = Note(text=text, source=source)
        with self._lock:
            self._notes[note.id] = note
        self._save()
        return note

    def remove_note(self, note_id: str) -> Note | None:
        with self._lock:
            removed = self._notes.pop(note_id, None)
        if removed:
            self._save()
        return removed

    def search(self, query: str, limit: int = 5) -> list[tuple[float, str, Any]]:
        """``(score, kind, item)`` of the notes and to-dos that match."""
        found: list[tuple[float, str, Any]] = []
        for note in self.notes():
            score = match_score(query, note.text)
            if score >= 0.5:
                found.append((score, "note", note))
        for todo in self.todos(include_done=True):
            score = match_score(query, todo.text)
            if score >= 0.5:
                found.append((score * 0.95, "todo", todo))
        found.sort(key=lambda entry: -entry[0])
        return found[:limit]

    def as_dict(self) -> dict[str, Any]:
        return {"todos": [item.as_dict() for item in self.todos(include_done=True)], "notes": [item.as_dict() for item in self.notes()]}


# ---------------------------------------------------------------------------
# Quick capture: the phrases understood without the brain
# ---------------------------------------------------------------------------
_CAPTURE_IT = re.compile(
    r"^(?:(?:per favore|ehi|tsukumo)[,\s]+)?(?:"
    r"(?:segna(?:ti|mi|lo)?|annota(?:ti|mi)?|appunta(?:ti|mi)?|aggiungi|metti)\s+(?:alla|nella|in|sulla)\s+(?:mia\s+)?lista(?:\s+delle\s+cose\s+da\s+fare)?\s*:?\s*(?:che\s+devo\s+|di\s+)?"
    r"|segna(?:ti|mi)\s+(?:che\s+(?:devo|dovrei|bisogna)\s+|di\s+)"
    r"|(?:cose\s+)?da\s+fare\s*:\s*"
    r"|to-?do\s*:\s*"
    r")(?P<text>.+?)[.!]?$",
    re.IGNORECASE,
)
_CAPTURE_EN = re.compile(
    r"^(?:(?:please|hey|tsukumo)[,\s]+)?(?:"
    r"(?:add|put)\s+(?P<pre>.+?)\s+(?:to|on)\s+my\s+(?:to-?do\s+)?list"
    r"|(?:add\s+to\s+my\s+(?:to-?do\s+)?list|to-?do)\s*:?\s*(?P<text>.+?)"
    r"|note\s+(?:down\s+)?that\s+i\s+(?:need|have)\s+to\s+(?P<need>.+?)"
    r")[.!]?$",
    re.IGNORECASE,
)
_NOTE = re.compile(
    r"^(?:(?:per favore|please|ehi|hey|tsukumo)[,\s]+)?(?:"
    r"(?:prendi\s+(?:nota|appunti?)|annota(?:ti|mi)?|appunta(?:ti|mi)?|take\s+(?:a\s+)?note|make\s+a\s+note|jot\s+down)"
    r"\s*(?::|\b(?:che|di|that|of)\b)"
    # Bare "nota"/"note" only with the colon: "note that..." is ordinary speech.
    r"|(?:nota|note)\s*:"
    r")\s*(?P<text>.+?)[.!]?$",
    re.IGNORECASE,
)
_LIST = re.compile(
    r"\b(?:cosa|che cosa|cos'?)\s*(?:ho|c'?[eè]|mi resta|devo)\s+(?:ancora\s+)?(?:da fare|in lista|nella lista|fare)\b"
    r"|\b(?:la mia lista|le cose da fare)\b"
    r"|\bwhat(?:'s| is| do i have)\s+(?:on\s+my\s+(?:to-?do\s+)?list|left\s+to\s+do|to\s+do)\b|\bmy\s+to-?do\s+list\b",
    re.IGNORECASE,
)
#: After the list question only "today" may follow: "cosa devo fare per installare..." isn't one.
_LIST_TAIL = re.compile(r"[\s?!.,]*(?:(?:oggi|today|stasera|tonight|ancora|still|please|per favore)[\s?!.,]*)*", re.IGNORECASE)
_DONE = re.compile(
    r"^(?:(?:ok|okay|bene|ecco|allora)[,\s]+)?(?:"
    r"(?:ho\s+)?fatto(?:\s+anche)?|ho\s+finito(?:\s+di)?|segna(?:\s+come)?\s+fatt[oa]|togli\s+dalla\s+lista|cancella\s+dalla\s+lista"
    r"|done\s+with|i\s+(?:did|finished|have\s+done)|mark(?:ed)?|cross\s+off|tick\s+off"
    r")\s+(?P<text>.+?)(?:\s+(?:as\s+)?(?:done|fatto|completed))?[.!]?$",
    re.IGNORECASE,
)
#: Past participles: "ho chiamato il dentista" closes "chiamare il dentista".
_PAST = re.compile(r"^(?:ho|i've|i have)\s+(?P<verb>\w+?)(?:ato|uto|ito|ed)\s+(?P<rest>.+?)[.!]?$", re.IGNORECASE)
_IMPORTANT = re.compile(r"\b(?:importante|urgente|important|urgent)\b", re.IGNORECASE)


def _lang_of(text: str, fallback: str) -> str:
    if re.search(r"\b(?:the|my|to|add|note|what|done|list|please)\b", text, re.IGNORECASE):
        return "en"
    if re.search(r"\b(?:il|la|di|che|devo|lista|nota|fatto|segna|cosa)\b", text, re.IGNORECASE):
        return "it"
    return fallback


def _clean(text: str) -> str:
    text = _IMPORTANT.sub(" ", text)
    return " ".join(text.split()).strip(" ,:;-")


def _say_list(items: list[Todo], lang: str) -> str:
    if not items:
        return "La tua lista è vuota: niente da fare!" if lang == "it" else "Your list is empty: nothing to do!"
    shown = [item.text for item in items[:4]]
    more = len(items) - len(shown)
    if lang == "it":
        head = "Hai una cosa da fare: " if len(items) == 1 else f"Hai {len(items)} cose da fare: "
        tail = f", e altre {more}" if more > 0 else ""
    else:
        head = "You have one thing to do: " if len(items) == 1 else f"You have {len(items)} things to do: "
        tail = f", and {more} more" if more > 0 else ""
    return head + "; ".join(shown) + tail + "."


def command(text: str, notebook: Notebook, lang: str = "it", now: datetime | None = None) -> tuple[str, bool] | None:
    """A to-do or note phrase: ``(reply, changed)``, or None if it isn't one.

    A phrase with a time or a date is a reminder: the caller asks
    ``reminders.parse_requests`` first and doesn't come here if it found one.
    """
    raw = " ".join(str(text or "").split())
    if not raw or len(raw) > 400:
        return None
    lang = _lang_of(raw, lang)
    note = _NOTE.match(raw)
    if note:
        added = notebook.add_note(note.group("text"))
        if added is None:
            return None
        return ("Annotato." if lang == "it" else "Noted."), True
    capture = _CAPTURE_IT.match(raw) or _CAPTURE_EN.match(raw)
    if capture:
        groups = capture.groupdict()
        what = _clean(groups.get("text") or groups.get("pre") or groups.get("need") or "")
        if what:
            item = notebook.add_todo(what, important=bool(_IMPORTANT.search(raw)))
            if item is not None:
                if lang == "it":
                    return f"Segnato in lista: {item.text}." + (" Te lo ricordo in un momento libero." if not item.due else ""), True
                return f"On your list: {item.text}." + (" I'll bring it up when you have a moment." if not item.due else ""), True
    asked = _LIST.search(raw)
    if asked and _LIST_TAIL.fullmatch(raw[asked.end() :]):
        return _say_list(notebook.todos(), lang), False
    done = _DONE.match(raw)
    target = None
    if done:
        target = notebook.find_todo(done.group("text"))
    if target is None:
        past = _PAST.match(raw)
        if past:
            target = notebook.find_todo(f"{past.group('verb')} {past.group('rest')}", threshold=0.75)
    if target is not None:
        notebook.complete(target.id)
        left = len(notebook.todos())
        if lang == "it":
            return f"Fatto: {target.text}! " + ("La lista è vuota." if not left else f"Te ne restano {left}."), True
        return f"Done: {target.text}! " + ("Your list is empty." if not left else f"{left} left."), True
    return None


# ---------------------------------------------------------------------------
# The brain's tags: [[todo {...}]], [[note: ...]], [[done: ...]]
# ---------------------------------------------------------------------------
_TODO_TAG = re.compile(r"^\[\[\s*todo\s*(?::\s*(?P<plain>.*?)|(?P<json>\{.*\}))\s*\]\]$", re.IGNORECASE | re.DOTALL)
_NOTE_TAG = re.compile(r"^\[\[\s*note\s*:\s*(?P<text>.+?)\s*\]\]$", re.IGNORECASE | re.DOTALL)
_DONE_TAG = re.compile(r"^\[\[\s*done\s*:\s*(?P<text>.+?)\s*\]\]$", re.IGNORECASE | re.DOTALL)


def _parse_by(value: Any) -> float | None:
    if not value:
        return None
    try:
        day = date.fromisoformat(str(value)[:10])
    except ValueError:
        return None
    return end_of_day(day)


def run_tags(tags: list[str], notebook: Notebook) -> tuple[list[str], bool]:
    """Runs the notebook's tags; ``(other tags, changed)``."""
    others: list[str] = []
    changed = False
    for tag in tags:
        stripped = tag.strip()
        if found := _TODO_TAG.match(stripped):
            if found.group("json"):
                try:
                    data = json.loads(found.group("json"))
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue
                item = notebook.add_todo(str(data.get("text") or ""), due=_parse_by(data.get("by")), important=bool(data.get("important")), source="brain")
            else:
                item = notebook.add_todo(found.group("plain") or "", source="brain")
            changed = changed or item is not None
        elif found := _NOTE_TAG.match(stripped):
            changed = notebook.add_note(found.group("text"), source="brain") is not None or changed
        elif found := _DONE_TAG.match(stripped):
            target = notebook.find_todo(found.group("text"), threshold=0.5)
            if target is not None:
                notebook.complete(target.id)
                changed = True
        else:
            others.append(tag)
    return others, changed


DIRECTIVE = (
    "Tsukumo keeps a to-do list (no time of day) and notes: append one "
    '[[todo {"text": "what", "by": "YYYY-MM-DD", "important": true}]] per item ("by", "important" optional), also '
    "when you plan work for them; [[done: what]] when it's done; [[note: the text]] to keep a note. With a time "
    "of day it's a [[remind]] instead."
)


def due_words(due: float, lang: str, now: float | None = None) -> str:
    """ "oggi", "domani", "venerdì", "il 3 novembre": the day of a deadline."""
    today = date.fromtimestamp(time.time() if now is None else now)
    day = date.fromtimestamp(due)
    days = (day - today).days
    weekdays = {
        "it": ("lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"),
        "en": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
    }
    months = {
        "it": ("gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"),
        "en": ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"),
    }
    lang = "it" if lang == "it" else "en"
    if days < 0:
        return "scaduto" if lang == "it" else "overdue"
    if days == 0:
        return "oggi" if lang == "it" else "today"
    if days == 1:
        return "domani" if lang == "it" else "tomorrow"
    if days < 7:
        return weekdays[lang][day.weekday()]
    return f"il {day.day} {months['it'][day.month - 1]}" if lang == "it" else f"on {months['en'][day.month - 1]} {day.day}"


def week_from(now: float) -> float:
    return end_of_day(date.fromtimestamp(now) + timedelta(days=7))
