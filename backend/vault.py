"""The vault: personal values to copy on the fly (IBAN, tax code, plate, address).

"Copiami l'IBAN" puts it in the clipboard. The values are encrypted on disk
with Windows' DPAPI (tied to the user's account: another account or another
PC can't read the file); elsewhere they're only obfuscated, and ``protected``
says so in the panel.

The values never reach a brain or a remote client: the labels are public,
the value is read only by the local shell (``LOCAL_ONLY`` in security.py)
when it copies it, and the local command answers "copied" without saying it.
"""

from __future__ import annotations

import base64
import ctypes
import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .notebook import fold, match_score

logger = logging.getLogger(__name__)

MAX_LABEL = 60
MAX_VALUE = 500


# ---------------------------------------------------------------------------
# Encryption: DPAPI on Windows
# ---------------------------------------------------------------------------
if sys.platform == "win32":
    from ctypes import wintypes

    class _Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    _crypt32 = ctypes.windll.crypt32
    _kernel32 = ctypes.windll.kernel32
    _UI_FORBIDDEN = 0x01

    def _call(function: Any, data: bytes) -> bytes:
        buffer = ctypes.create_string_buffer(data, len(data))
        blob_in = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
        blob_out = _Blob()
        ok = function(ctypes.byref(blob_in), None, None, None, None, _UI_FORBIDDEN, ctypes.byref(blob_out))
        if not ok:
            raise OSError("DPAPI refused the data")
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            _kernel32.LocalFree(blob_out.pbData)

    def _protect(data: bytes) -> bytes:
        return _call(_crypt32.CryptProtectData, data)

    def _unprotect(data: bytes) -> bytes:
        return _call(_crypt32.CryptUnprotectData, data)

    PROTECTED = True
else:  # pragma: no cover - the app ships for Windows
    def _protect(data: bytes) -> bytes:
        return data

    def _unprotect(data: bytes) -> bytes:
        return data

    PROTECTED = False


def seal(value: str) -> str:
    return base64.b64encode(_protect(value.encode("utf-8"))).decode("ascii")


def unseal(sealed: str) -> str:
    return _unprotect(base64.b64decode(sealed.encode("ascii"))).decode("utf-8")


@dataclass
class Secret:
    label: str
    sealed: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    created: float = field(default_factory=time.time)

    def public(self) -> dict[str, Any]:
        """For the panel: the label and a hint, never the value."""
        try:
            value = unseal(self.sealed)
            hint = f"…{value[-4:]}" if len(value) > 6 else "••••"
        except Exception:
            hint = "?"
        return {"id": self.id, "label": self.label, "hint": hint, "created": self.created}


class Vault:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._items: dict[str, Secret] = {}
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        if not self.path or not self.path.is_file():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            for item in raw.get("items", []):
                secret = Secret(**{k: v for k, v in item.items() if k in Secret.__dataclass_fields__})
                self._items[secret.id] = secret
        except Exception as exc:
            logger.warning("Vault unreadable from %s: %s", self.path, exc)

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"items": [asdict(item) for item in self._items.values()]}, indent=1), encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError as exc:
            logger.warning("Vault not saved: %s", exc)

    def items(self) -> list[Secret]:
        with self._lock:
            return sorted(self._items.values(), key=lambda item: item.label.lower())

    def add(self, label: str, value: str) -> Secret:
        label = " ".join(str(label or "").split())[:MAX_LABEL]
        value = str(value or "").strip()[:MAX_VALUE]
        if not label or not value:
            raise ValueError("A name and a value are needed.")
        with self._lock:
            # The same name again replaces the value ("my new IBAN").
            for item in self._items.values():
                if fold(item.label) == fold(label):
                    item.sealed = seal(value)
                    secret = item
                    break
            else:
                secret = Secret(label=label, sealed=seal(value))
                self._items[secret.id] = secret
        self._save()
        return secret

    def remove(self, secret_id: str) -> Secret | None:
        with self._lock:
            removed = self._items.pop(secret_id, None)
        if removed:
            self._save()
        return removed

    def value(self, secret_id: str) -> str | None:
        item = self._items.get(secret_id)
        return unseal(item.sealed) if item else None

    def find(self, query: str) -> Secret | None:
        best, score = None, 0.0
        for item in self.items():
            value = 1.0 if fold(item.label) in fold(query) else match_score(item.label, query)
            if value > score:
                best, score = item, value
        return best if score >= 0.99 else None

    def as_dict(self) -> dict[str, Any]:
        return {"items": [item.public() for item in self.items()], "protected": PROTECTED}


_COPY = re.compile(
    r"^(?:(?:per favore|please|ehi|hey|tsukumo)[,\s]+)?(?:copia(?:mi)?|copy(?:\s+me)?|dammi|incolla(?:mi)?)\s+(?:il\s+|lo\s+|la\s+|l'|i\s+|gli\s+|le\s+|my\s+|the\s+|mio\s+|mia\s+)*(?P<what>.+?)[.!?]?$",
    re.IGNORECASE,
)


def copy_command(text: str, vault: Vault) -> Secret | None:
    """ "Copiami l'IBAN" -> the vault's item, if there's one with that name."""
    found = _COPY.match(" ".join(str(text or "").split()))
    if not found or not vault.items():
        return None
    return vault.find(found.group("what"))
