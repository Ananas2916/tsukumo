"""What you've done together, counted on this PC: she shows it after an update.

Two kinds of numbers:

- read from the agents' own logs, so they go back as far as the logs do:
  the sessions (Claude Code, Codex, Gemini CLI, Antigravity) and the lines
  the agents wrote (Claude Code's edits, Codex's patches);
- counted by Tsukumo from the day this arrived: the words you dictated, the
  messages with her, the reminders that went off, the to-dos ticked off.

The logs can weigh hundreds of MB: each file is read once, then only from
where it stopped (they only grow), and the totals per file are kept in
``state/stats_cache.json``. Only counts are kept, never what was written.
Nothing leaves the PC: ``GET /api/stats`` is local only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: What Tsukumo counts by herself.
COUNTERS = ("words", "messages", "reminders", "todos")

# Claude Code's file tools and where the written text is.
_CLAUDE_TEXT = {"Write": ("content",), "Edit": ("new_string",), "NotebookEdit": ("new_source",)}
# A patch as Codex writes it (apply_patch, inside its tool calls).
_PATCH = re.compile(r"\*\*\* Begin Patch(.*?)(?:\*\*\* End Patch|$)", re.DOTALL)
_WORD = re.compile(r"\w+", re.UNICODE)


def count_lines(text: Any) -> int:
    if not isinstance(text, str) or not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def claude_lines(record: dict[str, Any]) -> int:
    """The lines a Claude Code assistant record wrote into files."""
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return 0
    total = 0
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "tool_use":
            continue
        name, data = item.get("name"), item.get("input")
        if not isinstance(data, dict):
            continue
        if name == "MultiEdit":
            edits = data.get("edits")
            total += sum(count_lines(edit.get("new_string")) for edit in edits if isinstance(edit, dict)) if isinstance(edits, list) else 0
        for key in _CLAUDE_TEXT.get(name, ()):
            total += count_lines(data.get(key))
    return total


def patch_lines(text: str) -> int:
    """Lines added by the patches in a text ("+" lines, not the "+++" headers)."""
    total = 0
    for block in _PATCH.findall(text or ""):
        # Codex often writes the patch inside a string of code: its newlines are "\n" escapes.
        if "\n" not in block and "\\n" in block:
            block = block.replace("\\n", "\n")
        total += sum(1 for line in block.splitlines() if line.startswith("+") and not line.startswith("+++"))
    return total


def codex_lines(record: dict[str, Any]) -> int:
    """The lines a Codex tool call added with a patch (the call's input, never its echo)."""
    payload = record.get("payload")
    if not isinstance(payload, dict) or payload.get("type") not in ("custom_tool_call", "function_call"):
        return 0
    text = payload.get("input") if payload.get("type") == "custom_tool_call" else payload.get("arguments")
    return patch_lines(text) if isinstance(text, str) else 0


#: How each log is read: the marker a line must contain to be worth parsing, and the counter.
_READERS = {
    "claude": (b'"tool_use"', claude_lines),
    "codex": (b"Begin Patch", codex_lines),
}


class LogScan:
    """The agents' logs, read incrementally."""

    def __init__(self, cache_path: Path | None, home: Path | None = None) -> None:
        self.cache_path = cache_path
        self.home = home or Path.home()
        self._cache: dict[str, dict[str, Any]] = {}
        if cache_path and cache_path.is_file():
            try:
                data = json.loads(cache_path.read_text(encoding="utf-8"))
                self._cache = data if isinstance(data, dict) else {}
            except (OSError, ValueError):
                self._cache = {}

    def sources(self) -> list[tuple[str, str, Path]]:
        """(agent, how to read it, file): one file is one session."""
        home = self.home
        found: list[tuple[str, str, Path]] = []
        claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude") / "projects"
        # Only the sessions themselves: subagents' transcripts live one level deeper.
        found += [("claude_code", "claude", path) for path in claude.glob("*/*.jsonl")]
        codex = Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions"
        found += [("codex", "codex", path) for path in codex.rglob("*.jsonl")]
        gemini = home / ".gemini"
        found += [("gemini_cli", "session", path) for path in gemini.glob("tmp/*/chats/*.json")]
        found += [("antigravity", "session", path) for path in (gemini / "antigravity" / "conversations").glob("*") if path.is_file()]
        return found

    def scan(self) -> dict[str, dict[str, int]]:
        sessions: dict[str, int] = {}
        lines: dict[str, int] = {}
        seen: set[str] = set()
        for agent, kind, path in self.sources():
            sessions[agent] = sessions.get(agent, 0) + 1
            if kind not in _READERS:
                continue
            key = str(path)
            seen.add(key)
            try:
                written = self._read(key, path, kind)
            except OSError as exc:
                logger.debug("Log unreadable (%s): %s", path.name, exc)
                written = int(self._cache.get(key, {}).get("lines", 0))
            if written:
                lines[agent] = lines.get(agent, 0) + written
        # Logs deleted meanwhile leave the cache (their lines go with them).
        self._cache = {key: value for key, value in self._cache.items() if key in seen}
        self._save()
        return {"sessions": sessions, "lines": lines}

    def _read(self, key: str, path: Path, kind: str) -> int:
        stat = path.stat()
        entry = self._cache.get(key) or {}
        offset = int(entry.get("offset", 0))
        total = int(entry.get("lines", 0))
        if stat.st_size < offset:
            # Rewritten, not grown: from the start.
            offset, total = 0, 0
        if stat.st_size == offset:
            return total
        marker, counter = _READERS[kind]
        with path.open("rb") as handle:
            handle.seek(offset)
            for raw in handle:
                if not raw.endswith(b"\n"):
                    break  # still being written: next time
                offset += len(raw)
                if marker not in raw:
                    continue
                try:
                    record = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(record, dict):
                    total += counter(record)
        self._cache[key] = {"offset": offset, "lines": total}
        return total

    def _save(self) -> None:
        if not self.cache_path:
            return
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.cache_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self._cache), encoding="utf-8")
            os.replace(temporary, self.cache_path)
        except OSError as exc:
            logger.warning("Stats cache not saved: %s", exc)


class Stats:
    """Tsukumo's own counters plus the agents' logs."""

    def __init__(self, state_dir: Path | None, home: Path | None = None, clock: Any = time.time) -> None:
        self.path = state_dir / "stats.json" if state_dir else None
        self.logs = LogScan(state_dir / "stats_cache.json" if state_dir else None, home)
        self.clock = clock
        self.counts: dict[str, Any] = {"since": clock(), **{name: 0 for name in COUNTERS}}
        if self.path and self.path.is_file():
            try:
                saved = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(saved, dict):
                    for name in ("since", *COUNTERS):
                        if isinstance(saved.get(name), (int, float)) and saved[name] >= 0:
                            self.counts[name] = saved[name]
            except (OSError, ValueError):
                pass
        self._scan_lock = threading.Lock()

    def add(self, name: str, amount: int = 1) -> None:
        if name not in COUNTERS or amount <= 0:
            return
        self.counts[name] = int(self.counts[name]) + int(amount)
        self._save()

    def dictated(self, text: str) -> None:
        self.add("words", len(_WORD.findall(text or "")))

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self.counts), encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError as exc:
            logger.warning("Stats not saved: %s", exc)

    def _scan(self) -> dict[str, dict[str, int]]:
        with self._scan_lock:  # two dashboards asking at once read the logs once
            return self.logs.scan()

    async def snapshot(self) -> dict[str, Any]:
        logs = await asyncio.to_thread(self._scan)
        return {
            "sessions": sum(logs["sessions"].values()),
            "sessionsBy": logs["sessions"],
            "lines": sum(logs["lines"].values()),
            "linesBy": logs["lines"],
            **{name: int(self.counts[name]) for name in COUNTERS},
            "since": self.counts["since"],
        }
