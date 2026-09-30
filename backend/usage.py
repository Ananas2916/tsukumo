"""Quanto hai usato gli agenti: Claude Code, Codex, Antigravity.

Per chi lavora con gli agenti la domanda vera e' "quanto mi resta prima del
limite?". Qui si legge solo quello che gli agenti scrivono gia' sul PC: niente
rete, niente credenziali.

* **Codex** scrive i limiti del piano nei log delle sessioni
  (``~/.codex/sessions/**/rollout-*.jsonl``, eventi ``token_count`` con
  ``rate_limits``): percentuale usata, durata della finestra, quando si azzera.
* **Claude Code** i limiti del piano li passa solo al comando della barra di
  stato (``statusLine`` in ``~/.claude/settings.json``). Lo script
  ``scripts/tsukumo_statusline.py``, collegato dal pannello, li salva in
  ``state/claude_limits.json``. I token di oggi si contano dalle trascrizioni
  (``~/.claude/projects/**/*.jsonl``).
* **Antigravity** non salva i consumi sul PC: si sa solo quando l'hai usato.

I log possono pesare centinaia di MB: di ogni file si ricorda fin dove e'
arrivata la lettura, e il giro dopo legge solo le righe nuove. Le funzioni
qui sono bloccanti (leggono file): il server le chiama in un thread.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from collections.abc import Callable, Iterable
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Il file che la barra di stato di Claude Code scrive (vedi tsukumo_statusline.py).
CLAUDE_LIMITS_FILE = "claude_limits.json"

#: Le finestre dei limiti di Claude Code, come le chiama la barra di stato.
CLAUDE_WINDOWS = {"five_hour": 300, "seven_day": 10080, "seven_day_opus": 10080, "seven_day_sonnet": 10080}

#: Quanto tenere buona una lettura prima di rileggere i file.
CACHE_SECONDS = 15.0

#: Quanti log di Codex guardare, dal piu' recente, per trovare i limiti.
CODEX_FILES_FOR_LIMITS = 6
#: Di ogni log si guarda solo la coda: i limiti stanno nell'ultimo evento.
TAIL_BYTES = 256 * 1024

_TIMESTAMP = re.compile(rb'"timestamp"\s*:\s*"([^"]+)"')


# ---------------------------------------------------------------------------
# Token di oggi, dai log JSONL
# ---------------------------------------------------------------------------
UsageOf = Callable[[dict[str, Any], Path], "tuple[str | None, int] | None"]


class DailyTally:
    """I token di oggi di un gruppo di log JSONL, leggendo a ogni giro solo le righe nuove.

    ``usage_of(riga, file)`` restituisce ``(chiave, token)`` o None; la chiave
    serve a non contare due volte la stessa risposta (Claude Code scrive una
    riga per ogni blocco di un messaggio, ognuna con lo stesso conteggio).
    ``marker`` e' un pezzo di testo che le righe utili contengono per forza:
    le altre non si decodificano nemmeno.
    """

    def __init__(self, files: Callable[[], Iterable[Path]], usage_of: UsageOf, marker: bytes) -> None:
        self._files = files
        self._usage_of = usage_of
        self._marker = marker
        self._day: date | None = None
        self._offsets: dict[Path, int] = {}
        self._seen: set[str] = set()
        self.tokens = 0
        self.messages = 0
        #: Quando e' stato scritto l'ultima volta un log (epoch), anche di giorni fa.
        self.last_at: float | None = None

    def refresh(self, now: datetime) -> None:
        day = now.date()
        if day != self._day:
            self._day = day
            self._offsets.clear()
            self._seen.clear()
            self.tokens = 0
            self.messages = 0
        midnight = datetime.combine(day, datetime.min.time()).astimezone()
        since = midnight.timestamp()
        # I log scrivono l'ora in UTC ("2026-09-30T17:43:18.274Z"): confronto fra stringhe.
        cutoff = midnight.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S").encode()
        for path in self._files():
            try:
                stat = path.stat()
            except OSError:
                continue
            self.last_at = max(self.last_at or 0.0, stat.st_mtime)
            if stat.st_mtime < since:
                continue
            offset = self._offsets.get(path, 0)
            if stat.st_size < offset:  # riscritto da capo
                offset = 0
            if stat.st_size == offset:
                continue
            self._offsets[path] = self._read(path, offset, cutoff)

    def _read(self, path: Path, offset: int, cutoff: bytes) -> int:
        try:
            with path.open("rb") as handle:
                handle.seek(offset)
                for raw in handle:
                    if not raw.endswith(b"\n"):
                        break  # riga a meta': la si rilegge intera al giro dopo
                    offset += len(raw)
                    if self._marker not in raw:
                        continue
                    stamp = _TIMESTAMP.search(raw)
                    if stamp is None or stamp.group(1) < cutoff:
                        continue
                    self._count(raw, path, cutoff)
        except OSError as exc:
            logger.debug("Log %s non leggibile: %s", path, exc)
        return offset

    def _count(self, raw: bytes, path: Path, cutoff: bytes) -> None:
        try:
            entry = json.loads(raw)
        except ValueError:
            return
        if not isinstance(entry, dict) or str(entry.get("timestamp") or "").encode() < cutoff:
            return
        found = self._usage_of(entry, path)
        if not found:
            return
        key, tokens = found
        if key is not None:
            if key in self._seen:
                return
            self._seen.add(key)
        self.tokens += tokens
        self.messages += 1


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def claude_usage_of(entry: dict[str, Any], path: Path) -> tuple[str | None, int] | None:
    """Una risposta di Claude: token nuovi (input, cache scritta, output; non le letture di cache)."""
    if entry.get("type") != "assistant":
        return None
    message = entry.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    tokens = sum(_int(usage.get(name)) for name in ("input_tokens", "cache_creation_input_tokens", "output_tokens"))
    if tokens <= 0:
        return None
    message_id = message.get("id")
    key = f"{message_id}:{entry.get('requestId')}" if message_id else None
    return key, tokens


def codex_usage_of(entry: dict[str, Any], path: Path) -> tuple[str | None, int] | None:
    """Una chiamata al modello di Codex: input non in cache piu' output."""
    payload = entry.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "token_count":
        return None
    info = payload.get("info")
    if not isinstance(info, dict):
        return None
    last = info.get("last_token_usage")
    if not isinstance(last, dict):
        return None
    tokens = _int(last.get("input_tokens")) - _int(last.get("cached_input_tokens")) + _int(last.get("output_tokens"))
    if tokens <= 0:
        return None
    # Lo stesso conteggio ripetuto (Codex a volte manda due eventi uguali): il totale non cresce.
    total = (info.get("total_token_usage") or {}).get("total_tokens")
    return (f"{path.name}:{total}" if total is not None else None), tokens


# ---------------------------------------------------------------------------
# Limiti del piano
# ---------------------------------------------------------------------------
def _limit(limit_id: str, used: Any, resets_at: Any, window_minutes: int | None, now: float) -> dict[str, Any] | None:
    try:
        percent = float(used)
    except (TypeError, ValueError):
        return None
    try:
        reset = float(resets_at) if resets_at is not None else None
    except (TypeError, ValueError):
        reset = None
    if reset is not None and reset <= now:
        # La finestra si e' gia' azzerata: la lettura e' vecchia, ma il conto no.
        percent, reset = 0.0, None
    return {
        "id": limit_id,
        "used": max(0.0, min(100.0, round(percent, 1))),
        "resetsAt": reset,
        "windowMinutes": window_minutes,
    }


def claude_limits(path: Path, now: float) -> tuple[list[dict[str, Any]], float | None, str | None]:
    """I limiti salvati dalla barra di stato: (limiti, quando, modello)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [], None, None
    if not isinstance(data, dict):
        return [], None, None
    windows = data.get("rate_limits")
    limits: list[dict[str, Any]] = []
    if isinstance(windows, dict):
        for name, window in windows.items():
            if not isinstance(window, dict):
                continue
            item = _limit(name, window.get("used_percentage"), window.get("resets_at"), CLAUDE_WINDOWS.get(name), now)
            if item:
                limits.append(item)
    limits.sort(key=lambda item: item["windowMinutes"] or 0)
    at = data.get("at")
    return limits, float(at) if isinstance(at, (int, float)) else None, data.get("model")


def _iso_epoch(text: Any) -> float | None:
    if not isinstance(text, str):
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def codex_rate_limits(entry: dict[str, Any], now: float) -> tuple[list[dict[str, Any]], str | None] | None:
    """Da un evento ``token_count`` di Codex: (limiti, piano), o None se non li porta."""
    payload = entry.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "token_count":
        return None
    limits = payload.get("rate_limits")
    if not isinstance(limits, dict):
        return None
    at = _iso_epoch(entry.get("timestamp")) or now
    result: list[dict[str, Any]] = []
    for name in ("primary", "secondary"):
        window = limits.get(name)
        if not isinstance(window, dict):
            continue
        resets = window.get("resets_at")
        # Le versioni vecchie di Codex dicevano "fra quanti secondi", non "quando".
        if resets is None and window.get("resets_in_seconds") is not None:
            resets = at + _int(window.get("resets_in_seconds"))
        minutes = window.get("window_minutes")
        item = _limit(name, window.get("used_percent"), resets, _int(minutes) or None, now)
        if item:
            result.append(item)
    if not result:
        return None
    result.sort(key=lambda item: item["windowMinutes"] or 0)
    plan = limits.get("plan_type")
    return result, plan if isinstance(plan, str) else None


def _tail_lines(path: Path, size: int = TAIL_BYTES) -> list[bytes]:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            end = handle.tell()
            handle.seek(max(0, end - size))
            data = handle.read()
    except OSError:
        return []
    lines = data.split(b"\n")
    return lines[1:] if end > size else lines  # la prima riga e' a meta'


# ---------------------------------------------------------------------------
# Gli agenti
# ---------------------------------------------------------------------------
def _jsonl_under(root: Path, pattern: str) -> Callable[[], list[Path]]:
    def files() -> list[Path]:
        if not root.is_dir():
            return []
        return [path for path in root.rglob(pattern) if path.is_file()]

    return files


class UsageService:
    """Legge i consumi dei tre agenti; ``snapshot()`` e' bloccante e tiene una cache breve."""

    def __init__(
        self,
        state_dir: Path,
        *,
        home: Path | None = None,
        codex_home: Path | None = None,
        clock: Callable[[], float] = time.time,
        linked: Callable[[], bool] | None = None,
    ) -> None:
        home = home or Path.home()
        self.state_dir = state_dir
        self.claude_root = home / ".claude" / "projects"
        codex = codex_home or Path(os.environ.get("CODEX_HOME") or home / ".codex")
        self.codex_root = codex / "sessions"
        self.antigravity_root = home / ".gemini" / "antigravity"
        self.clock = clock
        #: La barra di stato di Claude Code e' collegata (vedi notify.py)?
        self.linked = linked or (lambda: False)
        self._claude = DailyTally(_jsonl_under(self.claude_root, "*.jsonl"), claude_usage_of, b'"usage"')
        self._codex = DailyTally(_jsonl_under(self.codex_root, "rollout-*.jsonl"), codex_usage_of, b'"token_count"')
        #: ((file, mtime), ((limiti, piano), quando)): l'ultimo log letto non si rilegge.
        self._codex_limits: tuple[tuple[str, float], tuple[tuple[list[dict[str, Any]], str | None], float]] | None = None
        self._lock = threading.Lock()
        self._cached: dict[str, Any] | None = None
        self._cached_at = 0.0

    @property
    def latest(self) -> dict[str, Any] | None:
        """L'ultima lettura, senza toccare i file."""
        return self._cached

    def snapshot(self, force: bool = False) -> dict[str, Any]:
        with self._lock:
            now = self.clock()
            if not force and self._cached is not None and now - self._cached_at < CACHE_SECONDS:
                return self._cached
            moment = datetime.fromtimestamp(now)
            agents = [self._claude_code(moment, now), self._codex_usage(moment, now), self._antigravity()]
            self._cached = {"at": now, "agents": [agent for agent in agents if agent["installed"]]}
            self._cached_at = now
            return self._cached

    # ------------------------------------------------------------------
    def _claude_code(self, moment: datetime, now: float) -> dict[str, Any]:
        installed = self.claude_root.parent.is_dir()
        limits, at, _model = claude_limits(self.state_dir / CLAUDE_LIMITS_FILE, now)
        linked = self.linked()
        if installed:
            self._claude.refresh(moment)
        note = None
        if not limits:
            # La barra di stato c'e' solo in Claude Code nel terminale: dall'estensione
            # di VS Code (verificato: nessuna lettura in un pomeriggio d'uso) non arriva niente.
            note = (
                "Per i limiti del piano collega la barra di stato (qui sotto): li manda Claude Code nel terminale, con Pro o Max."
                if not linked
                else "Collegata: i limiti arrivano quando usi Claude Code nel terminale, con un piano Pro o Max (dall'estensione di VS Code no)."
            )
        return {
            "id": "claude_code",
            "label": "Claude Code",
            "installed": installed,
            "limits": limits,
            "limitsAt": at,
            "plan": None,
            "today": {"tokens": self._claude.tokens, "messages": self._claude.messages} if installed else None,
            "lastUsed": self._claude.last_at,
            "link": "claude_usage",
            "linked": linked,
            "note": note,
        }

    def _codex_usage(self, moment: datetime, now: float) -> dict[str, Any]:
        installed = self.codex_root.parent.is_dir()
        limits: list[dict[str, Any]] = []
        plan = None
        at = None
        if installed:
            self._codex.refresh(moment)
            found = self._codex_latest_limits(now)
            if found:
                (limits, plan), at = found
        return {
            "id": "codex",
            "label": "Codex",
            "installed": installed,
            "limits": limits,
            "limitsAt": at,
            "plan": plan,
            "today": {"tokens": self._codex.tokens, "messages": self._codex.messages} if installed else None,
            "lastUsed": self._codex.last_at,
            "note": None if limits else "Codex scrive i limiti dopo la prima risposta di una sessione.",
        }

    def _codex_latest_limits(self, now: float) -> tuple[tuple[list[dict[str, Any]], str | None], float] | None:
        files = []
        for path in _jsonl_under(self.codex_root, "rollout-*.jsonl")():
            try:
                files.append((path.stat().st_mtime, path))
            except OSError:
                continue
        files.sort(reverse=True)
        for mtime, path in files[:CODEX_FILES_FOR_LIMITS]:
            key = (str(path), mtime)
            if self._codex_limits and self._codex_limits[0] == key:
                (limits, plan), at = self._codex_limits[1]
                # Rifatti sull'ora di adesso: una finestra puo' essersi azzerata nel frattempo.
                return (_refresh(limits, now), plan), at
            for raw in reversed(_tail_lines(path)):
                if b'"rate_limits"' not in raw:
                    continue
                try:
                    entry = json.loads(raw)
                except ValueError:
                    continue
                found = codex_rate_limits(entry, now) if isinstance(entry, dict) else None
                if found:
                    at = _iso_epoch(entry.get("timestamp")) or mtime
                    self._codex_limits = (key, (found, at))
                    return found, at
        return None

    def _antigravity(self) -> dict[str, Any]:
        root = self.antigravity_root
        installed = root.is_dir()
        last = None
        if installed:
            for candidate in (root / "cli.log", root / "log", root / "conversations"):
                try:
                    last = max(last or 0.0, candidate.stat().st_mtime)
                except OSError:
                    continue
        return {
            "id": "antigravity",
            "label": "Antigravity",
            "installed": installed,
            "limits": [],
            "limitsAt": None,
            "plan": None,
            "today": None,
            "lastUsed": last,
            "note": "Antigravity non scrive i consumi sul PC: le quote dei modelli le vedi nella sua app.",
        }


def _refresh(limits: list[dict[str, Any]], now: float) -> list[dict[str, Any]]:
    result = []
    for item in limits:
        if item["resetsAt"] is not None and item["resetsAt"] <= now:
            item = {**item, "used": 0.0, "resetsAt": None}
        result.append(item)
    return result


def tightest(snapshot: dict[str, Any] | None, prefer: str | None = None) -> dict[str, Any] | None:
    """Il limite piu' vicino a finire, per l'anello del HUD: ``{agent, label, limit}``.

    Con ``prefer`` (il cervello attivo, se e' uno di questi agenti) vince il suo.
    """
    best = None
    for agent in (snapshot or {}).get("agents", []):
        for limit in agent.get("limits", []):
            score = limit["used"] + (1000 if agent["id"] == prefer else 0)
            if best is None or score > best[0]:
                best = (score, {"agent": agent["id"], "label": agent["label"], "limit": limit})
    return best[1] if best else None


# ---------------------------------------------------------------------------
# A parole
# ---------------------------------------------------------------------------
WINDOW_WORDS = {
    "it": {300: "delle cinque ore", 10080: "settimanale", 43200: "mensile"},
    "en": {300: "5-hour", 10080: "weekly", 43200: "monthly"},
}


def window_words(minutes: int | None, lang: str) -> str:
    table = WINDOW_WORDS["it" if lang == "it" else "en"]
    if minutes in table:
        return table[minutes]
    if not minutes:
        return "del piano" if lang == "it" else "plan"
    if minutes < 1440:
        hours = round(minutes / 60)
        return f"delle {hours} ore" if lang == "it" else f"{hours}-hour"
    days = round(minutes / 1440)
    return f"di {days} giorni" if lang == "it" else f"{days}-day"


def when_words(resets_at: float | None, now: float, lang: str) -> str:
    """ "alle 18:40", "domani alle 9:10", "tra 5 giorni"."""
    if resets_at is None:
        return "presto" if lang == "it" else "soon"
    moment = datetime.fromtimestamp(resets_at)
    today = datetime.fromtimestamp(now).date()
    if lang == "it":
        clock = f"{moment.hour}:{moment.minute:02d}"
        if moment.date() == today:
            return f"alle {clock}"
        if moment.date() == today + timedelta(days=1):
            return f"domani alle {clock}"
        return f"tra {math.ceil((resets_at - now) / 86400)} giorni"
    clock = moment.strftime("%I:%M %p").lstrip("0").lower()
    if moment.date() == today:
        return f"at {clock}"
    if moment.date() == today + timedelta(days=1):
        return f"tomorrow at {clock}"
    return f"in {math.ceil((resets_at - now) / 86400)} days"


def tokens_words(tokens: int, lang: str) -> str:
    if lang == "it":
        if tokens < 1000:
            return f"{tokens} token"
        if tokens < 1_000_000:
            return f"{round(tokens / 1000)} mila token"
        millions = f"{tokens / 1_000_000:.1f}".replace(".", ",").replace(",0", "")
        return f"{millions} milioni di token" if millions != "1" else "un milione di token"
    if tokens < 1000:
        return f"{tokens} tokens"
    if tokens < 1_000_000:
        return f"{round(tokens / 1000)} thousand tokens"
    return f"{tokens / 1_000_000:.1f} million tokens".replace(".0 ", " ")


_ASK = re.compile(
    r"(quant[oaie]\s+(?:mi\s+|ti\s+|ci\s+)?(?:resta|rimane|rimangono|restano|manca)"
    r"|quant[oaie]\s+(?:ho|hai|abbiamo)\s+(?:usato|consumato)"
    r"|a che punto|limit[ei]|consum[io]|how much|usage|limits?|quota)",
    re.IGNORECASE,
)
_WHO = {
    "claude_code": re.compile(r"\bclaude\b", re.IGNORECASE),
    "codex": re.compile(r"\bcodex\b", re.IGNORECASE),
    "antigravity": re.compile(r"\b(antigravity|agy)\b", re.IGNORECASE),
}
_ANY_AGENT = re.compile(r"\b(agent[ie]?|agents?)\b", re.IGNORECASE)


def wants_usage(prompt: str) -> list[str] | None:
    """Chiede dei consumi? Gli agenti nominati ([] = tutti), o None se non e' questa la domanda."""
    if not _ASK.search(prompt):
        return None
    named = [agent for agent, pattern in _WHO.items() if pattern.search(prompt)]
    if named:
        return named
    return [] if _ANY_AGENT.search(prompt) else None


def describe(snapshot: dict[str, Any] | None, lang: str, only: list[str] | None = None, now: float | None = None) -> str:
    """La risposta a voce: limiti, quando si azzerano, token di oggi."""
    now = now if now is not None else time.time()
    it = lang == "it"
    agents = [agent for agent in (snapshot or {}).get("agents", []) if not only or agent["id"] in only]
    if not agents:
        if only:
            return "Non trovo quell'agente su questo PC." if it else "I can't find that agent on this PC."
        return "Non trovo agenti di cui leggere i consumi." if it else "I can't find any agent usage to read."
    parts = []
    for agent in agents:
        name = agent["label"]
        limits = agent.get("limits") or []
        today = agent.get("today") or {}
        if limits:
            bits = []
            for limit in limits:
                window = window_words(limit.get("windowMinutes"), lang)
                used = round(limit["used"])
                if it:
                    bit = f"{used} per cento del limite {window}"
                    if limit.get("resetsAt"):
                        bit += f", che si azzera {when_words(limit['resetsAt'], now, lang)}"
                else:
                    bit = f"{used} percent of the {window} limit"
                    if limit.get("resetsAt"):
                        bit += f", resetting {when_words(limit['resetsAt'], now, lang)}"
                bits.append(bit)
            parts.append(f"{name}: " + ("; ".join(bits)) + ".")
        elif agent["id"] == "antigravity":
            parts.append(
                "Antigravity non scrive i consumi sul PC: le quote le vedi nella sua app."
                if it
                else "Antigravity doesn't write its usage to disk: check the quotas in its app."
            )
        elif agent["id"] == "claude_code" and not agent.get("linked"):
            parts.append(
                "Dei limiti di Claude Code non so niente finché non colleghi la barra di stato, nella scheda Lavoro."
                if it
                else "I don't know Claude Code's limits until you link the status line, in the Work tab."
            )
        if today.get("tokens"):
            words = tokens_words(int(today["tokens"]), lang)
            parts.append(f"Oggi {name} ha lavorato {words}." if it else f"Today {name} processed {words}.")
    return " ".join(parts)
