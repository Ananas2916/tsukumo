"""Showing where on the screen: when she looks, the brain's tags, the steps, the commands."""

import asyncio

import pytest
from PIL import Image

from backend.config import Settings
from backend.eye import Box
from backend.guide import FOLLOW_UP_S, IDLE_S, LOOK_RULE, Glance, Guide, Step, parse_steps
from backend.pipeline import Companion
from backend.uia import Element

from helpers import Scripted


# ---------------------------------------------------------------------------
# When she looks
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "text",
    [
        "dove posso prendere un AND a 2 input?",
        "dove devo mettere questo connettore logico?",
        "dove devo collegare il cavo",
        "dov'è il pulsante per salvare?",
        "dove si trova la porta NOT?",
        "come faccio a cambiare la password?",
        "come si fa a inserire un'immagine?",
        "mostrami dove si esporta",
        "where is the export button?",
        "where do I click to save?",
        "how do I change the password?",
        "show me the settings",
    ],
)
def test_where_and_how_questions_look_at_the_screen(text):
    assert Guide(None, None, None, None).wants(text)


@pytest.mark.parametrize(
    "text",
    [
        "ciao, come stai?",
        "che tempo fa domani?",
        "raccontami una barzelletta",
        "what's the capital of France",
        "ricordami di chiamare Marco alle 5",
    ],
)
def test_other_questions_dont(text):
    assert not Guide(None, None, None, None).wants(text)


def test_never_when_off_or_without_her_window():
    assert not Guide(None, None, None, None, enabled=lambda: False).wants("dove trovo l'AND?")
    assert not Guide(None, None, None, None, can_glance=lambda: False).wants("dove trovo l'AND?")


def test_follow_ups_right_after_a_guide():
    now = [1000.0]
    guide = Guide(None, None, None, None, clock=lambda: now[0])
    assert not guide.wants("e adesso?")
    guide.ended_at = 990.0
    assert guide.wants("e adesso?") and guide.wants("e questo dove va?") and guide.wants("and now?")
    now[0] = 990.0 + FOLLOW_UP_S + 1
    assert not guide.wants("e adesso?")


# ---------------------------------------------------------------------------
# The brain's tags
# ---------------------------------------------------------------------------
def test_parse_steps_in_order():
    steps, look, rest = parse_steps(
        [
            "[[point: the AND gate icon, a D shape, in the second toolbar | AND]]",
            "[[wire: the output pin of the NOT under A1 -> the top input of the AND | collega]]",
            '[[point: the "Password" field | scrivi: la nuova password]]',
            "[[remind {\"in\": 60, \"text\": \"x\"}]]",
            "[[look]]",
        ]
    )
    assert steps == [
        Step("point", "the AND gate icon, a D shape, in the second toolbar", "", "AND", "click"),
        Step("wire", "the output pin of the NOT under A1", "the top input of the AND", "collega", "drag"),
        Step("point", 'the "Password" field', "", "scrivi: la nuova password", "type"),
    ]
    assert look and rest == ["[[remind {\"in\": 60, \"text\": \"x\"}]]"]


def test_parse_steps_tolerates_and_limits():
    steps, look, _ = parse_steps(["[[Point:   the menu  ]]", "[[wire: only one end | x]]", "[[point: | label only]]", "[[LOOK]]"])
    assert steps == [Step("point", "the menu")] and look
    many, _, _ = parse_steps([f"[[point: thing {n}]]" for n in range(20)])
    assert len(many) == 8


# ---------------------------------------------------------------------------
# A screenshot and where it sits
# ---------------------------------------------------------------------------
def shot(folder, name="glance.png", size=(2560, 1440)):
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    Image.new("RGB", size, (250, 250, 250)).save(path)
    return path


def message(path, **extra):
    return {
        "file": str(path),
        "display": {"x": 1920, "y": 0, "width": 2560, "height": 1440},
        "image": {"width": 1280, "height": 720},
        "window": {"hwnd": 4242, "x": 2000, "y": 100, "width": 1200, "height": 900, "title": "Deeds", "exe": "Deeds.exe"},
        **extra,
    }


def test_glance_is_checked(tmp_path):
    folder = tmp_path / "tsukumo"
    path = shot(folder)
    glance = Glance.from_message(message(path), 5.0, folder)
    assert glance.window["hwnd"] == 4242 and glance.taken == 5.0
    # The image is half the display: its pixels are doubled, and shifted to the second monitor.
    assert glance.to_screen(100, 50, 120, 60) == {"x": 2120, "y": 100, "width": 40, "height": 20}
    # Anything else isn't a screenshot of hers.
    outside = shot(tmp_path / "elsewhere")
    assert Glance.from_message(message(outside), 0, folder) is None
    assert Glance.from_message(message(folder / "missing.png"), 0, folder) is None
    assert Glance.from_message(message(path, display={"x": "a"}), 0, folder) is None
    assert Glance.from_message(message(path, image={"width": 0, "height": 10}), 0, folder) is None
    assert Glance.from_message("nope", 0, folder) is None
    text = folder / "notes.txt"
    text.write_text("x")
    assert Glance.from_message(message(text), 0, folder) is None
    # A broken window rectangle only loses the window.
    assert Glance.from_message(message(path, window={"x": 1}), 0, folder).window is None


# ---------------------------------------------------------------------------
# The steps
# ---------------------------------------------------------------------------
class FakeEye:
    def __init__(self, boxes=None, ready=True):
        self.boxes = boxes or {}
        self.ready = ready
        self.error = None
        self.asked = []

    def client(self):
        return object() if self.ready else None

    async def find(self, image, description):
        self.asked.append(description)
        return self.boxes.get(description)


class Rig:
    def __init__(self, tmp_path, eye=None, tree=None):
        self.folder = tmp_path / "tsukumo"
        self.sent = []
        self.said = []
        self.glances = 0
        self.now = 1000.0
        self.eye = eye or FakeEye()
        self.tree = tree or []
        self.guide = Guide(
            self.broadcast,
            self.glance,
            self.eye,
            self.say,
            language=lambda: "it",
            elements=self.elements,
            clock=lambda: self.now,
            settle=0,
            folder=self.folder,
        )

    async def broadcast(self, message):
        self.sent.append(message)

    async def say(self, text):
        self.said.append(text)

    async def glance(self):
        self.glances += 1
        return Glance.from_message(message(shot(self.folder, f"g{self.glances}.png")), self.now, self.folder)

    async def elements(self, hwnd, window):
        return list(self.tree)

    async def settle(self):
        while self.guide._tasks:
            await asyncio.gather(*list(self.guide._tasks), return_exceptions=True)

    def shown(self):
        return [m for m in self.sent if m.get("state") == "show"]


def test_steps_are_shown_one_at_a_time(tmp_path):
    eye = FakeEye({"the AND gate icon": Box(100, 50, 120, 60), "the canvas": Box(300, 200, 500, 400)})
    rig = Rig(tmp_path, eye)

    async def run():
        rig.guide.seen(message(shot(rig.folder)))
        rest, look = rig.guide.run_tags(["[[point: the AND gate icon | AND]]", "[[point: the canvas | qui]]", "[[remember: x]]"])
        assert rest == ["[[remember: x]]"] and not look
        await rig.settle()
        # The first step uses the screenshot the brain saw: no new one.
        assert rig.glances == 0
        [first] = rig.shown()
        assert first["step"] == 1 and first["total"] == 2 and first["label"] == "AND"
        assert first["target"] == {"x": 2120, "y": 100, "width": 40, "height": 20}
        assert first["window"] == {"hwnd": 4242, "x": 2000, "y": 100, "width": 1200, "height": 900}
        # The click on it (from the shell): a fresh look for the next one.
        await rig.guide.shell_event("hit")
        await rig.settle()
        assert rig.glances == 1 and rig.shown()[-1]["step"] == 2
        # The last one: done, the arrow goes.
        await rig.guide.shell_event("hit")
        await rig.settle()
        assert rig.said == ["Ecco fatto."] and rig.sent[-1] == {"type": "guide", "state": "clear"}
        assert not rig.guide.active

    asyncio.run(run())


def test_a_named_button_comes_from_the_tree_without_the_eye(tmp_path):
    eye = FakeEye()
    rig = Rig(tmp_path, eye, tree=[Element("Salva", "Button", 2500, 120, 24, 24)])

    async def run():
        rig.guide.seen(message(shot(rig.folder)))
        rig.guide.run_tags(['[[point: the "Salva" button | salva]]'])
        await rig.settle()

    asyncio.run(run())
    assert eye.asked == [] and rig.shown()[0]["target"] == {"x": 2500, "y": 120, "width": 24, "height": 24}


def test_a_wire_needs_both_ends(tmp_path):
    eye = FakeEye({"pin A": Box(10, 10, 14, 14), "pin B": Box(40, 40, 44, 44)})
    rig = Rig(tmp_path, eye)

    async def run():
        rig.guide.seen(message(shot(rig.folder)))
        rig.guide.run_tags(["[[wire: pin A -> pin B | collega]]"])
        await rig.settle()
        rig.guide.run_tags(["[[wire: pin A -> pin C | collega]]"])
        await rig.settle()

    asyncio.run(run())
    shown = rig.shown()
    assert shown[0]["kind"] == "wire" and shown[0]["action"] == "drag" and shown[0]["to"] == {"x": 2000, "y": 80, "width": 8, "height": 8}
    assert rig.sent[-1]["state"] == "lost" and rig.said == ["Non lo trovo sullo schermo: collega."]


def test_what_she_says_when_she_cant_point(tmp_path):
    for eye, expected in (
        (FakeEye(ready=False), "Per indicartelo mi serve un modello che vede"),
        (FakeEye(), "Non lo trovo sullo schermo: AND."),
    ):
        rig = Rig(tmp_path, eye)

        async def run():
            rig.guide.seen(message(shot(rig.folder)))
            rig.guide.run_tags(["[[point: the AND gate icon | AND]]"])
            await rig.settle()

        asyncio.run(run())
        assert rig.said[0].startswith(expected) and rig.sent[-1]["state"] == "lost"
        # The steps stay: "non lo vedo" after opening the menu looks again.
        assert rig.guide.active


def test_commands_while_a_guide_is_on(tmp_path):
    eye = FakeEye({"one": Box(1, 1, 5, 5), "two": Box(1, 1, 5, 5), "three": Box(1, 1, 5, 5)})
    rig = Rig(tmp_path, eye)

    async def run():
        assert await rig.guide.command("fatto") is None  # nothing on: the brain answers
        rig.guide.seen(message(shot(rig.folder)))
        rig.guide.run_tags(["[[point: one]]", "[[point: two]]", "[[point: three]]"])
        await rig.settle()
        assert await rig.guide.command("fatto") == "Passo 2 di 3."
        assert await rig.guide.command("ok, avanti!") == "Passo 3 di 3."
        assert await rig.guide.command("indietro") == "Torno al passo 2."
        assert await rig.guide.command("non lo vedo") == "Lo cerco di nuovo."
        assert await rig.guide.command("dove metto la resistenza?") is None
        assert await rig.guide.command("basta") == "Ok, tolgo la freccia."
        await rig.settle()
        assert not rig.guide.active and rig.sent[-1]["state"] == "clear"

    asyncio.run(run())


def test_a_forgotten_guide_goes_away(tmp_path):
    rig = Rig(tmp_path, FakeEye({"one": Box(1, 1, 5, 5)}))

    async def run():
        rig.guide.seen(message(shot(rig.folder)))
        rig.guide.run_tags(["[[point: one]]"])
        await rig.settle()

    asyncio.run(run())
    assert rig.guide.active
    rig.now += IDLE_S + 1
    assert not rig.guide.active and rig.guide.public() == {"active": False}


def test_what_the_brain_is_told(tmp_path):
    rig = Rig(tmp_path, FakeEye({"one": Box(1, 1, 5, 5)}))

    async def run():
        glance = rig.guide.seen(message(shot(rig.folder)))
        notes = rig.guide.notes(glance)
        assert notes[0] == LOOK_RULE and "«Deeds» (Deeds.exe)" in notes[1] and "[[point:" in notes[1] and "[[wire:" in notes[1]
        rig.guide.run_tags(["[[point: one | uno]]"])
        await rig.settle()

    asyncio.run(run())
    assert "step 1 of 1: «uno»" in rig.guide.notes(None)[1]
    assert Guide(None, None, None, None, enabled=lambda: False).notes(None) == []


# ---------------------------------------------------------------------------
# In the conversation
# ---------------------------------------------------------------------------
class Recorder:
    def __init__(self):
        self.messages = []

    async def __call__(self, message):
        self.messages.append(message)

    def of(self, kind):
        return [m for m in self.messages if m["type"] == kind]


def companion_with_guide(tmp_path, pieces, eye=None):
    rig = Rig(tmp_path, eye or FakeEye({"the AND gate icon": Box(100, 50, 120, 60)}))
    companion = Companion(Settings.from_env())
    companion.llm = Scripted(pieces)
    companion.guide = rig.guide
    captures = []

    async def capture(text, guide=False, again=False):
        captures.append((text, guide, again))
        return True

    companion.screen_capture = capture
    return companion, rig, captures


def test_a_where_question_asks_for_the_screen_first(tmp_path):
    companion, _, captures = companion_with_guide(tmp_path, ["non dovrei rispondere"])
    asyncio.run(companion.chat("dove trovo l'AND a 2 ingressi?", Recorder()))
    assert captures == [("dove trovo l'AND a 2 ingressi?", True, False)] and companion.llm.messages is None
    # The phone, or a shell that couldn't look: the brain answers without the screen.
    asyncio.run(companion.chat("dove trovo l'AND a 2 ingressi?", Recorder(), silent=True))
    asyncio.run(companion.chat("dove trovo l'AND a 2 ingressi?", Recorder(), blind=True))
    assert len(captures) == 1


def test_the_answer_points_and_the_tag_is_never_said(tmp_path):
    companion, rig, _ = companion_with_guide(
        tmp_path, ["È nella seconda barra, ", "il simbolo a D. [[point: the AND gate icon | AND]]"]
    )
    emit = Recorder()
    path = shot(rig.folder)

    async def run():
        await companion.chat("dove trovo l'AND?", emit, files=[str(path)], screen=True, glance=message(path))
        await rig.settle()

    asyncio.run(run())
    system = companion.llm.messages[1].content
    assert "[[point:" in system and LOOK_RULE in system
    assert companion.llm.messages[-1].images == (str(path.resolve()),)
    spoken = " ".join(m["text"] for m in emit.of("speech"))
    assert "point" not in spoken and "[[" not in emit.of("reply")[0]["text"]
    assert rig.shown()[0]["label"] == "AND"


def test_look_tag_sends_the_question_back_with_the_screen(tmp_path):
    companion, _, captures = companion_with_guide(tmp_path, ["[[look]]"])
    emit = Recorder()
    asyncio.run(companion.chat("e questo cos'è?", emit))
    assert captures == [("e questo cos'è?", True, True)]
    # Back with the screenshot: it's already in the chat, no second bubble.
    emit = Recorder()
    companion.llm = Scripted(["È una porta NOT."])
    asyncio.run(companion.chat("e questo cos'è?", emit, again=True, blind=True))
    assert emit.of("user") == [] and emit.of("reply")[0]["text"] == "È una porta NOT."


def test_look_without_anyone_to_take_the_screenshot_still_answers(tmp_path):
    companion, _, captures = companion_with_guide(tmp_path, ["[[look]]"])

    async def nobody(text, guide=False, again=False):
        captures.append((text, guide, again))
        return False

    companion.screen_capture = nobody
    emit = Recorder()
    asyncio.run(companion.chat("e questo cos'è?", emit))
    # Asked once, then back to the brain without the screen: no loop, no rule about [[look]].
    assert captures == [("e questo cos'è?", True, True)]
    assert LOOK_RULE not in companion.llm.messages[1].content
    assert len(emit.of("reply")) == 2


def test_done_is_answered_without_the_brain(tmp_path):
    companion, rig, _ = companion_with_guide(tmp_path, ["non dovrei rispondere"], FakeEye({"one": Box(1, 1, 5, 5), "two": Box(1, 1, 5, 5)}))
    emit = Recorder()

    async def run():
        rig.guide.seen(message(shot(rig.folder)))
        rig.guide.run_tags(["[[point: one]]", "[[point: two]]"])
        await rig.settle()
        await companion.chat("fatto", emit)
        await rig.settle()

    asyncio.run(run())
    assert companion.llm.messages is None and emit.of("reply")[0]["text"] == "Passo 2 di 2."
