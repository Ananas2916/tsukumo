"""Hook di Claude Code e Codex: avvisa Tsukumo quando hanno finito.

Lo lanciano i due programmi (vedi backend/notify.py, che lo collega dal
pannello):

* Claude Code: ``tsukumo_notify.py claude``, con il JSON dell'hook sullo
  standard input (``Stop`` o ``Notification``);
* Codex: ``tsukumo_notify.py codex '<json>'``, con il JSON come ultimo argomento.

Deve essere istantaneo e non fallire mai: se Tsukumo e' spento (niente
``state/running.json``) esce subito, senza nemmeno provare a connettersi. Gli
agenti lanciati da Tsukumo stesso hanno ``TSUKUMO_INTERNAL=1`` e non avvisano:
la risposta la sta gia' dicendo lei.

Solo libreria standard: gira con qualunque Python.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def backend_url() -> str | None:
    forced = os.environ.get("TSUKUMO_URL")
    if forced:
        return forced.rstrip("/")
    marker = Path(os.environ.get("DC_STATE_DIR") or ROOT / "state") / "running.json"
    try:
        info = json.loads(marker.read_text(encoding="utf-8"))
        return f"http://{info.get('host', '127.0.0.1')}:{int(info['port'])}"
    except (OSError, ValueError, KeyError):
        return None


def last_assistant_text(transcript: str) -> str:
    """L'ultimo messaggio di Claude nella trascrizione JSONL della sessione."""
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


#: Notifiche di Claude Code per cui vale la pena chiamarti: ti sta aspettando.
WAITING = {"permission_prompt", "agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"}


def from_claude(payload: dict) -> dict | None:
    event = payload.get("hook_event_name")
    if event == "Notification":
        kind = payload.get("notification_type")
        # "idle_prompt", "auth_success"...: rumore (che ha finito lo dice gia' Stop).
        if kind is not None and kind not in WAITING:
            return None
        return {"source": "claude", "kind": "waiting", "message": str(payload.get("message") or "")}
    if event == "Stop":
        if payload.get("stop_hook_active"):
            return None
        message = str(payload.get("last_assistant_message") or "")
        if not message:
            message = last_assistant_text(str(payload.get("transcript_path") or ""))
        return {"source": "claude", "kind": "done", "message": message}
    return None


def from_codex(payload: dict) -> dict | None:
    if payload.get("type") != "agent-turn-complete":
        return None
    return {"source": "codex", "kind": "done", "message": str(payload.get("last-assistant-message") or "")}


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
        pass  # un avviso perso non deve mai bloccare l'agente
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
