"""Cosa sta facendo un agente, detto in parole: "legge main.js", "cerca in rete".

Un agente puo' lavorare per un minuto prima di dire qualcosa. In quel tempo
Claude Code, Codex e OpenClaw raccontano nei loro eventi quali tool usano: qui
diventano frasi corte (in italiano, come il resto dell'interfaccia) e un
genere di lavoro che sceglie la posa del personaggio.

Le etichette cominciano col verbo in terza persona e minuscolo: chi le mostra
decide se premettere il nome dell'agente ("Codex legge...") o la maiuscola.
"""

from __future__ import annotations

import re
import shlex
from pathlib import PurePath, PurePosixPath, PureWindowsPath
from typing import Any
from urllib.parse import urlparse

from .base import Activity

#: Oltre questa lunghezza un pezzo di etichetta viene accorciato con "…".
MAX_PIECE = 36


def _short(text: Any, limit: int = MAX_PIECE) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _name(path: Any) -> str:
    """Solo il nome del file, con qualunque separatore."""
    raw = str(path or "").strip().strip('"')
    if not raw:
        return ""
    cls: type[PurePath] = PureWindowsPath if "\\" in raw or re.match(r"^[A-Za-z]:", raw) else PurePosixPath
    return cls(raw).name or raw


def _command_words(command: Any) -> str:
    """Il programma lanciato e il suo sottocomando: ``git status``, ``npm test``.

    Toglie gli involucri che gli agenti aggiungono (``bash -lc '...'``,
    ``powershell -Command ...``): conta quello che c'e' dentro.
    """
    if isinstance(command, list):
        parts = [str(part) for part in command]
    else:
        text = str(command or "").strip()
        try:
            parts = shlex.split(text, posix=True)
        except ValueError:
            parts = text.split()
    while len(parts) >= 3 and _name(parts[0]).lower().removesuffix(".exe") in {"bash", "sh", "zsh", "cmd", "powershell", "pwsh"}:
        flag = parts[1].lower()
        if flag not in {"-c", "-lc", "/c", "-command", "-noprofile", "-nologo"}:
            break
        rest = [part for part in parts[2:] if part.lower() not in {"-command", "-noprofile", "-nologo"}]
        if not rest:
            break
        inner = rest[0] if len(rest) == 1 else " ".join(rest)
        try:
            parts = shlex.split(inner, posix=True)
        except ValueError:
            parts = inner.split()
    if not parts:
        return ""
    words = [_name(parts[0]).removesuffix(".exe")]
    if len(parts) > 1 and re.fullmatch(r"[a-z][a-z0-9_-]{1,20}", parts[1]):
        words.append(parts[1])
    return " ".join(words)


def _host(url: Any) -> str:
    try:
        host = urlparse(str(url or "")).hostname or ""
    except ValueError:
        return ""
    return host.removeprefix("www.")


def _mcp(server: str, tool: str) -> Activity:
    readable = tool.replace("_", " ").strip() or "uno strumento"
    return Activity("tool", f"usa {_short(readable, 28)} ({_short(server, 20)})", tool=f"mcp:{server}/{tool}")


# ---------------------------------------------------------------------------
# Claude Code
# ---------------------------------------------------------------------------
def describe_claude_tool(name: str, data: dict[str, Any] | None) -> Activity:
    """Un blocco ``tool_use`` di Claude Code (nome del tool e il suo input)."""
    data = data or {}
    path = data.get("file_path") or data.get("notebook_path") or data.get("path") or ""
    if name in {"Read", "NotebookRead"}:
        return Activity("read", f"legge {_short(_name(path)) or 'un file'}", str(path), name)
    if name == "Write":
        return Activity("write", f"scrive {_short(_name(path)) or 'un file'}", str(path), name)
    if name in {"Edit", "MultiEdit", "NotebookEdit"}:
        return Activity("write", f"modifica {_short(_name(path)) or 'un file'}", str(path), name)
    if name in {"Glob", "LS"}:
        pattern = data.get("pattern") or path
        return Activity("search", f"cerca i file {_short(pattern)}".rstrip(), str(pattern), name)
    if name == "Grep":
        pattern = data.get("pattern") or ""
        return Activity("search", f"cerca «{_short(pattern, 28)}»" if pattern else "cerca nel codice", str(pattern), name)
    if name in {"Bash", "PowerShell", "BashOutput"}:
        command = data.get("command") or ""
        words = _command_words(command)
        return Activity("run", f"esegue {_short(words, 28)}" if words else "esegue un comando", str(command), name)
    if name == "WebSearch":
        query = data.get("query") or ""
        return Activity("web", f"cerca in rete «{_short(query, 30)}»" if query else "cerca in rete", str(query), name)
    if name == "WebFetch":
        url = data.get("url") or ""
        host = _host(url)
        return Activity("web", f"apre {host}" if host else "apre una pagina web", str(url), name)
    if name in {"Task", "Agent"}:
        what = data.get("description") or ""
        return Activity("agent", "passa un compito a un aiutante", str(what), name)
    if name in {"TodoWrite", "EnterPlanMode", "ExitPlanMode", "TaskCreate", "TaskUpdate"}:
        return Activity("plan", "organizza il lavoro", "", name)
    if name == "Skill":
        skill = data.get("skill") or data.get("name") or ""
        return Activity("tool", f"usa la skill {_short(skill, 28)}" if skill else "usa una skill", str(skill), name)
    if name.startswith("mcp__"):
        _, _, rest = name.partition("__")
        server, _, tool = rest.partition("__")
        return _mcp(server, tool)
    return Activity("tool", f"usa {_short(name, 28)}", "", name)


# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------
_CHANGE_VERB = {"add": "crea", "create": "crea", "delete": "elimina", "remove": "elimina"}


def describe_codex_item(item: dict[str, Any]) -> Activity | None:
    """Un ``item`` di ``codex exec --json``; ``None`` se non e' lavoro da raccontare."""
    kind = item.get("type")
    if kind == "command_execution":
        command = item.get("command") or ""
        words = _command_words(command)
        return Activity("run", f"esegue {_short(words, 28)}" if words else "esegue un comando", str(command), kind)
    if kind == "file_change":
        changes = [change for change in item.get("changes") or [] if isinstance(change, dict)]
        if len(changes) == 1:
            change = changes[0]
            verb = _CHANGE_VERB.get(str(change.get("kind") or ""), "modifica")
            return Activity("write", f"{verb} {_short(_name(change.get('path')))}", str(change.get("path") or ""), kind)
        count = len(changes)
        return Activity("write", f"modifica {count} file" if count else "modifica dei file", "", kind)
    if kind == "mcp_tool_call":
        return _mcp(str(item.get("server") or ""), str(item.get("tool") or ""))
    if kind == "web_search":
        query = item.get("query") or ""
        return Activity("web", f"cerca in rete «{_short(query, 30)}»" if query else "cerca in rete", str(query), kind)
    if kind == "todo_list":
        return Activity("plan", "organizza il lavoro", "", kind)
    return None


# ---------------------------------------------------------------------------
# Antigravity
# ---------------------------------------------------------------------------
_ANTIGRAVITY_KIND = {
    "view_file": "read",
    "read_resource": "read",
    "list_resources": "search",
    "list_dir": "search",
    "find_by_name": "search",
    "grep_search": "search",
    "write_to_file": "write",
    "replace_file_content": "write",
    "multi_replace_file_content": "write",
    "sed_file": "write",
    "notebook_edit": "write",
    "run_command": "run",
    "send_command_input": "run",
    "notebook_execution": "run",
    "search_web": "web",
    "read_url_content": "web",
    "open_browser_url": "web",
    "invoke_subagent": "agent",
    "browser_subagent": "agent",
    "define_subagent": "agent",
    "manage_subagents": "agent",
    "manage_task": "plan",
    "schedule": "plan",
}

_ANTIGRAVITY_SILENT = frozenset(
    {
        "finish", "wait", "wait_5_seconds", "command_status", "ask_permission", "ask_custom_permission",
        "list_permissions", "ask_question", "send_message", "manage_inbox",
    }
)


def describe_antigravity_tool(name: str, params: dict[str, Any] | None) -> Activity | None:
    """Un passo ``tool`` di ``agy --output-format stream-json`` (nome e ``tool_info.parameters``).

    I parametri hanno nomi in PascalCase (``CommandLine``, ``TargetFile``...): si
    cercano per parola chiave invece che per nome esatto.
    """
    key = name.lower()
    if key in _ANTIGRAVITY_SILENT:
        return None
    lowered = {str(k).lower(): v for k, v in (params or {}).items()}

    def pick(*words: str) -> str:
        return str(next((v for k, v in lowered.items() if v and any(w in k for w in words)), ""))

    if key == "call_mcp_tool":
        return _mcp(pick("server"), pick("tool", "name"))
    kind = _ANTIGRAVITY_KIND.get(key, "web" if "browser" in key else "tool")
    path = pick("path", "file")
    if kind == "read":
        return Activity("read", f"legge {_short(_name(path)) or 'un file'}", path, name)
    if kind == "write":
        return Activity("write", f"modifica {_short(_name(path)) or 'un file'}", path, name)
    if kind == "search":
        query = pick("query", "pattern")
        if query:
            return Activity("search", f"cerca «{_short(query, 28)}»", query, name)
        return Activity("search", f"guarda la cartella {_short(_name(path))}".rstrip(), path, name)
    if kind == "run":
        command = pick("commandline", "command")
        words = _command_words(command)
        return Activity("run", f"esegue {_short(words, 28)}" if words else "esegue un comando", command, name)
    if kind == "web":
        query = pick("query")
        if query:
            return Activity("web", f"cerca in rete «{_short(query, 30)}»", query, name)
        url = pick("url")
        host = _host(url)
        return Activity("web", f"apre {host}" if host else "naviga in rete", url, name)
    if kind == "agent":
        return Activity("agent", "passa un compito a un aiutante", "", name)
    if kind == "plan":
        return Activity("plan", "organizza il lavoro", "", name)
    return Activity("tool", f"usa {_short(name.replace('_', ' '), 28)}", "", name)


# ---------------------------------------------------------------------------
# OpenClaw
# ---------------------------------------------------------------------------
_OPENCLAW_KIND = {
    "read": "read",
    "pdf": "read",
    "view_image": "read",
    "ls": "search",
    "write": "write",
    "edit": "write",
    "apply_patch": "write",
    "exec": "run",
    "process": "run",
    "terminal": "run",
    "web_search": "web",
    "web_fetch": "web",
    "browser": "web",
    "memory_search": "search",
    "memory_get": "read",
    "sessions_spawn": "agent",
    "sessions_send": "agent",
    "subagents": "agent",
    "agents_wait": "agent",
    "create_goal": "plan",
    "update_goal": "plan",
    "progress_card": "plan",
}

#: Tool di servizio: non sono lavoro che valga la pena raccontare.
_OPENCLAW_SILENT = frozenset(
    {"heartbeat_respond", "structured_output", "session_status", "get_goal", "sessions_yield", "theme", "tts", "message"}
)


def describe_openclaw_tool(name: str, args: dict[str, Any] | None) -> Activity | None:
    """Un tool chiamato da un agente OpenClaw (eventi ``agent``, canale ``tool``)."""
    args = args or {}
    key = name.lower()
    if key in _OPENCLAW_SILENT:
        return None
    kind = _OPENCLAW_KIND.get(key, "tool")
    path = args.get("path") or args.get("file_path") or args.get("file") or ""
    if kind == "read":
        what = _short(_name(path)) or ("un'immagine" if key == "view_image" else "un file")
        return Activity("read", f"legge {what}" if key != "view_image" else f"guarda {what}", str(path), name)
    if kind == "write":
        return Activity("write", f"modifica {_short(_name(path)) or 'dei file'}", str(path), name)
    if kind == "run":
        command = args.get("command") or args.get("cmd") or ""
        words = _command_words(command)
        return Activity("run", f"esegue {_short(words, 28)}" if words else "esegue un comando", str(command), name)
    if key == "web_search":
        query = args.get("query") or ""
        return Activity("web", f"cerca in rete «{_short(query, 30)}»" if query else "cerca in rete", str(query), name)
    if key in {"web_fetch", "browser"}:
        host = _host(args.get("url") or args.get("targetUrl"))
        return Activity("web", f"apre {host}" if host else "naviga in rete", str(args.get("url") or ""), name)
    if key.startswith("memory"):
        return Activity(kind, "cerca nei ricordi", str(args.get("query") or ""), name)
    if key == "ls":
        return Activity("search", f"guarda la cartella {_short(_name(path))}".rstrip(), str(path), name)
    if kind == "agent":
        return Activity("agent", "passa un compito a un aiutante", "", name)
    if kind == "plan":
        return Activity("plan", "organizza il lavoro", "", name)
    if key.endswith("_generate"):
        what = {"image_generate": "un'immagine", "video_generate": "un video", "music_generate": "della musica"}
        return Activity("tool", f"crea {what.get(key, 'qualcosa')}", "", name)
    return Activity(kind, f"usa {_short(name.replace('_', ' '), 28)}", "", name)
