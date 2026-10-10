"""Claude Code and Codex hook: tells Tsukumo when they've finished.

The two programs launch it (see backend/notify.py, which connects it from
the panel):

* Claude Code: ``tsukumo_notify.py claude``, with the hook's JSON on
  standard input: ``Stop`` and ``Notification`` for the notifications,
  ``UserPromptSubmit`` (it started) and ``PostToolUse`` of the task-list
  tools for the agents' dashboard;
* Codex: ``tsukumo_notify.py codex '<json>'``, with the JSON as the last argument.

It must be instant and never fail: if Tsukumo is off (no
``state/running.json``) it exits right away, without even trying to connect.
Agents launched by Tsukumo herself have ``TSUKUMO_INTERNAL=1`` and don't
notify: she's already saying the answer.

Standard library only: it runs with any Python.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def state_folders() -> list[Path]:
    """Where Tsukumo's state can be: in the project (development) or in the
    user's data (installed app, see electron/main.js)."""
    folders = [os.environ.get("DC_STATE_DIR"), ROOT / "state"]
    if os.environ.get("APPDATA"):
        folders.append(Path(os.environ["APPDATA"]) / "Tsukumo" / "state")
    return [Path(folder) for folder in folders if folder]


def backend_url() -> str | None:
    forced = os.environ.get("TSUKUMO_URL")
    if forced:
        return forced.rstrip("/")
    for folder in state_folders():
        try:
            info = json.loads((folder / "running.json").read_text(encoding="utf-8"))
            return f"http://{info.get('host', '127.0.0.1')}:{int(info['port'])}"
        except (OSError, ValueError, KeyError):
            continue
    return None


def last_assistant_text(transcript: str) -> str:
    """Claude's last message in the session's JSONL transcript."""
    try:
        lines = Path(transcript).read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for raw in reversed(lines[-200:]):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if entry.get("type") != "assistant":
            continue
        content = (entry.get("message") or {}).get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            texts = [part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"]
            text = "\n".join(t for t in texts if t).strip()
            if text:
                return text
    return ""


#: Claude Code notifications worth calling you for: it's waiting for you.
WAITING = {"permission_prompt", "agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"}
#: The task-list tools (the other PostToolUse don't arrive: there's the matcher).
TASK_TOOLS = {"TodoWrite", "TaskCreate", "TaskUpdate"}


def _where(payload: dict, source: str) -> dict:
    """Which session and in which folder: the dashboard keeps them apart."""
    session = payload.get("session_id") or payload.get("thread-id") or payload.get("thread_id") or ""
    cwd = str(payload.get("cwd") or "")
    return {"source": source, "session": str(session)[:120], "project": Path(cwd).name if cwd else ""}


def from_claude(payload: dict) -> dict | None:
    event = payload.get("hook_event_name")
    where = _where(payload, "claude")
    if event == "Notification":
        kind = payload.get("notification_type")
        # "idle_prompt", "auth_success"...: noise (Stop already says it has finished).
        if kind is not None and kind not in WAITING:
            return None
        return {**where, "kind": "waiting", "message": str(payload.get("message") or "")}
    if event == "Stop":
        if payload.get("stop_hook_active"):
            return None
        message = str(payload.get("last_assistant_message") or "")
        if not message:
            message = last_assistant_text(str(payload.get("transcript_path") or ""))
        return {**where, "kind": "done", "message": message}
    if event == "UserPromptSubmit":
        return {**where, "kind": "working", "message": str(payload.get("prompt") or "")[:300]}
    if event == "PostToolUse" and payload.get("tool_name") in TASK_TOOLS:
        response = payload.get("tool_response")
        return {
            **where,
            "kind": "tasks",
            "tool": payload["tool_name"],
            "input": payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {},
            # The task number is enough: no long answers.
            "response": response if isinstance(response, (dict, list)) and len(json.dumps(response)) < 4000 else str(response or "")[:400],
        }
    return None


def from_codex(payload: dict) -> dict | None:
    if payload.get("type") != "agent-turn-complete":
        return None
    return {**_where(payload, "codex"), "kind": "done", "message": str(payload.get("last-assistant-message") or "")}


def send(url: str, body: dict) -> None:
    request = urllib.request.Request(
        f"{url}/api/notify",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(request, timeout=2).read()


def main(argv: list[str]) -> int:
    if os.environ.get("TSUKUMO_INTERNAL") == "1" or len(argv) < 2:
        return 0
    url = backend_url()
    if url is None:
        return 0
    tool = argv[1]
    try:
        if tool == "claude":
            body = from_claude(json.loads(sys.stdin.read() or "{}"))
        elif tool == "codex":
            body = from_codex(json.loads(argv[-1] if len(argv) > 2 else "{}"))
        else:
            return 0
        if body:
            send(url, body)
    except Exception:
        pass  # a lost notification must never block the agent
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
