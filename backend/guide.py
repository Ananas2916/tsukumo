"""Showing where on the screen: the "umbilical cord".

"Where's the 2-input AND?", "where do I connect this wire?", "how do I
change the password?": the brain sees the screen and answers with one
``[[point: ...]]`` (or ``[[wire: from -> to]]``) per step. Tsukumo finds each
spot, from the accessibility tree when the program describes itself
(``uia.py``) or with the eye (``eye.py``), and the shell draws a
block-diagram arrow from her to it. A click on the spot, or "done", moves
on to the next step.

She only points: she never clicks or types for the user. The screen is
looked at only for questions like these (or when the brain asks with
``[[look]]``), never by itself, and the steps' rectangles go to this PC's
windows only.
"""

from __future__ import annotations

import asyncio
import logging
import re
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import uia
from .security import within

logger = logging.getLogger(__name__)

#: More steps than this is a tutorial, not a hand to hold.
MAX_STEPS = 8
#: How long after a guide a short follow-up ("and now?") still means the screen.
FOLLOW_UP_S = 180.0
#: A screenshot older than this is taken again before looking for a step.
FRESH_S = 45.0
#: After a click the program needs a moment (a menu opening, a gate placed).
SETTLE_S = 0.7
#: A guide nobody follows goes away by itself.
IDLE_S = 600.0
#: The shell keeps its screenshots here (Electron's temp folder, the same as Python's).
GLANCE_FOLDER = Path(tempfile.gettempdir()) / "tsukumo"

# ---------------------------------------------------------------------------
# When she looks
# ---------------------------------------------------------------------------
_WHERE = re.compile(
    r"\bdov'?\s?(?:è|e'|sta|stanno|si trova|si trovano)\b"
    r"|\bdove\s+(?:(?:lo|la|li|le|si|ci|ne|io)\s+)?(?:è|sono|sta|stanno|posso|devo|dovrei|bisogna|va|vanno|vado|trova|trovano|trovo|clicco|premo|"
    r"schiaccio|tocco|metto|piazzo|collego|attacco|scrivo|inserisco|digito|seleziono|apro|cerco|prendo|sposto|"
    r"trascino|trovare|cliccare|premere|mettere|collegare|scrivere)\b"
    r"|\bcome\s+(?:faccio|si fa|posso|devo|si)\s+(?:a|ad|per)?\s*\w"
    r"|\b(?:mostrami|indicami|fammi vedere|segnami|evidenziami)\b"
    r"|\bwhere\s+(?:is|are|was|do|does|can|could|should|would|to|did)\b|\bwhere'?(?:s|re)\b"
    r"|\bhow\s+(?:do|can|could|should|would)\s+(?:i|we|you)\b|\bhow\s+to\b"
    r"|\bshow\s+me\b|\bpoint\s+(?:to|at|out)\b",
    re.IGNORECASE,
)
# Right after a guide, short questions about "this", "now", "here" are about the screen too.
_FOLLOW = re.compile(
    r"\b(?:adesso|ora|poi|dopo|qui|qua|questo|questa|quello|quella|lì|là|next|now|then|here|there|this|that)\b",
    re.IGNORECASE,
)
_DONE = re.compile(
    r"^\s*(?:ok(?:ay)?[,.!]?\s*)?(?:fatto|fatta|finito|avanti|prossimo|vai(?: avanti)?|continua|e poi|poi|"
    r"ce l'?ho fatta|done|next|go on|got it|ok(?:ay)?)\s*[.!]*\s*$",
    re.IGNORECASE,
)
_STOP = re.compile(
    r"^\s*(?:stop|basta|annulla|lascia (?:stare|perdere)|chiudi|togli(?:la|lo)?|nascondi(?:la|lo)?|"
    r"cancel|never ?mind|hide it|forget it)\b",
    re.IGNORECASE,
)
_BACK = re.compile(r"^\s*(?:indietro|torna indietro|passo prima|back|go back|previous)\s*[.!]*\s*$", re.IGNORECASE)
_AGAIN = re.compile(
    r"^\s*(?:non (?:lo|la) (?:vedo|trovo)|dov'?è\??|dove\??|di nuovo|rifallo|ripeti|again|"
    r"i can'?t (?:see|find) it|where\??)\s*[.!?]*\s*$",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# The brain's tags
# ---------------------------------------------------------------------------
_POINT = re.compile(r"^\[\[\s*point\s*:\s*(?P<body>.*?)\s*\]\]$", re.IGNORECASE | re.DOTALL)
_WIRE = re.compile(r"^\[\[\s*wire\s*:\s*(?P<body>.*?)\s*\]\]$", re.IGNORECASE | re.DOTALL)
_LOOK = re.compile(r"^\[\[\s*look\s*\]\]$", re.IGNORECASE)
_ARROW = re.compile(r"\s*(?:->|→|=>|➜)\s*")
_TYPE_LABEL = re.compile(r"^\s*(?:type|write|enter|scrivi|digita|inserisci)\b", re.IGNORECASE)

LOOK_RULE = (
    "If you need to see the user's screen to answer (they ask where something is, or say 'this' or 'here' about "
    "something on it), reply with only [[look]]: you get the same message again with a screenshot."
)


@dataclass(frozen=True)
class Step:
    #: ``point`` (a spot) or ``wire`` (from one spot to another).
    kind: str
    target: str
    to: str = ""
    label: str = ""
    #: ``click``, ``type`` (a field to write in) or ``drag``: how the shell notices it's done.
    action: str = "click"


def _split_label(body: str) -> tuple[str, str]:
    target, _, label = body.rpartition("|") if "|" in body else (body, "", "")
    return " ".join(target.split()), " ".join(label.split())


def parse_steps(tags: list[str]) -> tuple[list[Step], bool, list[str]]:
    """The tags -> (steps in order, whether the brain asked to look, the other tags)."""
    steps: list[Step] = []
    look = False
    rest: list[str] = []
    for tag in tags:
        stripped = tag.strip()
        if found := _POINT.match(stripped):
            target, label = _split_label(found.group("body"))
            if target:
                action = "type" if _TYPE_LABEL.match(label) else "click"
                steps.append(Step("point", target[:300], "", label[:80], action))
        elif found := _WIRE.match(stripped):
            body, label = _split_label(found.group("body"))
            ends = _ARROW.split(body, maxsplit=1)
            if len(ends) == 2 and ends[0] and ends[1]:
                steps.append(Step("wire", ends[0][:300], ends[1][:300], label[:80], "drag"))
        elif _LOOK.match(stripped):
            look = True
        else:
            rest.append(tag)
    return steps[:MAX_STEPS], look, rest


# ---------------------------------------------------------------------------
# A screenshot and where it sits
# ---------------------------------------------------------------------------
def _rect(data: Any) -> dict[str, int] | None:
    if not isinstance(data, dict):
        return None
    try:
        rect = {key: int(data[key]) for key in ("x", "y", "width", "height")}
    except (KeyError, TypeError, ValueError):
        return None
    if not (0 < rect["width"] <= 20000 and 0 < rect["height"] <= 20000 and abs(rect["x"]) <= 40000 and abs(rect["y"]) <= 40000):
        return None
    return rect


@dataclass(frozen=True)
class Glance:
    """A screenshot of one display, and where that display sits (physical pixels)."""

    file: Path
    display: dict[str, int]
    #: The screenshot's own size (it should be the display's, but who knows).
    image: dict[str, int]
    #: The window being worked in: ``hwnd`` plus its rectangle, title and program.
    window: dict[str, Any] | None
    taken: float

    @classmethod
    def from_message(cls, data: Any, now: float, folder: Path = GLANCE_FOLDER) -> Glance | None:
        """What the shell sent, checked: numbers where numbers go, the file in its folder."""
        if not isinstance(data, dict) or not isinstance(data.get("file"), str):
            return None
        path = Path(data["file"])
        if path.suffix.lower() != ".png" or not within(path, [folder]) or not path.is_file():
            return None
        display = _rect(data.get("display"))
        image = data.get("image")
        try:
            size = {"width": int(image["width"]), "height": int(image["height"])}
        except (KeyError, TypeError, ValueError):
            size = None
        if display is None or size is None or not (0 < size["width"] <= 20000 and 0 < size["height"] <= 20000):
            return None
        window = None
        raw = data.get("window")
        rect = _rect(raw)
        if rect is not None:
            try:
                hwnd = int(raw.get("hwnd") or 0)
            except (TypeError, ValueError):
                hwnd = 0
            window = {
                **rect,
                "hwnd": hwnd,
                "title": str(raw.get("title") or "")[:160],
                "exe": str(raw.get("exe") or "")[:80],
            }
        return cls(path.resolve(), display, size, window, now)

    def to_screen(self, left: float, top: float, right: float, bottom: float) -> dict[str, int]:
        """A box in the screenshot's pixels -> a rectangle in physical screen pixels."""
        sx = self.display["width"] / self.image["width"]
        sy = self.display["height"] / self.image["height"]
        x, y = self.display["x"] + left * sx, self.display["y"] + top * sy
        return {"x": round(x), "y": round(y), "width": max(1, round((right - left) * sx)), "height": max(1, round((bottom - top) * sy))}


# ---------------------------------------------------------------------------
# What she says
# ---------------------------------------------------------------------------
_LINES = {
    "no_eye": (
        "Per indicartelo mi serve un modello che vede: sceglilo in Personaggio, alla voce Indicare sullo schermo.",
        "To point at it I need a model that can see: pick one in Character, under Show me where.",
    ),
    "not_found": ("Non lo trovo sullo schermo: {label}.", "I can't find it on the screen: {label}."),
    "eye_error": ("Il mio occhio non risponde: {error}", "My eye isn't answering: {error}"),
    "blind": ("Non riesco a vedere lo schermo.", "I can't see the screen."),
    "next": ("Passo {step} di {total}.", "Step {step} of {total}."),
    "back": ("Torno al passo {step}.", "Back to step {step}."),
    "again": ("Lo cerco di nuovo.", "Looking for it again."),
    "finished": ("Ecco fatto.", "All done."),
    "stopped": ("Ok, tolgo la freccia.", "Okay, arrow gone."),
}


def line(key: str, lang: str, **values: Any) -> str:
    italian, english = _LINES[key]
    return (italian if lang == "it" else english).format(**values)


# ---------------------------------------------------------------------------
# The guide
# ---------------------------------------------------------------------------
class Guide:
    """The steps on screen and the one being shown.

    ``broadcast``: to this PC's windows only. ``glance``: asks the shell for a
    screenshot (None if nobody can take it). ``say``: a short line of hers.
    """

    def __init__(
        self,
        broadcast: Callable[[dict[str, Any]], Awaitable[None]],
        glance: Callable[[], Awaitable[Glance | None]],
        eye: Any,
        say: Callable[[str], Awaitable[None]],
        language: Callable[[], str] = lambda: "en",
        enabled: Callable[[], bool] = lambda: True,
        can_glance: Callable[[], bool] = lambda: True,
        elements: Callable[[int | None, dict[str, Any] | None], Awaitable[list[uia.Element]]] = uia.elements,
        clock: Callable[[], float] = time.time,
        settle: float = SETTLE_S,
        folder: Path = GLANCE_FOLDER,
    ) -> None:
        self.broadcast = broadcast
        self.glance = glance
        self.eye = eye
        self.say = say
        self.language = language
        self.enabled = enabled
        self.can_glance = can_glance
        self.elements = elements
        self.clock = clock
        self.settle = settle
        #: The only folder screenshots are accepted from (the shell's).
        self.folder = folder
        self.steps: list[Step] = []
        self.index = 0
        #: The last screenshot (the one the brain saw, then each step's).
        self.last: Glance | None = None
        self._tree: tuple[Path, asyncio.Task[list[uia.Element]]] | None = None
        self._task: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self.touched_at = 0.0
        self.ended_at = 0.0

    # ------------------------------------------------------------ state
    @property
    def active(self) -> bool:
        if self.steps and self.clock() - self.touched_at > IDLE_S:
            self.steps = []
            self.ended_at = self.touched_at
        return bool(self.steps)

    @property
    def available(self) -> bool:
        return self.enabled() and self.can_glance()

    def public(self) -> dict[str, Any]:
        if not self.active:
            return {"active": False}
        step = self.steps[self.index]
        return {"active": True, "step": self.index + 1, "total": len(self.steps), "label": step.label}

    def _lang(self) -> str:
        return "it" if self.language() == "it" else "en"

    # ------------------------------------------------------------ when to look
    def wants(self, text: str) -> bool:
        """Does this question need the screen? (where/how, or a follow-up right after a guide)."""
        if not self.available or not text or len(text) > 600:
            return False
        if self.active and (_DONE.match(text) or _STOP.match(text) or _BACK.match(text) or _AGAIN.match(text)):
            return False
        if _WHERE.search(text):
            return True
        recent = self.active or self.clock() - self.ended_at < FOLLOW_UP_S
        return recent and len(text) <= 160 and bool(_FOLLOW.search(text))

    def notes(self, seen: Glance | None) -> list[str]:
        """What the brain is told this turn: how to point, and what's on screen now."""
        if not self.available:
            return []
        parts = [LOOK_RULE]
        if seen is not None:
            parts.append(self.directive(seen))
        elif self.active:
            step = self.steps[self.index]
            parts.append(
                f"(On their screen Tsukumo is showing step {self.index + 1} of {len(self.steps)}: «{step.label or step.target}». "
                "New [[point]] or [[wire]] tags replace those steps.)"
            )
        return parts

    def directive(self, seen: Glance) -> str:
        window = seen.window or {}
        where = f" The window in front is «{window.get('title', '')}» ({window.get('exe', '')})." if window.get("title") else ""
        return (
            "The attached screenshot is the user's screen right now." + where + " Tsukumo can show them where things are "
            "with an arrow drawn from her to the spot. To show a place, append [[point: what it is and where | short label]]: "
            "describe it so it can be found on the screenshot (its visible text in double quotes, its icon or shape, its "
            "position, e.g. [[point: the AND gate icon, a D shape, in the second toolbar | AND]]). For several actions write "
            f"one tag per step, in order (at most {MAX_STEPS}): she shows them one at a time and moves on when they click there. "
            "To drag or wire from one spot to another: [[wire: from what -> to what | label]]. For a field to fill in, start "
            "the label with the verb: [[point: the \"Password\" field | type: the new password]]. If the thing isn't visible "
            "yet (a closed menu), point at what opens it first. In your spoken reply say what to do in one or two short "
            "sentences; don't spell out positions, the arrow shows them. You only show: never claim you clicked or typed."
        )

    # ------------------------------------------------------------ the brain's tags
    def seen(self, data: Any) -> Glance | None:
        """The screenshot that goes to the brain with the question: kept, and its window read meanwhile."""
        glance = Glance.from_message(data, self.clock(), self.folder)
        if glance is not None:
            self.last = glance
            self._read_tree(glance)
        return glance

    def run_tags(self, tags: list[str]) -> tuple[list[str], bool]:
        """Takes the [[point]], [[wire]] and [[look]] tags; returns the others and whether to look."""
        steps, look, rest = parse_steps(tags)
        if steps:
            self.start(steps)
        return rest, look

    def start(self, steps: list[Step]) -> None:
        self.steps = list(steps[:MAX_STEPS])
        self.index = 0
        self.touched_at = self.clock()
        self._show(reuse=True)

    # ------------------------------------------------------------ commands
    async def command(self, text: str) -> str | None:
        """"Done", "back", "stop", "I can't see it": answered without the brain, only while a guide is on."""
        if not self.active or not text:
            return None
        lang = self._lang()
        if _STOP.match(text):
            await self.stop()
            return line("stopped", lang)
        if _DONE.match(text):
            return self.next()
        if _BACK.match(text):
            if self.index > 0:
                self.index -= 1
            self.touched_at = self.clock()
            self._show(reuse=False)
            return line("back", lang, step=self.index + 1)
        if _AGAIN.match(text):
            self.again()
            return line("again", lang)
        return None

    def next(self) -> str:
        """The current step is done (a click on the spot, or "done")."""
        lang = self._lang()
        if not self.active:
            return ""
        if self.index + 1 >= len(self.steps):
            self._spawn(self.stop())
            return line("finished", lang)
        self.index += 1
        self.touched_at = self.clock()
        self._show(reuse=False, wait=self.settle)
        return line("next", lang, step=self.index + 1, total=len(self.steps))

    def again(self) -> None:
        """Look for the current step again (the window was resized, "I can't see it")."""
        if self.active:
            self.touched_at = self.clock()
            self._show(reuse=False, wait=self.settle)

    async def stop(self) -> None:
        self._cancel()
        if self.steps:
            self.ended_at = self.clock()
        self.steps = []
        self.index = 0
        await self.broadcast({"type": "guide", "state": "clear"})

    async def shell_event(self, action: str) -> None:
        """From the shell: ``hit`` (they clicked the spot), ``relocate`` (the window changed), ``stop`` (Esc)."""
        if action == "hit":
            if self.active and self.index + 1 >= len(self.steps):
                await self.say(line("finished", self._lang()))
            self.next()
        elif action == "relocate":
            self.again()
        elif action == "stop":
            await self.stop()

    # ------------------------------------------------------------ showing a step
    def _cancel(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None

    def _spawn(self, coroutine: Awaitable[Any]) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _show(self, reuse: bool, wait: float = 0.0) -> None:
        self._cancel()
        self._task = self._spawn(self._show_current(reuse, wait))

    async def _show_current(self, reuse: bool, wait: float) -> None:
        if not self.steps:
            return
        index, step, total = self.index, self.steps[self.index], len(self.steps)
        lang = self._lang()
        await self.broadcast({"type": "guide", "state": "looking", "step": index + 1, "total": total, "label": step.label})
        if wait:
            await asyncio.sleep(wait)
        glance = self.last if reuse and self.last is not None and self.clock() - self.last.taken < FRESH_S else None
        if glance is None:
            glance = await self.glance()
            if glance is not None:
                self.last = glance
                self._read_tree(glance)
        if glance is None:
            await self.broadcast({"type": "guide", "state": "lost", "step": index + 1, "total": total, "label": step.label})
            await self.say(line("blind", lang))
            return
        target = await self._locate(step.target, glance)
        to = await self._locate(step.to, glance) if target is not None and step.kind == "wire" else None
        if target is None or (step.kind == "wire" and to is None):
            await self.broadcast({"type": "guide", "state": "lost", "step": index + 1, "total": total, "label": step.label})
            missing = step.to if target is not None else step.target
            if self.eye.client() is None:
                await self.say(line("no_eye", lang))
            elif self.eye.error:
                await self.say(line("eye_error", lang, error=self.eye.error))
            else:
                await self.say(line("not_found", lang, label=step.label or missing[:60]))
            return
        window = glance.window
        await self.broadcast(
            {
                "type": "guide",
                "state": "show",
                "step": index + 1,
                "total": total,
                "label": step.label,
                "kind": step.kind,
                "action": step.action,
                "target": target,
                "to": to,
                "window": {key: window[key] for key in ("hwnd", "x", "y", "width", "height")} if window else None,
            }
        )
        logger.info("Guide: step %d/%d shown (%s)", index + 1, total, step.label or step.target[:40])

    def _read_tree(self, glance: Glance) -> None:
        """The window's accessibility tree, read right away: by the time it's needed it's there."""
        window = glance.window
        if window and window.get("hwnd"):
            self._tree = (glance.file, self._spawn(self.elements(window["hwnd"], window)))
        else:
            self._tree = None

    async def _locate(self, description: str, glance: Glance) -> dict[str, int] | None:
        """Where the description is, in physical screen pixels: by name in the tree, else by sight."""
        if self._tree is not None and self._tree[0] == glance.file:
            try:
                found = uia.match(description, await self._tree[1])
            except Exception:  # the tree is a shortcut: without it the eye looks
                found = None
            if found is not None:
                return found.rect()
        box = await self.eye.find(glance.file, description)
        if box is None:
            return None
        return glance.to_screen(box.left, box.top, box.right, box.bottom)
