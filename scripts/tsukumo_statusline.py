"""Claude Code's status line: passes the plan's limits to Tsukumo.

Claude Code runs the ``statusLine`` command at every answer, with a JSON
on standard input that (for Pro and Max subscribers) holds ``rate_limits``:
how much of the 5-hour and the 7-day windows is used, and when they
reset. It's the only place where Claude Code makes them available: this
script saves them in ``state/claude_limits.json``, which the backend reads
(``backend/usage.py``). The panel connects and disconnects it (backend/notify.py).

Then it prints the status line: the one there was before, if any (``--then``
with the old configuration in base64, run with the same input), otherwise
its own, compact: model, context, limits.

It must be instant and never fail. Standard library only.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tsukumo_notify import state_folders  # noqa: E402

LIMITS_FILE = "claude_limits.json"
#: Even without changes it's rewritten now and then: "at" says how fresh the reading is.
REWRITE_EVERY = 60


def target_folder() -> Path | None:
    """Where Tsukumo's state is: the one given, the one running, or the first that exists."""
    if os.environ.get("DC_STATE_DIR"):
        return Path(os.environ["DC_STATE_DIR"])
    folders = state_folders()
    for folder in folders:
        if (folder / "running.json").is_file():
            return folder
    return next((folder for folder in folders if folder.is_dir()), None)


def save(payload: dict) -> None:
    limits = payload.get("rate_limits")
    if not isinstance(limits, dict) or not limits:
        return
    folder = target_folder()
    if folder is None:
        return
    path = folder / LIMITS_FILE
    try:
        old = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        old = {}
    now = time.time()
    if isinstance(old, dict) and old.get("rate_limits") == limits and now - float(old.get("at") or 0) < REWRITE_EVERY:
        return
    record = {"at": now, "model": (payload.get("model") or {}).get("display_name"), "rate_limits": limits}
    temporary = path.with_name(f"{LIMITS_FILE}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(record), encoding="utf-8")
    os.replace(temporary, path)


def own_line(payload: dict) -> str:
    parts = []
    model = (payload.get("model") or {}).get("display_name")
    if model:
        parts.append(str(model))
    context = (payload.get("context_window") or {}).get("used_percentage")
    if isinstance(context, (int, float)):
        parts.append(f"ctx {round(context)}%")
    limits = payload.get("rate_limits") or {}
    for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
        window = limits.get(key)
        if isinstance(window, dict) and isinstance(window.get("used_percentage"), (int, float)):
            parts.append(f"{label} {round(window['used_percentage'])}%")
    return " · ".join(parts)


def previous_line(encoded: str, raw: bytes) -> str:
    """The previous status line, run as Claude Code would run it (on Windows with Git Bash)."""
    config = json.loads(base64.urlsafe_b64decode(encoded.encode()).decode("utf-8"))
    command = str(config.get("command") or "")
    if not command:
        return ""
    bash = os.environ.get("CLAUDE_CODE_GIT_BASH_PATH") or (shutil.which("bash") if os.name == "nt" else None)
    args = [bash, "-c", command] if bash else command
    result = subprocess.run(args, input=raw, capture_output=True, shell=not bash, timeout=5)
    return result.stdout.decode("utf-8", "replace").rstrip("\n")


def main(argv: list[str]) -> int:
    raw = sys.stdin.buffer.read()
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    try:
        save(payload)
    except Exception:
        pass  # a lost reading must never break the status line
    line = ""
    if len(argv) > 2 and argv[1] == "--then":
        try:
            line = previous_line(argv[2], raw)
        except Exception:
            line = ""
    if not line:
        line = own_line(payload)
    # Claude Code reads UTF-8; the Windows console wouldn't be.
    sys.stdout.buffer.write(line.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
