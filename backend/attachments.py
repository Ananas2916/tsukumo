"""Files passed to the companion: dropped on her, attached in chat, screenshots.

An agent (Claude Code, Codex, OpenClaw...) works on your PC: the file's path
is enough, plus the permission to read it (``--add-dir`` for Claude Code,
``-i`` for Codex's images). A model instead doesn't see the disk: it's sent
the files' text and the images inside the message (see ``openai_content``,
``anthropic_content``, ``gemini_parts``, ``ollama_images``).
"""

from __future__ import annotations

import base64
import mimetypes
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: How many files per message, and how much text of each ends up in a model's prompt.
MAX_FILES = 6
MAX_TEXT_CHARS = 30_000
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}
TEXT_SUFFIXES = {
    ".txt", ".md", ".markdown", ".rst", ".log", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini",
    ".cfg", ".conf", ".env", ".xml", ".html", ".htm", ".css", ".scss", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".vue", ".svelte", ".py", ".pyi", ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs",
    ".go", ".rs", ".rb", ".php", ".pl", ".lua", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".sql", ".r", ".dart",
    ".scala", ".gradle", ".dockerfile", ".gitignore", ".srt", ".vtt",
}


@dataclass(frozen=True)
class Attachment:
    path: Path
    #: image, text, pdf, other
    kind: str
    mime: str
    size: int

    @property
    def name(self) -> str:
        return self.path.name


def classify(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_TYPES:
        return "image"
    if suffix == ".pdf":
        return "pdf"
    if suffix in TEXT_SUFFIXES or path.name.lower() in ("dockerfile", "makefile", "readme", "license"):
        return "text"
    return "other"


def prepare(paths: list[str] | None) -> list[Attachment]:
    """Only real, readable files, at most ``MAX_FILES``."""
    found: list[Attachment] = []
    for raw in paths or []:
        if not isinstance(raw, str) or not raw.strip():
            continue
        path = Path(raw.strip()).expanduser()
        try:
            if not path.is_file():
                continue
            size = path.stat().st_size
        except OSError:
            continue
        kind = classify(path)
        mime = IMAGE_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        found.append(Attachment(path=path.resolve(), kind=kind, mime=mime, size=size))
        if len(found) >= MAX_FILES:
            break
    return found


def default_prompt(files: list[Attachment], language: str, screen: bool = False) -> str:
    """What to ask if you passed a file without writing anything."""
    if screen:
        return "Guarda il mio schermo: cosa vedi? Dimmelo in breve." if language == "it" else "Look at my screen: what do you see? Keep it short."
    if language == "it":
        return "Dai un'occhiata a questo file e dimmi in breve cosa contiene." if len(files) == 1 else "Dai un'occhiata a questi file e dimmi in breve cosa contengono."
    return "Take a look at this file and briefly tell me what's in it." if len(files) == 1 else "Take a look at these files and briefly tell me what's in them."


def with_paths(text: str, files: list[Attachment]) -> str:
    """For an agent: the message plus the list of paths (it opens them itself)."""
    if not files:
        return text
    lines = "\n".join(f"- {item.path}" for item in files)
    return f"{text}\n\n(Files on the user's PC, open them to answer:\n{lines})"


def read_text(item: Attachment, limit: int = MAX_TEXT_CHARS) -> str | None:
    """The text of a file (or of a PDF, if pypdf is there), cut at ``limit`` characters."""
    try:
        if item.kind == "pdf":
            try:
                from pypdf import PdfReader  # type: ignore[import-not-found]
            except ImportError:
                return None
            reader = PdfReader(str(item.path))
            text = "\n".join((page.extract_text() or "") for page in reader.pages[:40])
        elif item.kind == "text":
            raw = item.path.read_bytes()[: limit * 4]
            text = raw.decode("utf-8", errors="replace")
        else:
            return None
    except Exception:
        return None
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + "\n[...]"


def with_contents(text: str, files: list[Attachment]) -> str:
    """For a model: the message plus the files' text (the images go separately)."""
    if not files:
        return text
    blocks = [text]
    for item in files:
        if item.kind == "image":
            continue
        content = read_text(item)
        if content is None:
            blocks.append(f"(The user attached {item.name}, but its content can't be read here.)")
        else:
            blocks.append(f"--- {item.name} ---\n{content}")
    return "\n\n".join(blocks)


def image_data(path: str | Path) -> tuple[str, str] | None:
    """``(mime, base64)`` of an image, or ``None`` if it's too big or unreadable."""
    path = Path(path)
    try:
        if path.stat().st_size > MAX_IMAGE_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    mime = IMAGE_TYPES.get(path.suffix.lower(), "image/png")
    return mime, base64.b64encode(data).decode("ascii")


# ---------------------------------------------------------------------------
# The services' formats
# ---------------------------------------------------------------------------
def openai_content(text: str, images: tuple[str, ...]) -> str | list[dict[str, Any]]:
    """Chat Completions (LM Studio, OpenRouter, Groq...): text, or text+image parts."""
    if not images:
        return text
    parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
    for path in images:
        data = image_data(path)
        if data:
            parts.append({"type": "image_url", "image_url": {"url": f"data:{data[0]};base64,{data[1]}"}})
    return parts


def anthropic_content(text: str, images: tuple[str, ...]) -> str | list[dict[str, Any]]:
    if not images:
        return text
    parts: list[dict[str, Any]] = []
    for path in images:
        data = image_data(path)
        if data:
            parts.append({"type": "image", "source": {"type": "base64", "media_type": data[0], "data": data[1]}})
    parts.append({"type": "text", "text": text})
    return parts


def gemini_parts(text: str, images: tuple[str, ...]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    for path in images:
        data = image_data(path)
        if data:
            parts.append({"inline_data": {"mime_type": data[0], "data": data[1]}})
    parts.append({"text": text})
    return parts


def ollama_images(images: tuple[str, ...]) -> list[str]:
    return [data[1] for data in (image_data(path) for path in images) if data]


# ---------------------------------------------------------------------------
# Files uploaded from the browser (no real path)
# ---------------------------------------------------------------------------
_SAFE_NAME = re.compile(r"[^\w.\- ()]+", re.UNICODE)


def store_upload(folder: Path, name: str, data: bytes) -> Path:
    """Saves an uploaded file in ``state/uploads/<id>/<name>`` and returns its path."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError(f"File troppo grande (massimo {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
    clean = _SAFE_NAME.sub("_", Path(name or "file").name).strip(" .") or "file"
    target = folder / uuid.uuid4().hex[:12] / clean[:120]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return target
