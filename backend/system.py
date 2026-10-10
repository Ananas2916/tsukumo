"""PC state the backend can read by itself: for now the battery.

No dependencies: on Windows ``GetSystemPowerStatus`` via ctypes, on Linux the
``/sys/class/power_supply`` files. A desktop without a battery, or a system
we can't read, returns ``None``.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Battery:
    percent: int
    #: Plugged in (charging or charged).
    plugged: bool


def battery() -> Battery | None:
    if sys.platform == "win32":
        return _windows_battery()
    if sys.platform.startswith("linux"):
        return _linux_battery()
    return None


def _windows_battery() -> Battery | None:
    try:
        import ctypes
        from ctypes import wintypes

        class SystemPowerStatus(ctypes.Structure):
            _fields_ = [
                ("ACLineStatus", wintypes.BYTE),
                ("BatteryFlag", wintypes.BYTE),
                ("BatteryLifePercent", wintypes.BYTE),
                ("SystemStatusFlag", wintypes.BYTE),
                ("BatteryLifeTime", wintypes.DWORD),
                ("BatteryFullLifeTime", wintypes.DWORD),
            ]

        status = SystemPowerStatus()
        if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status)):  # type: ignore[attr-defined]
            return None
        flag = status.BatteryFlag & 0xFF
        percent = status.BatteryLifePercent & 0xFF
        # 128 = no battery, 255 = unknown state.
        if flag & 128 or flag == 255 or percent == 255:
            return None
        return Battery(percent=percent, plugged=(status.ACLineStatus & 0xFF) == 1)
    except Exception:  # pragma: no cover - depends on the hardware
        return None


def _linux_battery() -> Battery | None:  # pragma: no cover - doesn't run on the development PCs
    for supply in Path("/sys/class/power_supply").glob("BAT*"):
        try:
            percent = int((supply / "capacity").read_text().strip())
            status = (supply / "status").read_text().strip().lower()
        except (OSError, ValueError):
            continue
        return Battery(percent=percent, plugged=status in {"charging", "full", "not charging"})
    return None
