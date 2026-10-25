"""The eye: finds a described thing on a screenshot, in pixels.

The brain says *what* to show ("the AND gate icon in the second toolbar");
the eye says *where*. Any model that sees can be the eye (Gemini, Claude,
GPT, Qwen-VL in LM Studio or Ollama...), chosen in Character -> Show me
where. Each family was trained on its own way of writing coordinates, so
each is asked in its own (``style_for``) and every answer is read
(``parse_box``).

Small icons are the hard part: a whole 2560x1440 screen shrunk to fit a
model leaves a 16 px toolbar button at 9 px. So a first look finds the area
and, when the hit is small, a second look at a full-resolution crop places
it exactly (``Eye.find``).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import re
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .llm import LLMClient, create_llm_client, describe_error
from .llm.base import Message
from .providers import LLM_REGISTRY

logger = logging.getLogger(__name__)

#: The models' own resizing: Claude keeps up to ~1.15 megapixels and 1568 px
#: on the long side, Qwen-VL works in 28 px patches. An image already within
#: both is seen as it is, so the coordinates come back in its own pixels.
MAX_SIDE = 1456
MAX_PIXELS = 1_150_000
PATCH = 28
#: A hit smaller than this (screen pixels) is looked at again on a crop.
SMALL = 72
#: The crop for the second look: this many times the first box, at least MIN_CROP.
ZOOM = 5.0
MIN_CROP = (480, 320)
#: The crop is enlarged up to this much: a 16 px icon becomes something to see.
ZOOM_UPSCALE = 2.0
#: A "box" over most of the image isn't an answer.
MAX_AREA = 0.6
#: A local model on a small GPU is slow, but not this slow.
LOOK_TIMEOUT = 60.0
#: Engines that can be the eye: the models, not the agents (they don't answer in JSON).
EYE_CATEGORIES = ("cloud", "local")


@dataclass(frozen=True)
class Box:
    left: float
    top: float
    right: float
    bottom: float

    @property
    def width(self) -> float:
        return self.right - self.left

    @property
    def height(self) -> float:
        return self.bottom - self.top

    @property
    def center(self) -> tuple[float, float]:
        return (self.left + self.right) / 2, (self.top + self.bottom) / 2

    def clipped(self, width: float, height: float) -> Box:
        return Box(max(0.0, self.left), max(0.0, self.top), min(width, self.right), min(height, self.bottom))

    def mapped(self, sx: float, sy: float, dx: float = 0.0, dy: float = 0.0) -> Box:
        """From a scaled/cropped image back to the original: ``x * sx + dx``."""
        return Box(self.left * sx + dx, self.top * sy + dy, self.right * sx + dx, self.bottom * sy + dy)


# ---------------------------------------------------------------------------
# How each family writes coordinates
# ---------------------------------------------------------------------------
#: Thousandths, x first: Qwen3-VL, GLM-4.xV, Kimi-VL, MiMo-VL, InternVL3.
_THOUSANDTHS = re.compile(r"qwen3[-_.]?(?:vl|omni)|glm-?4(?:\.\d)?v|kimi-vl|mimo-vl|internvl3", re.IGNORECASE)


def style_for(model: str) -> str:
    """``gemini``: [ymin, xmin, ymax, xmax] in thousandths, as Gemini was trained;
    ``thousandths``: [x1, y1, x2, y2] in thousandths; ``pixels`` for everyone
    else (Claude, GPT, Qwen2.5-VL, UI-TARS, Llama...)."""
    name = (model or "").lower()
    if "gemini" in name:
        return "gemini"
    if _THOUSANDTHS.search(name):
        return "thousandths"
    return "pixels"


def instructions(style: str, width: int, height: int) -> str:
    base = (
        "You locate things on a screenshot of a computer screen. Find the one element described below "
        "and answer with JSON only, no other text: "
    )
    if style == "gemini":
        shape = '{"box_2d": [ymin, xmin, ymax, xmax]} normalized to 0-1000'
    elif style == "thousandths":
        shape = '{"bbox_2d": [x1, y1, x2, y2]} normalized to 0-1000 (x from the left, y from the top)'
    else:
        shape = f'{{"bbox_2d": [x1, y1, x2, y2]}} in pixels of this {width}x{height} image (x from the left, y from the top)'
    return base + shape + ', tight around the element; {"found": false} if it is not visible.'


# ---------------------------------------------------------------------------
# Reading the answer
# ---------------------------------------------------------------------------
_NOT_FOUND = re.compile(r'"found"\s*:\s*false|\bnot (?:found|visible)\b', re.IGNORECASE)
_OBJECT = re.compile(r"\{[^{}]*\}")
_KEYS = ("box_2d", "bbox_2d", "bbox", "box", "point_2d", "point", "coordinates", "coords", "position")
# Molmo: <point x="12.5" y="40.1"> in percent.
_MOLMO = re.compile(r'<point[^>]*?\bx\d*\s*=\s*"([\d.]+)"[^>]*?\by\d*\s*=\s*"([\d.]+)"', re.IGNORECASE)
_NUM = r"\s*(-?\d+(?:\.\d+)?)\s*"
# UI-TARS and Qwen's tokens: (x1,y1),(x2,y2) or a single (x,y).
_PAIRS = re.compile(rf"\({_NUM},{_NUM}\)\s*,?\s*(?:<\|box_end\|>\s*,?\s*<\|box_start\|>\s*)?\({_NUM},{_NUM}\)")
_LIST4 = re.compile(rf"[\[(]{_NUM},{_NUM},{_NUM},{_NUM}[\])]")
_LIST2 = re.compile(rf"[\[(]{_NUM},{_NUM}[\])]")


def _numbers(value: Any) -> list[float] | None:
    if isinstance(value, dict):
        # {"x": .., "y": .., "width": .., "height": ..} or {"x1": ..}
        if all(key in value for key in ("x1", "y1", "x2", "y2")):
            value = [value["x1"], value["y1"], value["x2"], value["y2"]]
        elif all(key in value for key in ("x", "y")):
            if "width" in value and "height" in value:
                value = [value["x"], value["y"], value["x"] + value["width"], value["y"] + value["height"]]
            else:
                value = [value["x"], value["y"]]
        else:
            return None
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], list):
        value = value[0]
    if not isinstance(value, list) or len(value) not in (2, 4):
        return None
    try:
        numbers = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    return numbers if all(math.isfinite(item) for item in numbers) else None


def _coordinates(text: str) -> tuple[list[float] | None, str, bool]:
    """(numbers, the JSON key they came under, whether they're percent). Thinking models
    reason first: the answer is the last thing they write, so it's searched from the end."""
    found = list(_MOLMO.finditer(text))
    if found:
        x, y = found[-1].groups()
        return [float(x), float(y)], "point", True
    for match in reversed(list(_OBJECT.finditer(text))):
        try:
            data = json.loads(match.group())
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        if data.get("found") is False:
            return None, "", False
        for key in _KEYS:
            if key in data:
                numbers = _numbers(data[key])
                if numbers is not None:
                    return numbers, key, False
        numbers = _numbers(data)
        if numbers is not None:
            return numbers, "", False
    if _NOT_FOUND.search(text):
        return None, "", False
    for pattern in (_PAIRS, _LIST4, _LIST2):
        found = list(pattern.finditer(text))
        if found:
            return [float(item) for item in found[-1].groups()], "", False
    return None, "", False


def parse_box(text: str, style: str, width: int, height: int) -> Box | None:
    """The model's answer -> a box in the image's pixels, or None."""
    numbers, key, percent = _coordinates(text or "")
    if not numbers:
        return None
    if percent:
        xs, ys = width / 100, height / 100
    elif style in ("gemini", "thousandths"):
        xs, ys = width / 1000, height / 1000
    else:
        xs = ys = 1.0
        if max(numbers) <= 1.0:
            # Fractions of the image.
            xs, ys = width, height
        elif max(numbers) <= 1000 and any(n > limit * 1.05 for n, limit in zip(numbers, (width, height) * 2)):
            # Beyond the image's edges but within 1000: thousandths after all.
            xs, ys = width / 1000, height / 1000
    # Gemini writes y first, in its boxes and in its points.
    yx = style == "gemini" and key in ("box_2d", "point_2d", "point", "")
    if len(numbers) == 4:
        a, b, c, d = numbers
        x1, y1, x2, y2 = (b, a, d, c) if yx else (a, b, c, d)
        box = Box(min(x1, x2) * xs, min(y1, y2) * ys, max(x1, x2) * xs, max(y1, y2) * ys)
    else:
        a, b = numbers
        x, y = ((b, a) if yx else (a, b))
        x, y = x * xs, y * ys
        reach = max(8.0, width * 0.008)
        box = Box(x - reach, y - reach, x + reach, y + reach)
    box = box.clipped(width, height)
    if box.width < 1 or box.height < 1 or box.width * box.height > MAX_AREA * width * height:
        return None
    return box


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------
def fit(width: float, height: float, upscale: float = 1.0) -> tuple[int, int]:
    """The size to send: within the models' limits, multiple of the patch."""
    scale = min(upscale, MAX_SIDE / max(width, height), math.sqrt(MAX_PIXELS / max(1.0, width * height)))
    return max(PATCH, int(width * scale) // PATCH * PATCH), max(PATCH, int(height * scale) // PATCH * PATCH)


def _open(path: Path) -> Any:
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - Pillow is in requirements.txt
        logger.warning("Pillow is missing: the eye can't read the screenshot")
        return None
    try:
        with Image.open(path) as image:
            return image.convert("RGB")
    except OSError as exc:
        logger.warning("Screenshot unreadable (%s): %s", path.name, exc)
        return None


def _crop_to_file(picture: Any, region: Box, upscale: float) -> tuple[Path, int, int]:
    from PIL import Image

    width, height = fit(region.width, region.height, upscale)
    area = (round(region.left), round(region.top), round(region.right), round(region.bottom))
    image = picture.crop(area).resize((width, height), Image.Resampling.LANCZOS)
    folder = Path(tempfile.gettempdir()) / "tsukumo"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"eye-{uuid.uuid4().hex[:12]}.png"
    image.save(path, "PNG")
    return path, width, height


async def _collect(client: LLMClient, messages: list[Message]) -> str:
    parts = [piece async for piece in client.stream(messages)]
    return "".join(parts)


# ---------------------------------------------------------------------------
# The eye
# ---------------------------------------------------------------------------
class Eye:
    """The model chosen as the eye, rebuilt when the choice (or its key) changes."""

    def __init__(self, settings: Any, preferences: Any) -> None:
        self.settings = settings
        self.preferences = preferences
        self._client: LLMClient | None = None
        self._key: tuple | None = None
        #: Why the eye doesn't work (missing key, engine that doesn't answer), for the panel.
        self.error: str | None = None
        self._closing: set[asyncio.Task] = set()

    def engine(self) -> str:
        """The chosen engine; none chosen = the main brain, if it's a model (it may see)."""
        chosen = self.preferences.eye
        if chosen:
            return chosen
        spec = LLM_REGISTRY.get(self.settings.selected("llm"))
        return spec.id if spec is not None and spec.category in EYE_CATEGORIES else ""

    def client(self) -> LLMClient | None:
        engine = self.engine()
        if not engine:
            self.error = None
            return None
        options = self.settings.provider_config("llm", engine)
        key = (engine, self.preferences.eye_model, tuple(sorted((k, str(v)) for k, v in options.items())))
        if key == self._key:
            return self._client
        if self._client is not None:
            # Outside a running loop (tests) the old client is simply dropped.
            with contextlib.suppress(RuntimeError):
                task = asyncio.get_running_loop().create_task(self._client.close())
                self._closing.add(task)
                task.add_done_callback(self._closing.discard)
        self._key = key
        self._client = None
        spec = LLM_REGISTRY.get(engine)
        if spec is None or spec.category not in EYE_CATEGORIES:
            self.error = f"{engine} can't be the eye: it needs a cloud or local model that sees."
            return None
        overrides: dict[str, object] = {"TEMPERATURE": 0.0}
        model_env = next((field.env for field in spec.fields if field.env.endswith("_MODEL")), None)
        if model_env and self.preferences.eye_model:
            overrides[model_env] = self.preferences.eye_model
        try:
            self._client = create_llm_client(self.settings, spec.id, overrides=overrides)
            self.error = None
            logger.info("The eye is %s (%s)", spec.id, self.preferences.eye_model or "saved model")
        except Exception as exc:
            self.error = describe_error(exc)
            logger.warning("The eye (%s) doesn't start: %s", spec.id, self.error)
        return self._client

    async def find(self, image: Path, description: str) -> Box | None:
        """Where ``description`` is on ``image``, in its pixels; None if it isn't there.

        On failure (key, network, model without sight) ``error`` says why.
        """
        client = self.client()
        if client is None:
            return None
        picture = await asyncio.to_thread(_open, image)
        if picture is None:
            return None
        try:
            resolve = getattr(client, "_resolve_model", None)
            model = await resolve() if resolve is not None else getattr(client, "model", "")
            style = style_for(str(model))
            whole = Box(0, 0, picture.width, picture.height)
            first = await self._look(client, style, picture, whole, description, 1.0)
            if first is None or max(first.width, first.height) >= SMALL:
                return first
            # A small hit on a shrunken screen: look again closer, at full resolution.
            cx, cy = first.center
            half_w = max(MIN_CROP[0], first.width * ZOOM) / 2
            half_h = max(MIN_CROP[1], first.height * ZOOM) / 2
            crop = Box(cx - half_w, cy - half_h, cx + half_w, cy + half_h).clipped(picture.width, picture.height)
            second = await self._look(client, style, picture, crop, description, ZOOM_UPSCALE)
            return second or first
        except Exception as exc:
            self.error = describe_error(exc)
            logger.warning("The eye didn't answer: %s", self.error)
            return None
        finally:
            picture.close()

    async def _look(self, client: LLMClient, style: str, picture: Any, region: Box, description: str, upscale: float) -> Box | None:
        path, width, height = await asyncio.to_thread(_crop_to_file, picture, region, upscale)
        try:
            # Everything in the user's message: some local models ignore the system one when there's an image.
            prompt = f"{instructions(style, width, height)}\n\nFind: {description}"
            text = await asyncio.wait_for(_collect(client, [Message("user", prompt, images=(str(path),))]), LOOK_TIMEOUT)
        finally:
            path.unlink(missing_ok=True)
        self.error = None
        box = parse_box(text, style, width, height)
        if box is None:
            logger.info("The eye didn't find %r (%s)", description[:80], text.strip()[:160])
            return None
        return box.mapped(region.width / width, region.height / height, region.left, region.top)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
        self._client = None
        self._key = None

