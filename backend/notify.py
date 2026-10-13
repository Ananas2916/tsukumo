"""Notifications from the agents you use on your own: "Claude Code is done!".

When you work with Claude Code, Codex, Gemini CLI or Cursor in a terminal or
in an editor and turn to something else, the companion calls you when
they're done (or when they wait for a permission). It works with the
programs' hooks:

* Claude Code: ``hooks.Stop`` and ``hooks.Notification`` in ``~/.claude/settings.json``;
* Codex: ``notify = [...]`` in ``~/.codex/config.toml``;
* Gemini CLI: ``hooks.AfterAgent`` and ``hooks.Notification`` in ``~/.gemini/settings.json``;
* Cursor: ``afterAgentResponse`` in ``~/.cursor/hooks.json``.

They all run ``scripts/tsukumo_notify.py``, which sends the message to
``POST /api/notify``. Connecting and disconnecting them is done from the panel
(``install``/``uninstall`` below): it touches configuration files outside the
project, so only on request, with a backup copy.

Two more things connect from here, the same way:

* **Approvals** - Claude Code's ``PermissionRequest`` hook: its permission
  questions also appear in her island (Allow / Always / Deny, see
  approvals.py). If nobody answers, Claude Code asks as always.
* **Her body as tools** - ``scripts/tsukumo_mcp.py``, an MCP server any of
  these agents can use: speak through her, show a card, add a reminder, a
  to-do or a note, read the agenda, know if you're at the PC.

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

NAMES = {"claude": "Claude Code", "codex": "Codex", "gemini": "Gemini CLI", "cursor": "Cursor"}
MCP_SCRIPT = ROOT / "scripts" / "tsukumo_mcp.py"
MCP_NAME = "tsukumo"
#: Gemini CLI's hooks: it's done (AfterAgent), it waits for a permission (Notification), it started (BeforeAgent).
GEMINI_EVENTS = ("AfterAgent", "Notification", "BeforeAgent")
#: Cursor's: the final answer, and the prompt (it started).
CURSOR_EVENTS = ("afterAgentResponse", "beforeSubmitPrompt")
#: How long Claude Code waits for the island's click before asking in its window.
APPROVAL_TIMEOUT = 120
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


def gemini_settings_path() -> Path:
    return Path.home() / ".gemini" / "settings.json"


def cursor_hooks_path() -> Path:
    return Path.home() / ".cursor" / "hooks.json"


def cursor_mcp_path() -> Path:
    return Path.home() / ".cursor" / "mcp.json"


def claude_user_config_path() -> Path:
    return Path.home() / ".claude.json"


def _python() -> str:
    """The backend's interpreter (the venv's), with forward slashes: it works in cmd and in bash."""
    return Path(sys.executable).as_posix()


def claude_hook() -> dict[str, Any]:
    """The "exec" form (command + args): it starts directly, whether the shell is bash or PowerShell."""
    return {"type": "command", "command": _python(), "args": [SCRIPT.as_posix(), "claude"], "timeout": 10}


def shell_command(*args: str) -> str:
    """A single command line (Gemini CLI and Cursor run a string): quoted, forward slashes."""
    return " ".join(f'"{part}"' for part in (_python(), SCRIPT.as_posix(), *args))


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


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
# Connecting: Gemini CLI and Cursor
# ---------------------------------------------------------------------------
def _grouped_ours(hooks: dict[str, Any], events: tuple[str, ...]) -> set[str]:
    """Gemini's layout (like Claude's): event -> [{"hooks": [{...}]}]."""
    found = set()
    for event in events:
        for group in hooks.get(event) or []:
            if any(_is_ours(hook) for hook in (group or {}).get("hooks") or []):
                found.add(event)
    return found


def install_gemini(path: Path | None = None) -> str:
    path = path or gemini_settings_path()
    settings = _read_json(path)
    hooks = settings.get("hooks")
    if hooks is not None and not isinstance(hooks, dict):
        raise ValueError("Gemini CLI's settings.json has a 'hooks' that isn't an object: I won't touch it.")
    present = _grouped_ours(hooks or {}, GEMINI_EVENTS)
    missing = [event for event in GEMINI_EVENTS if event not in present]
    if not missing:
        return "already connected"
    _backup(path)
    hooks = settings.setdefault("hooks", {})
    for event in missing:
        hooks.setdefault(event, []).append({"hooks": [{"type": "command", "name": "tsukumo", "command": shell_command("gemini"), "timeout": 10000}]})
    _write_json(path, settings)
    return "connected"


def uninstall_gemini(path: Path | None = None) -> str:
    path = path or gemini_settings_path()
    settings = _read_json(path)
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict) or not _grouped_ours(hooks, GEMINI_EVENTS):
        return "was not connected"
    for event in GEMINI_EVENTS:
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
    _write_json(path, settings)
    return "disconnected"


def _cursor_ours(data: dict[str, Any]) -> set[str]:
    hooks = data.get("hooks") if isinstance(data.get("hooks"), dict) else {}
    return {event for event in CURSOR_EVENTS if any(_is_ours(hook) for hook in hooks.get(event) or [])}


def install_cursor(path: Path | None = None) -> str:
    path = path or cursor_hooks_path()
    data = _read_json(path)
    if data.get("hooks") is not None and not isinstance(data.get("hooks"), dict):
        raise ValueError("Cursor's hooks.json has a 'hooks' that isn't an object: I won't touch it.")
    present = _cursor_ours(data)
    missing = [event for event in CURSOR_EVENTS if event not in present]
    if not missing:
        return "already connected"
    _backup(path)
    data.setdefault("version", 1)
    hooks = data.setdefault("hooks", {})
    for event in missing:
        hooks.setdefault(event, []).append({"command": shell_command("cursor"), "timeout": 10})
    _write_json(path, data)
    return "connected"


def uninstall_cursor(path: Path | None = None) -> str:
    path = path or cursor_hooks_path()
    data = _read_json(path)
    if not _cursor_ours(data):
        return "was not connected"
    hooks = data["hooks"]
    for event in CURSOR_EVENTS:
        kept = [hook for hook in hooks.get(event) or [] if not _is_ours(hook)]
        if kept:
            hooks[event] = kept
        else:
            hooks.pop(event, None)
    _write_json(path, data)
    return "disconnected"


# ---------------------------------------------------------------------------
# Connecting: Claude Code's permission questions (approvals.py)
# ---------------------------------------------------------------------------
def _approval_hook() -> dict[str, Any]:
    return {"type": "command", "command": _python(), "args": [SCRIPT.as_posix(), "claude-permission"], "timeout": APPROVAL_TIMEOUT + 10}


def _approvals_ours(settings: dict[str, Any]) -> bool:
    return any(_is_ours(hook) for group in _claude_hooks(settings).get("PermissionRequest") or [] for hook in (group or {}).get("hooks") or [])


def install_approvals(path: Path | None = None) -> str:
    path = path or claude_settings_path()
    settings = _read_json(path)
    if _approvals_ours(settings):
        return "already connected"
    _backup(path)
    settings.setdefault("hooks", {}).setdefault("PermissionRequest", []).append({"matcher": "*", "hooks": [_approval_hook()]})
    _write_json(path, settings)
    return "connected"


def uninstall_approvals(path: Path | None = None) -> str:
    path = path or claude_settings_path()
    settings = _read_json(path)
    if not _approvals_ours(settings):
        return "was not connected"
    hooks = _claude_hooks(settings)
    groups = []
    for group in hooks.get("PermissionRequest") or []:
        kept = [hook for hook in (group or {}).get("hooks") or [] if not _is_ours(hook)]
        if kept:
            groups.append({**group, "hooks": kept})
    if groups:
        hooks["PermissionRequest"] = groups
    else:
        hooks.pop("PermissionRequest", None)
    if not hooks:
        settings.pop("hooks", None)
    _write_json(path, settings)
    return "disconnected"


# ---------------------------------------------------------------------------
# Her body as tools: the MCP server, for each agent
# ---------------------------------------------------------------------------
def mcp_entry() -> dict[str, Any]:
    return {"command": _python(), "args": [MCP_SCRIPT.as_posix()]}


def _mcp_json_has(path: Path) -> bool:
    try:
        servers = _read_json(path).get("mcpServers")
    except (OSError, ValueError):
        return False
    return isinstance(servers, dict) and MCP_NAME in servers


def _mcp_json_install(path: Path) -> str:
    data = _read_json(path)
    servers = data.get("mcpServers")
    if servers is not None and not isinstance(servers, dict):
        raise ValueError(f"{path.name} has an 'mcpServers' that isn't an object: I won't touch it.")
    if isinstance(servers, dict) and MCP_NAME in servers:
        if MARK_MCP in json.dumps(servers[MCP_NAME]):
            return "already connected"
        raise ValueError(f"There's already an MCP server called '{MCP_NAME}' in {path.name}: I won't overwrite it.")
    _backup(path)
    data.setdefault("mcpServers", {})[MCP_NAME] = mcp_entry()
    _write_json(path, data)
    return "connected"


def _mcp_json_uninstall(path: Path) -> str:
    data = _read_json(path)
    servers = data.get("mcpServers")
    if not isinstance(servers, dict) or MARK_MCP not in json.dumps(servers.get(MCP_NAME) or {}):
        return "was not connected"
    servers.pop(MCP_NAME)
    _write_json(path, data)
    return "disconnected"


MARK_MCP = "tsukumo_mcp.py"


def _claude_cli() -> str:
    found = shutil.which("claude")
    if not found:
        raise ValueError("Claude Code's 'claude' command isn't on the PATH: open a new terminal after installing it, then retry.")
    return found


def _run(command: list[str]) -> str:
    import subprocess

    done = subprocess.run(command, capture_output=True, text=True, timeout=60, env={**os.environ, "TSUKUMO_INTERNAL": "1"})
    if done.returncode != 0:
        raise ValueError((done.stderr or done.stdout or "the command failed").strip()[:300])
    return done.stdout


def install_mcp_claude() -> str:
    if _mcp_json_has(claude_user_config_path()):
        return "already connected"
    # Through Claude Code's own command: ~/.claude.json is its live state file, never edited by hand.
    _run([_claude_cli(), "mcp", "add", "--scope", "user", MCP_NAME, "--", _python(), MCP_SCRIPT.as_posix()])
    return "connected"


def uninstall_mcp_claude() -> str:
    if not _mcp_json_has(claude_user_config_path()):
        return "was not connected"
    _run([_claude_cli(), "mcp", "remove", "--scope", "user", MCP_NAME])
    return "disconnected"


_CODEX_MCP = re.compile(r"(?ms)^# Tsukumo: her body as tools[^\n]*\n\[mcp_servers\.tsukumo\]\n.*?(?=^\[|\Z)")


def _codex_mcp_block() -> str:
    return (
        "# Tsukumo: her body as tools (remove it from the panel).\n"
        "[mcp_servers.tsukumo]\n"
        f"command = {json.dumps(_python())}\n"
        f"args = {json.dumps([MCP_SCRIPT.as_posix()])}\n"
    )


def install_mcp_codex(path: Path | None = None) -> str:
    path = path or codex_config_path()
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    if "[mcp_servers.tsukumo]" in text:
        if MARK_MCP in text:
            return "already connected"
        raise ValueError("Codex already has an MCP server called 'tsukumo': I won't overwrite it.")
    _backup(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # A table goes after the top-level keys: at the end.
    path.write_text(text.rstrip("\n") + ("\n\n" if text.strip() else "") + _codex_mcp_block(), encoding="utf-8")
    return "connected"


def uninstall_mcp_codex(path: Path | None = None) -> str:
    path = path or codex_config_path()
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    if not _CODEX_MCP.search(text):
        return "was not connected"
    path.write_text(_CODEX_MCP.sub("", text).rstrip("\n") + "\n", encoding="utf-8")
    return "disconnected"


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
    gemini_path = gemini_settings_path()
    try:
        gemini_hooks = _read_json(gemini_path).get("hooks")
        gemini_events = _grouped_ours(gemini_hooks if isinstance(gemini_hooks, dict) else {}, GEMINI_EVENTS)
    except (OSError, ValueError):
        gemini_events = set()
    gemini_available = gemini_path.parent.is_dir() or bool(shutil.which("gemini"))
    result["gemini"] = {"label": NAMES["gemini"], "available": gemini_available, "installed": bool(gemini_events), "file": str(gemini_path)}
    cursor_path = cursor_hooks_path()
    try:
        cursor_events = _cursor_ours(_read_json(cursor_path))
    except (OSError, ValueError):
        cursor_events = set()
    cursor_available = cursor_path.parent.is_dir()
    result["cursor"] = {"label": NAMES["cursor"], "available": cursor_available, "installed": bool(cursor_events), "file": str(cursor_path)}
    try:
        approvals = _approvals_ours(_read_json(claude_path))
    except (OSError, ValueError):
        approvals = False
    result["claude_approvals"] = {"label": "Claude Code's permissions", "available": claude_available, "installed": approvals, "file": str(claude_path)}
    result["mcp_claude"] = {
        "label": NAMES["claude"],
        "available": bool(shutil.which("claude")),
        "installed": _mcp_json_has(claude_user_config_path()),
        "file": str(claude_user_config_path()),
    }
    result["mcp_codex"] = {"label": NAMES["codex"], "available": codex_path.parent.is_dir(), "installed": "[mcp_servers.tsukumo]" in text, "file": str(codex_path)}
    result["mcp_gemini"] = {"label": NAMES["gemini"], "available": gemini_available, "installed": _mcp_json_has(gemini_path), "file": str(gemini_path)}
    result["mcp_cursor"] = {"label": NAMES["cursor"], "available": cursor_available, "installed": _mcp_json_has(cursor_mcp_path()), "file": str(cursor_mcp_path())}
    return result


def change(tool: str, action: str) -> str:
    table = {
        ("claude", "install"): install_claude,
        ("claude", "uninstall"): uninstall_claude,
        ("codex", "install"): install_codex,
        ("codex", "uninstall"): uninstall_codex,
        ("claude_usage", "install"): install_statusline,
        ("claude_usage", "uninstall"): uninstall_statusline,
        ("gemini", "install"): install_gemini,
        ("gemini", "uninstall"): uninstall_gemini,
        ("cursor", "install"): install_cursor,
        ("cursor", "uninstall"): uninstall_cursor,
        ("claude_approvals", "install"): install_approvals,
        ("claude_approvals", "uninstall"): uninstall_approvals,
        ("mcp_claude", "install"): install_mcp_claude,
        ("mcp_claude", "uninstall"): uninstall_mcp_claude,
        ("mcp_codex", "install"): install_mcp_codex,
        ("mcp_codex", "uninstall"): uninstall_mcp_codex,
        ("mcp_gemini", "install"): lambda: _mcp_json_install(gemini_settings_path()),
        ("mcp_gemini", "uninstall"): lambda: _mcp_json_uninstall(gemini_settings_path()),
        ("mcp_cursor", "install"): lambda: _mcp_json_install(cursor_mcp_path()),
        ("mcp_cursor", "uninstall"): lambda: _mcp_json_uninstall(cursor_mcp_path()),
    }
    handler = table.get((tool, action))
    if handler is None:
        raise KeyError(f"{tool}/{action}")
    return handler()
