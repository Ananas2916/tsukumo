"""Tsukumo's body as tools: an MCP server for the agents you use on your own.

Claude Code, Codex, Gemini CLI, Cursor (connected from the panel, see
backend/notify.py) start it and talk to it over standard input/output
(JSON-RPC, one message per line). Its tools don't think and don't work on
your projects: they're the companion's body, for the agent to use.

* ``say`` - she says a short message (kept for later if you're away);
* ``show`` - a card in her chat and a bubble on her (a result, a link);
* ``remind`` - a reminder at a time;
* ``add_todo`` / ``add_note`` - her to-do list and notes;
* ``agenda`` - today's (and the next days') events, reminders and to-dos;
* ``presence`` - are you at the PC, focused, in a meeting?;
* ``search_notes`` - "where did I put...": notes, list, reminders, calendar.

If Tsukumo is off every tool answers so, and the agent carries on.
Standard library only: it runs with any Python.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tsukumo_notify import backend_url  # noqa: E402  (same folder: the running.json lookup)

VERSION = "1.0.0"
PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")

TOOLS: list[dict[str, Any]] = [
    {
        "name": "say",
        "description": (
            "Say a short message to the user through Tsukumo, their desktop companion: she speaks it in her voice "
            "and it appears in her chat. Use it to report that a long job is done or needs them, in one or two "
            "sentences, in the user's language. If they're away it's told when they're back."
        ),
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string", "description": "What to say (short)."}}, "required": ["text"]},
    },
    {
        "name": "show",
        "description": "Show a card in Tsukumo's chat (and a bubble on her): a result, a summary, a link to open.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "text": {"type": "string", "description": "A few lines of plain text."},
                "url": {"type": "string", "description": "Optional https link."},
            },
            "required": ["title"],
        },
    },
    {
        "name": "remind",
        "description": "Add a reminder to the user's agenda in Tsukumo: she says it at that time (on the PC and the phone).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "What to remind."},
                "at": {"type": "string", "description": "Local time, YYYY-MM-DDTHH:MM."},
                "in_minutes": {"type": "number", "description": "Or: in this many minutes."},
            },
            "required": ["text"],
        },
    },
    {
        "name": "add_todo",
        "description": "Add an item to the user's to-do list in Tsukumo (things without a time; she brings them up in a free moment).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "by": {"type": "string", "description": "Optional deadline, YYYY-MM-DD."},
                "important": {"type": "boolean"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "add_note",
        "description": "Keep a note in Tsukumo's notes (the user can find it again by asking her).",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    },
    {
        "name": "agenda",
        "description": "The user's agenda from Tsukumo: calendar events and reminders of the next days, and the open to-dos.",
        "inputSchema": {"type": "object", "properties": {"days": {"type": "integer", "minimum": 1, "maximum": 14}}},
    },
    {
        "name": "presence",
        "description": "Whether the user is at the PC right now, in a meeting or full screen, or in focus time (then prefer not to interrupt).",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "search_notes",
        "description": "Search the user's notes, to-dos, reminders and calendar kept by Tsukumo.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
]


class Off(Exception):
    """Tsukumo isn't running."""


def call(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    url = backend_url()
    if url is None:
        raise Off()
    request = urllib.request.Request(
        f"{url}{path}",
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("detail") or exc.reason
        except Exception:
            detail = exc.reason
        raise ValueError(str(detail)) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise Off() from exc


def run_tool(name: str, args: dict[str, Any]) -> str:
    source = os.environ.get("TSUKUMO_AGENT") or "agent"
    if name == "say":
        result = call("POST", "/api/agent/say", {"text": str(args.get("text") or ""), "source": source})
        return "Said." if result.get("spoken") else "The user isn't available now: she'll tell them when they're back."
    if name == "show":
        call("POST", "/api/agent/show", {"title": str(args.get("title") or ""), "text": str(args.get("text") or ""), "url": args.get("url") or None, "source": source})
        return "Shown."
    if name == "remind":
        body: dict[str, Any] = {"kind": "reminder", "text": str(args.get("text") or "")}
        if args.get("in_minutes"):
            body["seconds"] = float(args["in_minutes"]) * 60
        elif args.get("at"):
            body["at"] = str(args["at"])
        else:
            raise ValueError("Give 'at' or 'in_minutes'.")
        result = call("POST", "/api/reminders", body)
        return f"Reminder added: {result.get('reminder', {}).get('label', '')} at {result.get('reminder', {}).get('dueIso', '')}."
    if name == "add_todo":
        call("POST", "/api/todos", {"text": str(args.get("text") or ""), "by": args.get("by") or None, "important": bool(args.get("important"))})
        return "Added to the to-do list."
    if name == "add_note":
        call("POST", "/api/notes", {"text": str(args.get("text") or "")})
        return "Note kept."
    if name == "agenda":
        days = int(args.get("days") or 1)
        data = call("GET", f"/api/agent/agenda?days={max(1, min(14, days))}")
        lines = [f"{item['at']}  {item['title']}" for item in data.get("agenda", [])]
        todos = [f"- {item['text']}" + (f" (by {item['dueIso']})" if item.get("dueIso") else "") for item in data.get("todos", []) if not item.get("done")]
        return ("Agenda:\n" + ("\n".join(lines) or "nothing") + "\n\nTo-dos:\n" + ("\n".join(todos) or "none")).strip()
    if name == "presence":
        return json.dumps(call("GET", "/api/agent/presence"))
    if name == "search_notes":
        found = call("GET", "/api/agent/search?" + urllib.parse.urlencode({"q": str(args.get("query") or "")}))
        return found.get("found") or "Nothing found."
    raise ValueError(f"Unknown tool: {name}")


def handle(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    ident = message.get("id")
    if ident is None:
        return None  # a notification (initialized, cancelled...)
    if method == "initialize":
        asked = (message.get("params") or {}).get("protocolVersion")
        return {
            "jsonrpc": "2.0",
            "id": ident,
            "result": {
                "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "tsukumo", "version": VERSION},
                "instructions": "Tsukumo is the user's desktop companion. These tools are her body: speak through her, show a card, add reminders, to-dos and notes, read the agenda.",
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": ident, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": ident, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params") or {}
        try:
            text = run_tool(str(params.get("name") or ""), params.get("arguments") or {})
            return {"jsonrpc": "2.0", "id": ident, "result": {"content": [{"type": "text", "text": text}], "isError": False}}
        except Off:
            text = "Tsukumo isn't running on this PC right now."
        except Exception as exc:  # the agent gets the reason, the server stays up
            text = f"Error: {exc}"
        return {"jsonrpc": "2.0", "id": ident, "result": {"content": [{"type": "text", "text": text}], "isError": True}}
    return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"Method not found: {method}"}}


def main() -> int:
    # Windows pipes default to the ANSI code page: MCP is UTF-8.
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            reply: dict[str, Any] | None = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            reply = handle(message) if isinstance(message, dict) else None
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
