#!/usr/bin/env python
"""Downloads the Kokoro TTS weights into the ``models/`` folder.

Typical use::

    python scripts/download_models.py               # full variant (fp32)
    python scripts/download_models.py --variant int8 # ~90 MB, faster on CPU
    python scripts/download_models.py --force        # download again from scratch

The download resumes (HTTP Range) if the connection drops halfway.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

#: The model's three variants. The voices file is the same for all of them.
MODEL_VARIANTS: dict[str, tuple[str, int]] = {
    # variant name -> (remote file, approximate size in MB)
    "full": ("kokoro-v1.0.onnx", 326),
    "fp16": ("kokoro-v1.0.fp16.onnx", 169),
    "int8": ("kokoro-v1.0.int8.onnx", 92),
}
VOICES_FILE = ("voices-v1.0.bin", 27)

USER_AGENT = "desk-companion/1.0 (+https://github.com/)"


@dataclass
class Download:
    url: str
    destination: Path
    approx_mb: int


def human(size: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def fetch(item: Download, force: bool = False) -> bool:
    """Downloads a file with a progress bar and resume. True if ok."""
    destination = item.destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")

    if destination.is_file() and not force:
        print(f"  [ok]  {destination.name} already there ({human(destination.stat().st_size)})")
        return True

    if force and partial.exists():
        partial.unlink()

    resume_from = partial.stat().st_size if partial.exists() else 0
    request = urllib.request.Request(item.url, headers={"User-Agent": USER_AGENT})
    if resume_from:
        request.add_header("Range", f"bytes={resume_from}-")
        print(f"  [..]  Riprendo {destination.name} da {human(resume_from)}")
    else:
        print(f"  [..]  Scarico {destination.name} (~{item.approx_mb} MB)")

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            # 206 = the server accepted the resume, 200 = it starts again from zero.
            mode = "ab" if response.status == 206 and resume_from else "wb"
            if mode == "wb":
                resume_from = 0
            declared = response.headers.get("Content-Length")
            total = (int(declared) + resume_from) if declared else 0

            downloaded = resume_from
            with open(partial, mode) as handle:
                while True:
                    block = response.read(262_144)
                    if not block:
                        break
                    handle.write(block)
                    downloaded += len(block)
                    _progress(downloaded, total)
        print()
    except urllib.error.HTTPError as exc:
        print(f"\n  [!!]  HTTP {exc.code} su {item.url}", file=sys.stderr)
        return False
    except urllib.error.URLError as exc:
        print(f"\n  [!!]  Network unreachable: {exc.reason}", file=sys.stderr)
        return False
    except KeyboardInterrupt:
        print("\n  [--]  Interrupted: the .part file is kept for resuming.")
        raise

    shutil.move(str(partial), str(destination))
    print(f"  [ok]  {destination.name} -> {human(destination.stat().st_size)}")
    return True


def _progress(done: int, total: int) -> None:
    if total <= 0:
        sys.stdout.write(f"\r        {human(done)}")
    else:
        ratio = done / total
        filled = int(ratio * 30)
        bar = "#" * filled + "." * (30 - filled)
        sys.stdout.write(f"\r        [{bar}] {ratio * 100:5.1f}%  {human(done)}")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--variant",
        choices=sorted(MODEL_VARIANTS),
        default="full",
        help="Precision of the ONNX model (default: full)",
    )
    parser.add_argument("--dest", type=Path, default=MODELS_DIR, help="Destination folder")
    parser.add_argument("--force", action="store_true", help="Download again even if present")
    args = parser.parse_args()

    model_file, model_mb = MODEL_VARIANTS[args.variant]
    voices_file, voices_mb = VOICES_FILE

    print(f"Desk Companion - download pesi Kokoro ({args.variant})")
    print(f"Destinazione: {args.dest}")

    items = [
        # The model is always saved as kokoro-v1.0.onnx: the backend
        # looks for that name (overridable with DC_KOKORO_MODEL).
        Download(f"{RELEASE}/{model_file}", args.dest / "kokoro-v1.0.onnx", model_mb),
        Download(f"{RELEASE}/{voices_file}", args.dest / voices_file, voices_mb),
    ]

    ok = True
    for item in items:
        ok = fetch(item, force=args.force) and ok

    if ok:
        print("\nDone. Start the backend with:  python -m backend")
        return 0

    print("\nDownload incomplete. Try again, or download it by hand from:", file=sys.stderr)
    print(f"  {RELEASE}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
