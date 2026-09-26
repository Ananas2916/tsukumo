#!/usr/bin/env python
"""Controlli per l'installer (scripts/build_installer.ps1).

    python package_audit.py notices <cartella app> <file di uscita>
    python package_audit.py avatars <cartella avatar> [--public]

``notices`` scrive THIRD-PARTY-NOTICES.txt: le licenze di ogni pacchetto
Python incluso (va eseguito col Python dell'installer, per vedere i suoi
pacchetti), dei pesi di Kokoro, dell'avatar e di Electron.

``avatars`` legge i metadati di licenza scritti dentro ogni ``.vrm``. Con
``--public`` fallisce se un avatar non si puo' ridistribuire: e' il controllo
che impedisce di pubblicare per sbaglio un modello con una licenza sua.
"""

from __future__ import annotations

import json
import struct
import sys
from importlib import metadata
from pathlib import Path

#: Licenze VRM 0.x che permettono di ridistribuire il modello.
REDISTRIBUTABLE = {"CC0", "CC_BY", "CC_BY_SA"}

OTHER_NOTICES = """\
Pesi del modello vocale Kokoro-82M (hexgrad) - Apache License 2.0
  https://huggingface.co/hexgrad/Kokoro-82M
  Convertiti in ONNX da kokoro-onnx (thewh1teagle), MIT
  https://github.com/thewh1teagle/kokoro-onnx

Python {python} (Python Software Foundation License)
  https://docs.python.org/3/license.html

Electron e Chromium: vedi LICENSE.electron.txt e LICENSES.chromium.html
nella cartella di installazione.

Codice di Tsukumo: GNU Affero General Public License 3.0 (LICENSE).
Sorgenti: https://github.com/Ananas2916/tsukumo
"""


def vrm_license(path: Path) -> dict[str, object]:
    """Versione e licenza dichiarate nei metadati del file VRM."""
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError(f"{path.name}: non e' un file glTF binario")
    length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20 : 20 + length])
    extensions = document.get("extensions") or {}
    if "VRMC_vrm" in extensions:
        meta = extensions["VRMC_vrm"].get("meta") or {}
        return {
            "version": "1.0",
            "title": meta.get("name", path.stem),
            "authors": ", ".join(meta.get("authors") or []),
            "license": meta.get("licenseUrl", ""),
            "redistributable": bool(meta.get("allowRedistribution")),
        }
    meta = (extensions.get("VRM") or {}).get("meta") or {}
    name = meta.get("licenseName", "")
    return {
        "version": "0.x",
        "title": meta.get("title") or path.stem,
        "authors": meta.get("author", ""),
        "license": name,
        "redistributable": name in REDISTRIBUTABLE,
    }


def avatars(folder: Path, public: bool) -> int:
    found = sorted(folder.glob("*.vrm"))
    if not found:
        print("Nessun avatar incluso.")
        return 0
    problems = 0
    for path in found:
        info = vrm_license(path)
        ok = info["redistributable"]
        print(f"{'OK ' if ok else 'NO '} {path.name}: {info['title']} - licenza {info['license'] or '?'} (VRM {info['version']})")
        if public and not ok:
            problems += 1
    if problems:
        print(f"\n{problems} avatar non ridistribuibili: un installer pubblico non puo' contenerli.")
        return 1
    return 0


def notices(app: Path, target: Path) -> int:
    lines = ["Tsukumo - componenti di terze parti inclusi in questo installer", "=" * 64, ""]
    lines.append("Pacchetti Python")
    lines.append("-" * 16)
    for dist in sorted(metadata.distributions(), key=lambda d: (d.metadata["Name"] or "").lower()):
        name = dist.metadata["Name"] or "?"
        license_text = dist.metadata.get("License-Expression") or dist.metadata.get("License") or ""
        if not license_text or len(license_text) > 80:
            classifiers = [c.split("::")[-1].strip() for c in dist.metadata.get_all("Classifier") or [] if c.startswith("License ::")]
            license_text = ", ".join(classifiers) or (license_text.splitlines()[0][:80] if license_text else "vedi il pacchetto")
        home = dist.metadata.get("Home-page") or next(
            (url.split(",", 1)[-1].strip() for url in dist.metadata.get_all("Project-URL") or []), ""
        )
        lines.append(f"{name} {dist.version} - {license_text}" + (f"\n  {home}" if home else ""))
    lines.append("")
    lines.append("I testi delle licenze sono nelle cartelle *.dist-info del Python incluso")
    lines.append("(resources\\python\\Lib\\site-packages). espeak-ng (via espeakng-loader) e")
    lines.append("phonemizer sono GPL 3.0: i loro sorgenti sono ai link indicati sopra.")
    lines.append("")
    lines.append("Avatar")
    lines.append("-" * 6)
    for path in sorted((app / "frontend" / "public" / "models").glob("*.vrm")):
        info = vrm_license(path)
        lines.append(f"{path.name}: {info['title']} - licenza {info['license']}" + (f" - {info['authors']}" if info["authors"] else ""))
    lines.append("")
    lines.append(OTHER_NOTICES.format(python=sys.version.split()[0]))
    target.write_text("\n".join(lines), encoding="utf-8")
    print(f"Scritto {target}")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[0] == "notices":
        return notices(Path(argv[1]), Path(argv[2]))
    if len(argv) >= 2 and argv[0] == "avatars":
        return avatars(Path(argv[1]), "--public" in argv)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
