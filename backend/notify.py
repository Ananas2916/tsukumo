"""Notifications from the agents you use on your own: "Claude Code is done!".

When you work with Claude Code or Codex in a terminal or in VS Code and turn
to something else, the companion calls you when they're done (or when they
wait for a permission). It works with the two programs' hooks:

* Claude Code: ``hooks.Stop`` and ``hooks.Notification`` in ``~/.claude/settings.json``;
* Codex: ``notify = [...]`` in ``~/.codex/config.toml``.

Both run ``scripts/tsukumo_notify.py``, which sends the message to
``POST /api/notify``. Connecting and disconnecting them is done from the panel
(``install``/``uninstall`` below): it touches configuration files outside the
project, so only on request, with a backup copy.

Here there's also Claude Code's status line (``statusLine``), the only place
where Claude Code says how much of the plan's limits is left: it runs
``scripts/tsukumo_statusline.py``, which passes them to Tsukumo
(``usage.py``). If there already was a status line, ours runs it and prints
its output: disconnecting brings the old one back.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shlex
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "tsukumo_notify.py"
MARK = "tsukumo_notify.py"
STATUSLINE_SCRIPT = ROOT / "scripts" / "tsukumo_statusline.py"
STATUSLINE_MARK = "tsukumo_statusline.py"

NAMES = {"claude": "Claude Code", "codex": "Codex"}
#: Claude Code's hooks: notifications (Stop, Notification) and, for the
#: dashboard, when it starts working (UserPromptSubmit) and its task list
#: (PostToolUse).
CLAUDE_EVENTS = ("Stop", "Notification", "UserPromptSubmit", "PostToolUse")
#: PostToolUse only for the list's tools: no other tool runs anything.
TASKS_MATCHER = "TodoWrite|TaskCreate|TaskUpdate"


def claude_settings_path() -> Path:
    return Path.home() / ".claude" / "settings.json"


def codex_config_path() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"


def _python() -> str:
    """The backend's interpreter (the venv's), with forward slashes: it works in cmd and in bash."""
    return Path(sys.executable).as_posix()


def claude_hook() -> dict[str, Any]:
    """The "exec" form (command + args): it starts directly, whether the shell is bash or PowerShell."""
    return {"type": "command", "command": _python(), "args": [SCRIPT.as_posix(), "claude"], "timeout": 10}


# ---------------------------------------------------------------------------
# The notification's text
# ---------------------------------------------------------------------------
def summary_of(message: str, limit: int = 160) -> str:
    """The first useful sentence, without markdown or code blocks."""
    text = re.sub(r"```.*?```", " ", message or "", flags=re.DOTALL)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"[*_#>|]+", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = " ".join(text.split())
    if not text:
        return ""
    sentence = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
    if len(sentence) > limit:
        sentence = sentence[:limit].rsplit(" ", 1)[0] + "…"
    return sentence


def announcement(source: str, kind: str, summary: str, language: str, brief: bool) -> str:
    name = NAMES.get(source, source or ("l'agente" if language == "it" else "the agent"))
    if language == "it":
        if kind == "waiting":
            return f"{name} ti sta aspettando{': ' + summary if summary and not brief else '!'}"
        return f"{name} ha finito{': ' + summary if summary and not brief else '!'}"
    if kind == "waiting":
        return f"{name} is waiting for you{': ' + summary if summary and not brief else '!'}"
    return f"{name} is done{': ' + summary if summary and not brief else '!'}"


# ---------------------------------------------------------------------------
# Connecting: Claude Code
# ---------------------------------------------------------------------------
def _backup(path: Path) -> None:
    backup = path.with_name(path.name + ".tsukumo-bak")
    if path.is_file() and not backup.exists():
        shutil.copy2(path, backup)


def _claude_hooks(settings: dict[str, Any]) -> dict[str, Any]:
    hooks = settings.get("hooks")
    return hooks if isinstance(hooks, dict) else {}


def _is_ours(hook: Any) -> bool:
    return MARK in json.dumps(hook)


def _claude_ours(settings: dict[str, Any]) -> set[str]:
    """The events that already have our hook."""
    found = set()
    for event in CLAUDE_EVENTS:
        for group in _claude_hooks(settings).get(event) or []:
            for hook in (group or {}).get("hooks") or []:
                if _is_ours(hook):
                    found.add(event)
    return found


def _claude_has(settings: dict[str, Any]) -> bool:
    return bool(_claude_ours(settings))


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8") or "{}")
    if not isinstance(data, dict):
        raise ValueError(f"{path} doesn't contain a JSON object")
    return data


def install_claude(path: Path | None = None) -> str:
    path = path or claude_settings_path()
    settings = _read_json(path)
    present = _claude_ours(settings)
    missing = [event for event in CLAUDE_EVENTS if event not in present]
    if not missing:
        return "already connected"
    _backup(path)
    hooks = settings.setdefault("hooks", {})
    for event in missing:
        group: dict[str, Any] = {"hooks": [claude_hook()]}
        if event == "PostToolUse":
            group = {"matcher": TASKS_MATCHER, **group}
        hooks.setdefault(event, []).append(group)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # Connected before the dashboard: only the new events were missing.
    return "updated" if present else "connected"


def uninstall_claude(path: Path | None = None) -> str:
    path = path or claude_settings_path()
    settings = _read_json(path)
    if not _claude_has(settings):
        return "was not connected"
    hooks = _claude_hooks(settings)
    for event in CLAUDE_EVENTS:
        groups = []
        for group in hooks.get(event) or []:
            kept = [hook for hook in (group or {}).get("hooks") or [] if not _is_ours(hook)]
            if kept:
                groups.append({**group, "hooks": kept})
        if groups:
            hooks[event] = groups
        else:
            hooks.pop(event, None)
    if not hooks:
        settings.pop("hooks", None)
    path.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "disconnected"


# ---------------------------------------------------------------------------
# Connecting: Codex
# ---------------------------------------------------------------------------
_NOTIFY_LINE = re.compile(r"^\s*notify\s*=", re.MULTILINE)


def _codex_line() -> str:
    return "notify = " + json.dumps([_python(), SCRIPT.as_posix(), "codex"])


def install_codex(path: Path | None = None) -> str:
    path = path or codex_config_path()
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    found = _NOTIFY_LINE.search(text)
    if found:
        line = text[found.start() : text.find("\n", found.start()) if "\n" in text[found.start() :] else len(text)]
        if MARK in line:
            return "already connected"
        raise ValueError("Codex already has a 'notify' command in config.toml: I won't overwrite it.")
    _backup(path)
    # Top-level keys must come before any [table]: at the top.
    block = f"# Tsukumo: notifies when Codex is done (remove it from the panel).\n{_codex_line()}\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(block + ("\n" + text if text else ""), encoding="utf-8")
    return "connected"


def uninstall_codex(path: Path | None = None) -> str:
    path = path or codex_config_path()
    if not path.is_file():
        return "was not connected"
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    kept = [line for line in lines if not (MARK in line and _NOTIFY_LINE.match(line)) and not line.startswith(("# Tsukumo: avvisa", "# Tsukumo: notifies"))]
    if len(kept) == len(lines):
        return "was not connected"
    text = "".join(kept).lstrip("\n")
    path.write_text(text, encoding="utf-8")
    return "disconnected"


# ---------------------------------------------------------------------------
# Connecting: Claude Code's status line (the plan's limits)
# ---------------------------------------------------------------------------
def _statusline_ours(entry: Any) -> bool:
    return isinstance(entry, dict) and STATUSLINE_MARK in str(entry.get("command") or "")


def statusline_command(previous: dict[str, Any] | None = None) -> str:
    """The status line's command: a single string (``statusLine`` has no command + args form).

    Paths in double quotes and with forward slashes: they work in bash and in cmd.
    """
    command = f'"{_python()}" "{STATUSLINE_SCRIPT.as_posix()}"'
    if previous:
        encoded = base64.urlsafe_b64encode(json.dumps(previous, ensure_ascii=False).encode("utf-8")).decode("ascii")
        command += f" --then {encoded}"
    return command


def _statusline_previous(entry: dict[str, Any]) -> dict[str, Any] | None:
    """The status line there was before, from our command (``--then <base64>``)."""
    try:
        parts = shlex.split(str(entry.get("command") or ""), posix=True)
        index = parts.index("--then")
        previous = json.loads(base64.urlsafe_b64decode(parts[index + 1].encode("ascii")).decode("utf-8"))
    except (ValueError, IndexError):
        return None
    return previous if isinstance(previous, dict) else None


def install_statusline(path: Path | None = None) -> str:
    path = path or claude_settings_path()
    settings = _read_json(path)
    current = settings.get("statusLine")
    if _statusline_ours(current):
        return "already connected"
    _backup(path)
    previous = current if isinstance(current, dict) and current.get("command") else None
    entry: dict[str, Any] = {"type": "command", "command": statusline_command(previous)}
    if previous and "padding" in previous:
        entry["padding"] = previous["padding"]
    settings["statusLine"] = entry
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "connected"


def uninstall_statusline(path: Path | None = None) -> str:
    path = path or claude_settings_path()
    settings = _read_json(path)
    current = settings.get("statusLine")
    if not _statusline_ours(current):
        return "was not connected"
    previous = _statusline_previous(current)
    if previous:
        settings["statusLine"] = previous
    else:
        settings.pop("statusLine", None)
    path.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "disconnected"


def statusline_installed(path: Path | None = None) -> bool:
    try:
        return _statusline_ours(_read_json(path or claude_settings_path()).get("statusLine"))
    except (OSError, ValueError):
        return False


# ---------------------------------------------------------------------------
# State, for the panel
# ---------------------------------------------------------------------------
def status() -> dict[str, Any]:
    result: dict[str, Any] = {}
    claude_path = claude_settings_path()
    try:
        claude_events = _claude_ours(_read_json(claude_path))
    except (OSError, ValueError):
        claude_events = set()
    claude_available = claude_path.parent.is_dir() or bool(shutil.which("claude"))
    result["claude"] = {
        "label": NAMES["claude"],
        "available": claude_available,
        "installed": bool(claude_events),
        # Connected from a version without the dashboard: "Connect" adds the missing events.
        "outdated": bool(claude_events) and len(claude_events) < len(CLAUDE_EVENTS),
        "file": str(claude_path),
    }
    try:
        statusline = _read_json(claude_path).get("statusLine")
    except (OSError, ValueError):
        statusline = None
    result["claude_usage"] = {
        "label": "Claude Code's limits",
        "available": claude_available,
        "installed": _statusline_ours(statusline),
        # There was already a status line: it stays, ours runs it and shows its output.
        "wraps": bool(isinstance(statusline, dict) and statusline.get("command") and not _statusline_ours(statusline)),
        "file": str(claude_path),
    }
    codex_path = codex_config_path()
    try:
        text = codex_path.read_text(encoding="utf-8") if codex_path.is_file() else ""
    except OSError:
        text = ""
    found = _NOTIFY_LINE.search(text)
    result["codex"] = {
        "label": NAMES["codex"],
        "available": codex_path.parent.is_dir(),
        "installed": bool(found and MARK in text[found.start() : found.start() + 400]),
        "conflict": bool(found and MARK not in text[found.start() : found.start() + 400]),
        "file": str(codex_path),
    }
    return result


def change(tool: str, action: str) -> str:
    table = {
        ("claude", "install"): install_claude,
        ("claude", "uninstall"): uninstall_claude,
        ("codex", "install"): install_codex,
        ("codex", "uninstall"): uninstall_codex,
        ("claude_usage", "install"): install_statusline,
        ("claude_usage", "uninstall"): uninstall_statusline,
    }
    handler = table.get((tool, action))
    if handler is None:
        raise KeyError(f"{tool}/{action}")
    return handler()
