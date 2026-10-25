"""What Windows' accessibility tree says is in a window: names and rectangles.

Most programs (browsers, Office, Settings, Explorer, Electron apps) describe
their buttons, menus and fields to screen readers through UI Automation:
when the brain names a button by its text, the spot is exact and no image
has to leave the PC. Programs that draw everything themselves (Deeds,
games, canvases) expose nothing, and the eye takes over (``eye.py``).

PowerShell reads the tree: .NET's UIAutomationClient ships with Windows,
so there's nothing to install.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: A browser page can hold thousands of elements: past these, the eye does the rest.
MAX_ELEMENTS = 600
TIMEOUT = 6.0

# Only what's on screen and has a name. The window's own rectangle comes back
# too: PowerShell may not be DPI-aware, and comparing it with the real one
# (in physical pixels, from Electron) converts every rectangle.
_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$root = $A::FromHandle([IntPtr]::new(__HWND__))
$r = $root.Current.BoundingRectangle
$visible = New-Object System.Windows.Automation.PropertyCondition($A::IsOffscreenProperty, $false)
$unnamed = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, '')
$cond = New-Object System.Windows.Automation.AndCondition($visible, (New-Object System.Windows.Automation.NotCondition($unnamed)))
$out = New-Object System.Collections.Generic.List[object]
foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
  if ($out.Count -ge __MAX__) { break }
  try {
    $c = $e.Current; $b = $c.BoundingRectangle
    if ($b.IsEmpty -or $b.Width -lt 2 -or $b.Height -lt 2) { continue }
    $n = $c.Name; if ($n.Length -gt 120) { $n = $n.Substring(0, 120) }
    $out.Add(@{ n = $n; t = $c.ControlType.ProgrammaticName.Replace('ControlType.', ''); x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height })
  } catch {}
}
$win = $null
if (-not $r.IsEmpty) { $win = @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }
@{ window = $win; items = $out.ToArray() } | ConvertTo-Json -Depth 4 -Compress
"""


@dataclass(frozen=True)
class Element:
    name: str
    #: UI Automation's control type: Button, Edit, MenuItem, TabItem, Hyperlink...
    kind: str
    #: Physical screen pixels.
    x: int
    y: int
    width: int
    height: int

    def rect(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}


def _run(hwnd: int) -> str:
    script = _SCRIPT.replace("__HWND__", str(int(hwnd))).replace("__MAX__", str(MAX_ELEMENTS))
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        capture_output=True,
        timeout=TIMEOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or "PowerShell failed")
    return result.stdout.decode("utf-8", "replace")


def parse(raw: str, window: dict[str, Any]) -> list[Element]:
    """PowerShell's JSON -> elements in physical pixels, using the real ``window`` rectangle."""
    try:
        data = json.loads(raw.lstrip("﻿") or "{}")
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict):
        return []
    seen = data.get("window") or {}
    items = data.get("items") or []
    if isinstance(items, dict):  # ConvertTo-Json writes a lone element without the list
        items = [items]
    try:
        sx = window["width"] / seen["w"] if seen.get("w") else 1.0
        sy = window["height"] / seen["h"] if seen.get("h") else 1.0
        ox, oy = window["x"] - seen.get("x", window["x"]) * sx, window["y"] - seen.get("y", window["y"]) * sy
    except (KeyError, TypeError, ZeroDivisionError):
        sx = sy = 1.0
        ox = oy = 0.0
    found: list[Element] = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("n"), str):
            continue
        try:
            found.append(
                Element(
                    name=item["n"].strip(),
                    kind=str(item.get("t") or ""),
                    x=round(item["x"] * sx + ox),
                    y=round(item["y"] * sy + oy),
                    width=max(1, round(item["w"] * sx)),
                    height=max(1, round(item["h"] * sy)),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return found


async def elements(hwnd: int | None, window: dict[str, Any] | None) -> list[Element]:
    """The named, visible elements of a window; empty where Windows can't say (or off Windows)."""
    if not hwnd or not window or sys.platform != "win32":
        return []
    try:
        raw = await asyncio.to_thread(_run, hwnd)
    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
        logger.info("Accessibility tree unavailable: %s", exc)
        return []
    return parse(raw, window)


# ---------------------------------------------------------------------------
# Matching what the brain described
# ---------------------------------------------------------------------------
# Only double quotes and guillemets: in Italian a single one is an apostrophe ("l'AND").
_QUOTED = re.compile(r"[\"“”«»]([^\"“”«»]{1,80})[\"“”«»]")
#: Words in the description that say which kind of control it is.
_KIND_WORDS = {
    "Button": ("button", "pulsante", "bottone", "tasto", "icona", "icon"),
    "Edit": ("field", "campo", "casella", "box", "input", "search bar", "barra di ricerca"),
    "MenuItem": ("menu", "voce"),
    "TabItem": ("tab", "scheda"),
    "Hyperlink": ("link", "collegamento"),
    "CheckBox": ("checkbox", "check box", "spunta"),
    "ComboBox": ("dropdown", "drop-down", "a tendina"),
    "ListItem": ("item", "elemento"),
}


def _norm(text: str) -> str:
    """Comparable text: no case, no accelerators (&File), no ellipses or edge punctuation."""
    text = unicodedata.normalize("NFKC", text or "").replace("&", "").replace("…", "").replace("...", "")
    return " ".join(text.casefold().split()).strip(" .:;,-")


def match(description: str, found: list[Element]) -> Element | None:
    """The element the description names by its text, in quotes; None if unsure.

    Only exact names or names starting with the quoted text count: anything
    vaguer goes to the eye, which sees the screenshot.
    """
    quoted = [_norm(text) for text in _QUOTED.findall(description or "")]
    quoted = [text for text in quoted if text]
    if not quoted or not found:
        return None
    lowered = description.lower()
    kinds = {kind for kind, words in _KIND_WORDS.items() if any(word in lowered for word in words)}
    best: Element | None = None
    best_key: tuple[float, float] | None = None
    for element in found:
        name = _norm(element.name)
        if not name:
            continue
        score = 0.0
        for text in quoted:
            if name == text:
                score = max(score, 3.0)
            elif len(text) >= 3 and name.startswith(text):
                score = max(score, 2.0)
        if score < 2.0:
            continue
        if element.kind in kinds:
            score += 0.5
        # On a tie the smaller one: the button, not the toolbar that bears its name.
        key = (score, -element.width * element.height)
        if best_key is None or key > best_key:
            best, best_key = element, key
    return best
