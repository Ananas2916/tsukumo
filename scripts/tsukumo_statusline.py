"""Barra di stato di Claude Code: passa a Tsukumo i limiti del piano.

Claude Code lancia il comando di ``statusLine`` a ogni risposta, con un JSON
sullo standard input che (per gli abbonati Pro e Max) contiene ``rate_limits``:
quanto e' usata la finestra di 5 ore e quella di 7 giorni, e quando si
azzerano. E' l'unico posto in cui Claude Code li rende disponibili: questo
script li salva in ``state/claude_limits.json``, che il backend legge
(``backend/usage.py``). Lo collega e lo scollega il pannello (backend/notify.py).

Poi stampa la barra: quella che c'era prima, se c'era (``--then`` con la
vecchia configurazione in base64, lanciata con lo stesso input), altrimenti
una sua, compatta: modello, contesto, limiti.

Deve essere istantaneo e non fallire mai. Solo libreria standard.
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
#: Anche senza cambiamenti, ogni tanto si riscrive: "at" dice quanto e' fresca la lettura.
REWRITE_EVERY = 60


def target_folder() -> Path | None:
    """Dove sta lo stato di Tsukumo: quello indicato, quello acceso, o il primo che esiste."""
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
    """La barra di prima, lanciata come la lancerebbe Claude Code (su Windows con Git Bash)."""
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
        pass  # una lettura persa non deve mai rompere la barra
    line = ""
    if len(argv) > 2 and argv[1] == "--then":
        try:
            line = previous_line(argv[2], raw)
        except Exception:
            line = ""
    if not line:
        line = own_line(payload)
    # Claude Code legge UTF-8; la console di Windows non lo sarebbe.
    sys.stdout.buffer.write(line.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
