"""The user's calendars, read only, from their iCal links.

Google Calendar ("Secret address in iCal format"), Outlook ("Publish
calendar" -> ICS), iCloud (public calendar), a school's or a team's calendar: every
one of them gives a private ``.ics`` link. No account, no OAuth, nothing is
ever written: it's the "half-agent" level (see the scope notes in README).

The parser is small and dependency-free: events (``VEVENT``) with times in
UTC, in a time zone (``TZID``, IANA or the Windows names Outlook uses) or all
day; the common recurrences (``RRULE`` daily, weekly with days, monthly,
yearly, with ``INTERVAL``, ``COUNT``, ``UNTIL``), ``EXDATE`` and the moved
occurrences (``RECURRENCE-ID``). What it doesn't understand it skips.

The links are secrets (anyone with one reads the calendar): they live in
``.env`` (``DC_CALENDAR_URLS``) and never reach the panel. The events'
text comes from the internet: for a brain it's data, never instructions.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any

import httpx

logger = logging.getLogger(__name__)

#: How often the calendars are downloaded again.
REFRESH_EVERY = 15 * 60
#: How far ahead (and behind) the events are expanded.
LOOK_AHEAD_DAYS = 31
LOOK_BEHIND_DAYS = 1
MAX_OCCURRENCES = 1500
MAX_BYTES = 8 * 1024 * 1024

#: The Windows time-zone names Outlook writes in its ICS files.
WINDOWS_ZONES = {
    "W. Europe Standard Time": "Europe/Berlin",
    "Romance Standard Time": "Europe/Paris",
    "Central Europe Standard Time": "Europe/Budapest",
    "Central European Standard Time": "Europe/Warsaw",
    "GMT Standard Time": "Europe/London",
    "Greenwich Standard Time": "Atlantic/Reykjavik",
    "E. Europe Standard Time": "Europe/Chisinau",
    "FLE Standard Time": "Europe/Kiev",
    "GTB Standard Time": "Europe/Bucharest",
    "Russian Standard Time": "Europe/Moscow",
    "Eastern Standard Time": "America/New_York",
    "Central Standard Time": "America/Chicago",
    "Mountain Standard Time": "America/Denver",
    "Pacific Standard Time": "America/Los_Angeles",
    "UTC": "UTC",
    "Coordinated Universal Time": "UTC",
}

_DAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")


@dataclass
class Event:
    title: str
    start: float
    end: float
    all_day: bool = False
    location: str = ""
    calendar: str = ""
    uid: str = ""

    @property
    def id(self) -> str:
        return f"{self.uid}@{int(self.start)}"

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["id"] = self.id
        data["allDay"] = data.pop("all_day")
        data["startIso"] = datetime.fromtimestamp(self.start).isoformat(timespec="minutes")
        data["endIso"] = datetime.fromtimestamp(self.end).isoformat(timespec="minutes")
        return data


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------
def unfold(text: str) -> list[str]:
    """ICS lines continue on the next one when it starts with a space or a tab."""
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw:
            lines.append(raw)
    return lines


def _split(line: str) -> tuple[str, dict[str, str], str]:
    """``DTSTART;TZID=Europe/Rome:20261013T090000`` -> name, params, value."""
    head, _, value = line.partition(":")
    # A quoted parameter may contain ":" (TZID="(UTC+01:00) Rome"): find the real colon.
    if head.count('"') % 2:
        quoted_end = line.find('"', len(head) + 1)
        colon = line.find(":", quoted_end)
        head, value = line[:colon], line[colon + 1 :]
    parts = head.split(";")
    params = {}
    for part in parts[1:]:
        key, _, val = part.partition("=")
        params[key.upper()] = val.strip('"')
    return parts[0].upper(), params, value


def _text(value: str) -> str:
    return re.sub(r"\\([,;\\nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value).strip()


def _zone(name: str | None) -> tzinfo | None:
    if not name:
        return None
    name = WINDOWS_ZONES.get(name, name)
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:
        return None


def parse_moment(value: str, params: dict[str, str]) -> tuple[datetime, bool]:
    """A DTSTART/DTEND value -> (local naive datetime, all day)."""
    value = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        return datetime.strptime(value[:8], "%Y%m%d"), True
    utc = value.endswith("Z")
    moment = datetime.strptime(value.rstrip("Z")[:15], "%Y%m%dT%H%M%S")
    if utc:
        return moment.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None), False
    zone = _zone(params.get("TZID"))
    if zone is not None:
        return moment.replace(tzinfo=zone).astimezone().replace(tzinfo=None), False
    return moment, False


_DURATION = re.compile(r"^(?P<sign>[+-])?P(?:(?P<w>\d+)W)?(?:(?P<d>\d+)D)?(?:T(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?(?:(?P<s>\d+)S)?)?$")


def parse_duration(value: str) -> timedelta | None:
    found = _DURATION.match(value.strip())
    if not found:
        return None
    parts = {key: int(val) for key, val in found.groupdict().items() if val and key != "sign"}
    delta = timedelta(weeks=parts.get("w", 0), days=parts.get("d", 0), hours=parts.get("h", 0), minutes=parts.get("m", 0), seconds=parts.get("s", 0))
    return -delta if found.group("sign") == "-" else delta


@dataclass
class _Raw:
    uid: str = ""
    title: str = ""
    location: str = ""
    start: datetime | None = None
    end: datetime | None = None
    duration: timedelta | None = None
    all_day: bool = False
    rrule: dict[str, str] | None = None
    exdates: tuple[datetime, ...] = ()
    recurrence_id: datetime | None = None
    cancelled: bool = False


def parse_events(text: str) -> list[_Raw]:
    events: list[_Raw] = []
    current: _Raw | None = None
    depth = 0  # VALARM and other blocks inside an event
    exdates: list[datetime] = []
    for line in unfold(text):
        name, params, value = _split(line)
        if name == "BEGIN" and value.upper() == "VEVENT":
            current, depth, exdates = _Raw(), 0, []
            continue
        if current is None:
            continue
        if name == "BEGIN":
            depth += 1
            continue
        if name == "END":
            if value.upper() == "VEVENT":
                current.exdates = tuple(exdates)
                if current.start is not None:
                    events.append(current)
                current = None
            else:
                depth = max(0, depth - 1)
            continue
        if depth:
            continue
        try:
            if name == "UID":
                current.uid = value.strip()
            elif name == "SUMMARY":
                current.title = _text(value)[:200]
            elif name == "LOCATION":
                current.location = _text(value)[:200]
            elif name == "DTSTART":
                current.start, current.all_day = parse_moment(value, params)
            elif name == "DTEND":
                current.end, _ = parse_moment(value, params)
            elif name == "DURATION":
                current.duration = parse_duration(value)
            elif name == "RRULE":
                current.rrule = {key.upper(): val for key, _, val in (part.partition("=") for part in value.split(";")) if key}
            elif name == "EXDATE":
                exdates.extend(parse_moment(item, params)[0] for item in value.split(",") if item.strip())
            elif name == "RECURRENCE-ID":
                current.recurrence_id, _ = parse_moment(value, params)
            elif name == "STATUS" and value.strip().upper() == "CANCELLED":
                current.cancelled = True
        except (ValueError, OverflowError):
            continue
    return events


# ---------------------------------------------------------------------------
# Recurrences
# ---------------------------------------------------------------------------
def _add_months(moment: datetime, months: int) -> datetime | None:
    index = moment.month - 1 + months
    year, month = moment.year + index // 12, index % 12 + 1
    try:
        return moment.replace(year=year, month=month)
    except ValueError:
        return None  # 31st in a short month: that occurrence doesn't exist (RFC 5545)


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date | None:
    if nth > 0:
        first = date(year, month, 1)
        day = first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (nth - 1))
    else:
        following = date(year + month // 12, month % 12 + 1, 1)
        last = following - timedelta(days=1)
        day = last - timedelta(days=(last.weekday() - weekday) % 7 + 7 * (-nth - 1))
    return day if day.month == month else None


def occurrences(start: datetime, rule: dict[str, str], until: datetime, since: datetime | None = None) -> list[datetime]:
    """The starts of a recurring event up to ``until`` (the first one included).

    Only those from ``since`` on are returned (a day earlier, for long events),
    but all of them count for ``COUNT``. A daily or weekly series without
    ``COUNT`` that began years ago jumps straight to the window.
    """
    keep_from = (since - timedelta(days=2)) if since else start
    freq = rule.get("FREQ", "").upper()
    interval = max(1, int(rule.get("INTERVAL", "1") or 1))
    count = int(rule["COUNT"]) if rule.get("COUNT", "").isdigit() else None
    end = until
    if rule.get("UNTIL"):
        try:
            limit, _ = parse_moment(rule["UNTIL"], {})
            if len(rule["UNTIL"]) == 8:
                limit = limit.replace(hour=23, minute=59, second=59)
            end = min(end, limit)
        except ValueError:
            pass
    days = [part.strip().upper() for part in rule.get("BYDAY", "").split(",") if part.strip()]
    month_days = [int(part) for part in rule.get("BYMONTHDAY", "").split(",") if part.strip().lstrip("-").isdigit()]
    found: list[datetime] = []
    produced = 0
    steps = 0

    def emit(moment: datetime) -> bool:
        nonlocal produced, steps
        steps += 1
        if moment < start:
            return True
        produced += 1
        if count is not None and produced > count:
            return False
        if moment > end or steps > 200_000:
            return False
        if moment >= keep_from:
            found.append(moment)
        return len(found) < MAX_OCCURRENCES

    def skipped(period_days: int) -> int:
        """Whole periods that end before the window (only without COUNT)."""
        if count is not None or keep_from <= start:
            return 0
        return max(0, (keep_from - start).days // period_days - 1)

    if freq == "DAILY":
        moment = start + timedelta(days=interval * skipped(interval))
        while emit(moment):
            moment += timedelta(days=interval)
    elif freq == "WEEKLY":
        weekdays = sorted({_DAYS.index(day[-2:]) for day in days if day[-2:] in _DAYS}) or [start.weekday()]
        week = start - timedelta(days=start.weekday()) + timedelta(weeks=interval * skipped(7 * interval))
        going = True
        while going:
            for weekday in weekdays:
                moment = week + timedelta(days=weekday)
                if not emit(moment):
                    going = False
                    break
            week += timedelta(weeks=interval)
            if week > end + timedelta(days=7):
                break
    elif freq in ("MONTHLY", "YEARLY"):
        step = interval if freq == "MONTHLY" else 12 * interval
        months = 0
        going = True
        while going:
            base = _add_months(start.replace(day=1), months)
            months += step
            if base is None or base > end + timedelta(days=31):
                break
            candidates: list[datetime] = []
            if days and freq == "MONTHLY":
                for day in days:
                    nth = re.match(r"^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$", day)
                    if not nth:
                        continue
                    weekday = _DAYS.index(nth.group(2))
                    if nth.group(1):
                        hit = _nth_weekday(base.year, base.month, weekday, int(nth.group(1)))
                        if hit:
                            candidates.append(datetime.combine(hit, start.time()))
                    else:
                        cursor = date(base.year, base.month, 1)
                        while cursor.month == base.month:
                            if cursor.weekday() == weekday:
                                candidates.append(datetime.combine(cursor, start.time()))
                            cursor += timedelta(days=1)
            elif month_days:
                for value in month_days:
                    following = date(base.year + base.month // 12, base.month % 12 + 1, 1)
                    length = (following - timedelta(days=1)).day
                    day_number = value if value > 0 else length + value + 1
                    if 1 <= day_number <= length:
                        candidates.append(datetime.combine(date(base.year, base.month, day_number), start.time()))
            else:
                try:
                    candidates.append(base.replace(day=start.day))
                except ValueError:
                    pass
            for moment in sorted(candidates):
                if not emit(moment):
                    going = False
                    break
    else:
        emit(start)
    return found


def expand(raws: list[_Raw], since: datetime, until: datetime, calendar: str = "") -> list[Event]:
    """The occurrences between ``since`` and ``until``, moved ones and cancellations included."""
    moved: dict[tuple[str, datetime], _Raw] = {}
    for raw in raws:
        if raw.recurrence_id is not None:
            moved[(raw.uid, raw.recurrence_id)] = raw
    events: list[Event] = []

    def add(raw: _Raw, start: datetime) -> None:
        if raw.cancelled:
            return
        length = (raw.end - raw.start) if raw.end and raw.start else (raw.duration or (timedelta(days=1) if raw.all_day else timedelta(hours=1)))
        finish = start + max(length, timedelta(0))
        if finish < since or start > until:
            return
        events.append(Event(raw.title or "(untitled)", start.timestamp(), finish.timestamp(), raw.all_day, raw.location, calendar, raw.uid))

    for raw in raws:
        if raw.recurrence_id is not None or raw.start is None:
            continue
        if raw.rrule:
            excluded = set(raw.exdates)
            for start in occurrences(raw.start, raw.rrule, until, since):
                if start in excluded:
                    continue
                override = moved.get((raw.uid, start))
                if override is not None:
                    if override.start is not None:
                        add(override, override.start)
                    continue
                add(raw, start)
        else:
            add(raw, raw.start)
    # Moved occurrences whose series wasn't expanded that far (or isn't in the file).
    seen = {event.id for event in events}
    for (uid, _), raw in moved.items():
        if raw.start is not None:
            candidate = Event(raw.title, raw.start.timestamp(), raw.start.timestamp(), raw.all_day, raw.location, calendar, uid)
            if candidate.id not in seen:
                add(raw, raw.start)
    events.sort(key=lambda event: (event.start, event.title))
    return events


# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------
def split_urls(raw: str) -> list[str]:
    urls = []
    for part in re.split(r"[\s,]+", raw or ""):
        part = part.strip()
        if part.lower().startswith("webcal://"):
            part = "https://" + part[len("webcal://") :]
        if part.lower().startswith(("https://", "http://")):
            urls.append(part)
    return urls


def calendar_name(text: str, fallback: str) -> str:
    found = re.search(r"^X-WR-CALNAME:(.+)$", text, re.MULTILINE)
    return _text(found.group(1))[:60] if found else fallback


class CalendarService:
    """Downloads the calendars now and then and keeps the expanded events."""

    def __init__(self, urls: callable, clock: callable = time.time) -> None:  # type: ignore[valid-type]
        self._urls = urls
        self.clock = clock
        self.events: list[Event] = []
        self.fetched_at: float | None = None
        self.error: str | None = None
        self.names: list[str] = []

    @property
    def configured(self) -> bool:
        return bool(split_urls(self._urls()))

    async def refresh(self, force: bool = False) -> bool:
        """Downloads again if it's time (or ``force``); true if the events changed."""
        urls = split_urls(self._urls())
        if not urls:
            changed = bool(self.events)
            self.events, self.names, self.error, self.fetched_at = [], [], None, None
            return changed
        now = self.clock()
        if not force and self.fetched_at and now - self.fetched_at < REFRESH_EVERY:
            return False
        today = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0)
        since, until = today - timedelta(days=LOOK_BEHIND_DAYS), today + timedelta(days=LOOK_AHEAD_DAYS)
        events: list[Event] = []
        names: list[str] = []
        errors: list[str] = []
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers={"User-Agent": "Tsukumo calendar"}) as client:
            for index, url in enumerate(urls):
                try:
                    response = await client.get(url)
                    response.raise_for_status()
                    if len(response.content) > MAX_BYTES:
                        raise ValueError("calendar too big")
                    text = response.text
                    name = calendar_name(text, f"Calendar {index + 1}")
                    names.append(name)
                    events.extend(expand(parse_events(text), since, until, name))
                except Exception as exc:
                    # Never the link in the log or the panel: it's a secret.
                    errors.append(f"calendar {index + 1}: {type(exc).__name__}")
                    logger.warning("Calendar %d not read: %s", index + 1, type(exc).__name__)
        events.sort(key=lambda event: (event.start, event.title))
        changed = [event.id for event in events] != [event.id for event in self.events]
        self.events, self.names, self.fetched_at = events, names, now
        self.error = "; ".join(errors) or None
        return changed

    def between(self, start: float, end: float) -> list[Event]:
        return [event for event in self.events if event.end > start and event.start < end]

    def day(self, day: date) -> list[Event]:
        start = datetime.combine(day, datetime.min.time()).timestamp()
        return self.between(start, start + 86400)

    def status(self) -> dict[str, Any]:
        now = self.clock()
        return {
            "configured": self.configured,
            "calendars": self.names,
            "events": [event.as_dict() for event in self.events if event.end > now - 3600][:200],
            "fetchedAt": self.fetched_at,
            "error": self.error,
        }


def conflicts(events: list[Event]) -> list[tuple[Event, Event]]:
    """Timed events that overlap (all-day ones don't clash with anything)."""
    timed = sorted((event for event in events if not event.all_day), key=lambda event: event.start)
    pairs = []
    for index, first in enumerate(timed):
        for second in timed[index + 1 :]:
            if second.start >= first.end:
                break
            if second.start < first.end and (first.title, first.start) != (second.title, second.start):
                pairs.append((first, second))
    return pairs


def free_slots(events: list[Event], day: date, start_hour: int = 9, end_hour: int = 19, minimum: int = 30 * 60) -> list[tuple[float, float]]:
    """The free gaps of at least ``minimum`` seconds in a day's working hours."""
    begin = datetime.combine(day, datetime.min.time()).replace(hour=start_hour).timestamp()
    finish = datetime.combine(day, datetime.min.time()).replace(hour=end_hour).timestamp()
    busy = sorted((max(begin, event.start), min(finish, event.end)) for event in events if not event.all_day and event.end > begin and event.start < finish)
    slots = []
    cursor = begin
    for start, end in busy:
        if start - cursor >= minimum:
            slots.append((cursor, start))
        cursor = max(cursor, end)
    if finish - cursor >= minimum:
        slots.append((cursor, finish))
    return slots
