#!/usr/bin/env python
"""Checks for the installer (scripts/build_installer.ps1).

    python package_audit.py notices <app folder> <output file>
    python package_audit.py contents <app folder>

``notices`` writes THIRD-PARTY-NOTICES.txt: the licences of every bundled
Python package (it must run with the installer's Python, to see its
packages), of the Kokoro weights and of Electron.

``contents`` fails if the app folder holds anything but what the installer
is made of: backend, built pages, the hook scripts, the voice weights and the
licences. An old checkout may keep personal files around (settings, state,
models or clips with their own licences): none of them can slip into a
public installer.
"""

from __future__ import annotations

import sys
from importlib import metadata
from pathlib import Path

OTHER_NOTICES = """\
Weights of the Kokoro-82M voice model (hexgrad) - Apache License 2.0
  https://huggingface.co/hexgrad/Kokoro-82M
  Converted to ONNX by kokoro-onnx (thewh1teagle), MIT
  https://github.com/thewh1teagle/kokoro-onnx

Python {python} (Python Software Foundation License)
  https://docs.python.org/3/license.html

Electron and Chromium: see LICENSE.electron.txt and LICENSES.chromium.html
in the installation folder.

Tsukumo's code: GNU Affero General Public License 3.0 (LICENSE).
Source: https://github.com/Ananas2916/tsukumo
"""

#: What the app folder may hold at its top level.
TOP_LEVEL = {"backend", "frontend", "scripts", "models", "LICENSE", ".env.example", "THIRD-PARTY-NOTICES.txt"}
#: Inside frontend/ only the built pages; inside models/ only the voice.
ONLY = {
    "frontend": {"dist"},
    "models": {"kokoro-v1.0.onnx", "voices-v1.0.bin"},
    "scripts": {"tsukumo_notify.py", "tsukumo_statusline.py"},
}
#: Never, anywhere: settings with keys, the user's state.
FORBIDDEN_NAMES = {".env", "running.json", "spotify.json", "memory.json", "reminders.json"}


def contents(app: Path) -> int:
    problems: list[str] = []
    for entry in app.iterdir():
        if entry.name not in TOP_LEVEL:
            problems.append(entry.name)
    for folder, allowed in ONLY.items():
        base = app / folder
        if base.is_dir():
            problems += [f"{folder}/{entry.name}" for entry in base.iterdir() if entry.name not in allowed]
    for path in app.rglob("*"):
        if path.name in FORBIDDEN_NAMES or path.parts[-2:-1] == ("state",):
            problems.append(str(path.relative_to(app)).replace("\\", "/"))
    if problems:
        print("Not part of the installer:")
        for item in sorted(set(problems)):
            print(f"  {item}")
        return 1
    print("Contents OK.")
    return 0


def notices(app: Path, target: Path) -> int:
    lines = ["Tsukumo - third-party components included in this installer", "=" * 64, ""]
    lines.append("Python packages")
    lines.append("-" * 15)
    for dist in sorted(metadata.distributions(), key=lambda d: (d.metadata["Name"] or "").lower()):
        name = dist.metadata["Name"] or "?"
        license_text = dist.metadata.get("License-Expression") or dist.metadata.get("License") or ""
        if not license_text or len(license_text) > 80:
            classifiers = [c.split("::")[-1].strip() for c in dist.metadata.get_all("Classifier") or [] if c.startswith("License ::")]
            license_text = ", ".join(classifiers) or (license_text.splitlines()[0][:80] if license_text else "see the package")
        home = dist.metadata.get("Home-page") or next(
            (url.split(",", 1)[-1].strip() for url in dist.metadata.get_all("Project-URL") or []), ""
        )
        lines.append(f"{name} {dist.version} - {license_text}" + (f"\n  {home}" if home else ""))
    lines.append("")
    lines.append("The licence texts are in the *.dist-info folders of the bundled Python")
    lines.append("(resources\\python\\Lib\\site-packages). espeak-ng (via espeakng-loader) and")
    lines.append("phonemizer are GPL 3.0: their sources are at the links above.")
    lines.append("")
    lines.append(OTHER_NOTICES.format(python=sys.version.split()[0]))
    target.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {target}")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[0] == "notices":
        return notices(Path(argv[1]), Path(argv[2]))
    if len(argv) >= 2 and argv[0] == "contents":
        return contents(Path(argv[1]))
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
