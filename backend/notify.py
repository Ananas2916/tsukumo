"""Avvisi dagli agenti che usi per conto tuo: "Claude Code ha finito!".

Quando lavori con Claude Code o Codex in un terminale o in VS Code e ti metti a
fare altro, e' il companion a chiamarti quando hanno finito (o quando ti
aspettano per un permesso). Funziona con gli hook dei due programmi:

* Claude Code: ``hooks.Stop`` e ``hooks.Notification`` in ``~/.claude/settings.json``;
* Codex: ``notify = [...]`` in ``~/.codex/config.toml``.

Entrambi lanciano ``scripts/tsukumo_notify.py``, che manda il messaggio a
``POST /api/notify``. Collegarli e scollegarli si fa dal pannello
(``install``/``uninstall`` qui sotto): tocca file di configurazione fuori dal
progetto, quindi solo su richiesta, con una copia di sicurezza.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "tsukumo_notify.py"
MARK = "tsukumo_notify.py"

NAMES = {"claude": "Claude Code", "codex": "Codex"}


def claude_settings_path() -> Path:
    return Path.home() / ".claude" / "settings.json"


def codex_config_path() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"


def _python() -> str:
    """L'interprete del backend (quello del venv), con le barre in avanti: vale in cmd e in bash."""
    return Path(sys.executable).as_posix()


def claude_hook() -> dict[str, Any]:
    """Forma "exec" (command + args): parte direttamente, che la shell sia bash o PowerShell."""
    return {"type": "command", "command": _python(), "args": [SCRIPT.as_posix(), "claude"], "timeout": 10}


# ---------------------------------------------------------------------------
# Testo dell'avviso
# ---------------------------------------------------------------------------
def summary_of(message: str, limit: int = 160) -> str:
    """La prima frase utile, senza markdown ne' blocchi di codice."""
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
# Collegamento: Claude Code
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


def _claude_has(settings: dict[str, Any]) -> bool:
    for event in ("Stop", "Notification"):
        for group in _claude_hooks(settings).get(event) or []:
            for hook in (group or {}).get("hooks") or []:
                if _is_ours(hook):
                    return True
    return False


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8") or "{}")
    if not isinstance(data, dict):
        raise ValueError(f"{path} non contiene un oggetto JSON")
    return data


def install_claude(path: Path | None = None) -> str:
    path = path or claude_settings_path()
    settings = _read_json(path)
    if _claude_has(settings):
        return "già collegato"
    _backup(path)
    hooks = settings.setdefault("hooks", {})
    for event in ("Stop", "Notification"):
        hooks.setdefault(event, []).append({"hooks": [claude_hook()]})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "collegato"


def uninstall_claude(path: Path | None = None) -> str:
    path = path or claude_settings_path()
    settings = _read_json(path)
    if not _claude_has(settings):
        return "non era collegato"
    hooks = _claude_hooks(settings)
    for event in ("Stop", "Notification"):
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
    return "scollegato"


# ---------------------------------------------------------------------------
# Collegamento: Codex
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
            return "già collegato"
        raise ValueError("Codex ha già un comando 'notify' in config.toml: non lo sovrascrivo.")
    _backup(path)
    # Le chiavi di primo livello vanno prima di qualsiasi [tabella]: in cima.
    block = f"# Tsukumo: avvisa quando Codex ha finito (si toglie dal pannello).\n{_codex_line()}\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(block + ("\n" + text if text else ""), encoding="utf-8")
    return "collegato"


def uninstall_codex(path: Path | None = None) -> str:
    path = path or codex_config_path()
    if not path.is_file():
        return "non era collegato"
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    kept = [line for line in lines if not (MARK in line and _NOTIFY_LINE.match(line)) and not line.startswith("# Tsukumo: avvisa")]
    if len(kept) == len(lines):
        return "non era collegato"
    text = "".join(kept).lstrip("\n")
    path.write_text(text, encoding="utf-8")
    return "scollegato"


# ---------------------------------------------------------------------------
# Stato, per il pannello
# ---------------------------------------------------------------------------
def status() -> dict[str, Any]:
    result: dict[str, Any] = {}
    claude_path = claude_settings_path()
    try:
        claude_installed = _claude_has(_read_json(claude_path))
    except (OSError, ValueError):
        claude_installed = False
    result["claude"] = {
        "label": NAMES["claude"],
        "available": claude_path.parent.is_dir() or bool(shutil.which("claude")),
        "installed": claude_installed,
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
    }
    handler = table.get((tool, action))
    if handler is None:
        raise KeyError(f"{tool}/{action}")
    return handler()
