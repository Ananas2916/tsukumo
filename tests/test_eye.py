"""The eye: every model family's coordinates, the zoom on small things, which engine looks."""

import asyncio
from types import SimpleNamespace

import numpy
import pytest
from PIL import Image

from backend.eye import MAX_PIXELS, MAX_SIDE, PATCH, Box, Eye, fit, parse_box, style_for
from backend.llm.base import LLMClient


@pytest.mark.parametrize(
    ("model", "style"),
    [
        ("gemini-2.5-flash", "gemini"),
        ("google/gemini-2.0-flash-001", "gemini"),
        ("qwen/qwen3-vl-235b-a22b-instruct", "thousandths"),
        ("Qwen3VL-8B", "thousandths"),
        ("z-ai/glm-4.5v", "thousandths"),
        ("qwen2.5-vl-7b-instruct", "pixels"),
        ("claude-sonnet-4-5", "pixels"),
        ("gpt-4.1", "pixels"),
        ("ui-tars-1.5-7b", "pixels"),
        ("", "pixels"),
    ],
)
def test_style_for_each_family(model, style):
    assert style_for(model) == style


def rounded(box):
    return box and tuple(round(value) for value in (box.left, box.top, box.right, box.bottom))


@pytest.mark.parametrize(
    ("text", "style", "expected"),
    [
        # Gemini: y first, thousandths.
        ('{"box_2d": [100, 200, 150, 260]}', "gemini", (200, 50, 260, 75)),
        ('```json\n[{"box_2d": [100, 200, 150, 260], "label": "AND"}]\n```', "gemini", (200, 50, 260, 75)),
        # Qwen3-VL: x first, thousandths.
        ('{"bbox_2d": [200, 100, 260, 150]}', "thousandths", (200, 50, 260, 75)),
        # Pixels of the image as sent.
        ('{"bbox_2d": [200, 50, 260, 75]}', "pixels", (200, 50, 260, 75)),
        ('Here it is: {"bbox": {"x": 200, "y": 50, "width": 60, "height": 25}}', "pixels", (200, 50, 260, 75)),
        # A thinking model reasons first: the answer is the last one.
        ('<think>maybe {"bbox_2d": [1, 1, 5, 5]}</think>{"bbox_2d": [200, 50, 260, 75]}', "pixels", (200, 50, 260, 75)),
        # Fractions, in a model that should have answered in pixels.
        ('{"bbox_2d": [0.2, 0.1, 0.26, 0.15]}', "pixels", (200, 50, 260, 75)),
        # Beyond the image but within 1000: thousandths after all.
        ('{"bbox_2d": [200, 600, 260, 650]}', "pixels", (200, 300, 260, 325)),
        # UI-TARS / Qwen tokens.
        ("click(start_box='<|box_start|>(200,50),(260,75)<|box_end|>')", "pixels", (200, 50, 260, 75)),
        # Molmo points, in percent: a small box around the point.
        ('<point x="50.0" y="20.0" alt="AND">AND</point>', "pixels", (492, 92, 508, 108)),
        # A Gemini point is [y, x].
        ('{"point": [200, 500]}', "gemini", (492, 92, 508, 108)),
        # Plain list, nothing else.
        ("[200, 50, 260, 75]", "pixels", (200, 50, 260, 75)),
        # Order fixed.
        ('{"bbox_2d": [260, 75, 200, 50]}', "pixels", (200, 50, 260, 75)),
    ],
)
def test_parse_box_reads_every_family(text, style, expected):
    assert rounded(parse_box(text, style, 1000, 500)) == expected


@pytest.mark.parametrize(
    "text",
    [
        '{"found": false}',
        "It is not visible in this screenshot.",
        "I don't know.",
        '{"bbox_2d": [0, 0, 1000, 500]}',  # the whole screen isn't an answer
        '{"bbox_2d": [10, 10, 10, 40]}',  # no width
        "",
    ],
)
def test_parse_box_rejects_non_answers(text):
    assert parse_box(text, "pixels", 1000, 500) is None


def test_fit_stays_within_the_models_limits():
    for size in ((2560, 1440), (3840, 2160), (1920, 1080), (1366, 768), (800, 600), (5000, 300)):
        width, height = fit(*size)
        assert width % PATCH == 0 and height % PATCH == 0
        assert max(width, height) <= MAX_SIDE and width * height <= MAX_PIXELS
        assert abs(width / height - size[0] / size[1]) / (size[0] / size[1]) < 0.12
    # A small crop is enlarged, up to the factor asked.
    assert fit(400, 300, upscale=2.0) == (784, 588)
    assert fit(400, 300) == (392, 280)


class Looker(LLMClient):
    """A fake eye: answers each look with the next text, and keeps what it saw."""

    name = "looker"

    def __init__(self, answers, model="claude-sonnet-4-5"):
        self.answers = list(answers)
        self.model = model
        self.seen = []

    async def stream(self, messages):
        message = messages[-1]
        with Image.open(message.images[0]) as image:
            self.seen.append((image.size, message.content))
        yield self.answers.pop(0)

    async def health(self):
        return {"ok": True}


def eye_with(client, tmp_path, size=(2560, 1440)):
    shot = tmp_path / "glance.png"
    Image.new("RGB", size, (240, 240, 240)).save(shot)
    eye = Eye(SimpleNamespace(), SimpleNamespace(eye="", eye_model=""))
    eye.client = lambda: client
    return eye, shot


class RedFinder(Looker):
    """Finds the red square in whatever image it gets, like a model would: within a couple of pixels."""

    def __init__(self):
        super().__init__([])

    async def stream(self, messages):
        message = messages[-1]
        with Image.open(message.images[0]) as image:
            self.seen.append((image.size, message.content))
            pixels = numpy.asarray(image.convert("RGB")).astype(int)
        ys, xs = numpy.nonzero((pixels[:, :, 0] > 180) & (pixels[:, :, 1] < 90))
        # A model's answer is never exact: two pixels of slack each side.
        yield f'{{"bbox_2d": [{xs.min() - 2}, {ys.min() - 2}, {xs.max() + 2}, {ys.max() + 2}]}}'


def test_a_small_hit_is_looked_at_again_closer(tmp_path):
    # A 16 px toolbar icon on a 2560x1440 screen: shrunk to fit the model it's 9 px.
    looker = RedFinder()
    eye, shot = eye_with(looker, tmp_path)
    with Image.open(shot) as image:
        image.paste((220, 20, 20), (900, 60, 916, 76))
        image.save(shot)
    box = asyncio.run(eye.find(shot, "the AND gate icon"))
    (first_size, first_prompt), (second_size, _) = looker.seen
    assert first_size == fit(2560, 1440)
    assert "Find: the AND gate icon" in first_prompt and f"{first_size[0]}x{first_size[1]}" in first_prompt
    # The second look is a crop, enlarged: the slack shrinks with it.
    assert second_size[0] > 480
    first_error = 2 * 2560 / first_size[0]
    assert abs(box.left - 900) < first_error and abs(box.right - 916) < first_error
    assert abs(box.left - 900) <= 1.5 and abs(box.top - 60) <= 1.5 and abs(box.bottom - 76) <= 1.5
    assert not list(tmp_path.glob("eye-*.png"))


def test_a_big_hit_needs_no_second_look(tmp_path):
    looker = Looker(['{"bbox_2d": [100, 100, 400, 300]}'])
    eye, shot = eye_with(looker, tmp_path, size=(1400, 784))
    box = asyncio.run(eye.find(shot, "the canvas"))
    assert len(looker.seen) == 1 and rounded(box) == (100, 100, 400, 300)


def test_if_the_closer_look_misses_the_first_stays(tmp_path):
    looker = Looker(['{"bbox_2d": [95, 35, 105, 45]}', '{"found": false}'])
    eye, shot = eye_with(looker, tmp_path)
    box = asyncio.run(eye.find(shot, "the AND gate icon"))
    assert box is not None and len(looker.seen) == 2


def test_gemini_is_asked_in_its_own_format(tmp_path):
    looker = Looker(['{"box_2d": [500, 500, 600, 600]}'], model="gemini-2.5-flash")
    eye, shot = eye_with(looker, tmp_path, size=(1000, 1000))
    box = asyncio.run(eye.find(shot, "the OK button"))
    assert "box_2d" in looker.seen[0][1] and "0-1000" in looker.seen[0][1]
    assert rounded(box) == (500, 500, 600, 600)


def test_errors_are_kept_for_the_panel(tmp_path):
    class Broken(Looker):
        async def stream(self, messages):
            raise RuntimeError("401 Unauthorized")
            yield ""  # pragma: no cover

    eye, shot = eye_with(Broken([]), tmp_path)
    assert asyncio.run(eye.find(shot, "anything")) is None
    assert "401" in eye.error


def test_which_engine_looks():
    from backend.config import Settings

    settings = Settings.from_env()
    chosen = SimpleNamespace(eye="gemini", eye_model="gemini-2.5-flash")
    assert Eye(settings, chosen).engine() == "gemini"
    # Nobody chosen: the main brain if it's a model (it may see), never an agent.
    nobody = SimpleNamespace(eye="", eye_model="")
    settings.selected = lambda kind: "claude_code"
    assert Eye(settings, nobody).engine() == ""
    settings.selected = lambda kind: "openrouter"
    assert Eye(settings, nobody).engine() == "openrouter"


def test_an_agent_cant_be_the_eye():
    from backend.config import Settings

    eye = Eye(Settings.from_env(), SimpleNamespace(eye="codex", eye_model=""))
    assert eye.client() is None and "can't be the eye" in eye.error


def test_box_mapping():
    box = Box(10, 20, 30, 40).mapped(2, 3, 100, 200)
    assert (box.left, box.top, box.right, box.bottom) == (120, 260, 160, 320)
    assert Box(-5, -5, 50, 50).clipped(40, 40) == Box(0, 0, 40, 40)
