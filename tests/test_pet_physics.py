"""electron/pet-physics.js: the flame's sprint, with fake windows and screen."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PHYSICS = ROOT / "electron" / "pet-physics.js"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="serve node")

# A 1920x1040 screen (the taskbar below), the 300x460 window standing at the bottom right.
HARNESS = """
const { PetPhysics } = require(%(physics)s);
const scenario = %(scenario)s;
const area = { x: 0, y: 0, width: scenario.width || 1920, height: 1040 };
const bounds = { x: 0, y: 0, width: 300, height: 460 };
bounds.x = area.x + area.width - bounds.width - 40;
bounds.y = Math.round(area.y + area.height - bounds.height * 0.985);
const messages = [];
const randoms = [...(scenario.randoms || [])];
const physics = new PetPhysics({
  bounds: () => ({ ...bounds }),
  move: (x, y) => { bounds.x = x; bounds.y = y; },
  workArea: () => area,
  windows: () => [],
  windowRect: () => null,
  emit: (message) => messages.push(message),
  random: () => (randoms.length ? randoms.shift() : 0.5),
});
if (scenario.state) physics.state = scenario.state;
if (scenario.posture) physics.posture = scenario.posture;
const center = () => bounds.x + bounds.width / 2;
const home = center();
const started = physics.sprint(scenario.kind);
const xs = [], ys = new Set(), centers = [];
let t = 0;
while (started && physics.state === 'sprint' && t < 20) {
  physics.step(1 / 60);
  t += 1 / 60;
  xs.push(bounds.x);
  ys.add(bounds.y);
  centers.push(center());
  if (scenario.grabAfter && t >= scenario.grabAfter) physics.grab();
}
console.log(JSON.stringify({
  started, home, t, state: physics.state, run: physics.run,
  final: center(), minX: Math.min(...xs), maxX: Math.max(...xs), ys: [...ys],
  minCenter: Math.min(...centers), maxCenter: Math.max(...centers),
  phases: messages.filter((m) => m.state === 'sprint').map((m) => m.phase),
  first: messages[0] || null,
  topSpeed: Math.max(0, ...messages.filter((m) => m.state === 'sprint-move').map((m) => m.speed)),
  area,
}));
"""


def _run(tmp_path, **scenario):
    script = tmp_path / "sprint.cjs"
    script.write_text(HARNESS % {"physics": json.dumps(str(PHYSICS)), "scenario": json.dumps(scenario)}, encoding="utf-8")
    result = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


def test_dash_runs_far_and_comes_back_home(tmp_path):
    # random: direction, then the finish line (0 = as far left as possible).
    out = _run(tmp_path, kind="dash", randoms=[0.9, 0.0])
    assert out["started"] and out["state"] == "ground" and out["run"] is None
    assert out["phases"] == ["ready", "go", "brake", "proud", "ready", "go", "brake", "proud", "end"]
    assert abs(out["final"] - out["home"]) < 1
    # At least a third of the screen away, but always inside, bounce included.
    assert out["minCenter"] <= out["home"] - out["area"]["width"] / 3
    assert 0 <= out["minCenter"] and out["maxCenter"] <= out["area"]["width"]
    assert out["topSpeed"] > 0.99
    # Always standing on the taskbar, and fast: all in a few seconds.
    assert len(out["ys"]) == 1
    assert out["t"] < 5


def test_lap_leaves_one_edge_and_comes_back_from_the_other(tmp_path):
    out = _run(tmp_path, kind="lap", randoms=[0.9])  # 0.9: to the right
    assert out["first"]["lap"] is True
    assert out["phases"] == ["ready", "go", "brake", "proud", "end"]
    assert out["maxX"] > out["area"]["width"]  # fully out on the right...
    assert out["minX"] < -300 + 1  # ...and back in from the left
    assert abs(out["final"] - out["home"]) < 1
    assert len(out["ys"]) == 1


def test_narrow_screen_turns_a_dash_into_a_lap(tmp_path):
    out = _run(tmp_path, kind="dash", width=500, randoms=[0.9])
    assert out["first"]["lap"] is True
    assert out["state"] == "ground"


@pytest.mark.parametrize(("state", "posture"), [("window", "sit"), ("falling", "stand"), ("ground", "sit")])
def test_no_sprint_unless_standing_on_the_taskbar(tmp_path, state, posture):
    out = _run(tmp_path, kind="dash", state=state, posture=posture)
    assert out["started"] is False
    assert out["phases"] == []


def test_grabbing_her_stops_the_sprint(tmp_path):
    out = _run(tmp_path, kind="dash", randoms=[0.9, 0.0], grabAfter=0.5)
    assert out["state"] == "held" and out["run"] is None
    assert out["phases"][-1] == "end"


def test_invalid_anchors_never_reach_the_window():
    """With the window minimized the renderer measured the anchors dividing by zero."""
    script = """
const { PetPhysics } = require(%s);
const moves = [];
const physics = new PetPhysics({
  bounds: () => ({ x: 100, y: 500, width: 300, height: 460 }),
  move: (x, y) => moves.push([x, y]),
  workArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
  windows: () => [], windowRect: () => null, emit: () => {}, random: () => 0.5,
});
physics.setAnchors({ feet: Infinity, seat: NaN, center: 1 / 0 });
physics.setAnchors({ feet: 'x', center: -5 });
physics.setAnchors(null);
console.log(JSON.stringify({ anchors: physics.anchors, finite: moves.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) }));
""" % json.dumps(str(PHYSICS))
    result = json.loads(subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout)
    assert result["anchors"] == {"feet": 0.985, "seat": 0.56, "center": 0.5}
    assert result["finite"]


# The flame's throw: she starts held in mid-air and is let go with a velocity.
THROW_HARNESS = """
const { PetPhysics, THROW } = require(%(physics)s);
const scenario = %(scenario)s;
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const bounds = { x: scenario.x ?? 800, y: scenario.y ?? 200, width: 300, height: 460 };
const messages = [];
const physics = new PetPhysics({
  bounds: () => ({ ...bounds }),
  move: (x, y) => { bounds.x = x; bounds.y = y; },
  workArea: () => area,
  windows: () => [],
  windowRect: () => null,
  emit: (message) => messages.push(message),
  random: () => 0.5,
});
const center = () => bounds.x + bounds.width / 2;
const start = center();
physics.grab();
physics.release(scenario.velocity);
const centers = [];
let steps = 0;
let maxStep = 0;
while (physics.state === 'falling' && steps < 600) {
  const before = center();
  physics.step(1 / 60);
  steps += 1;
  maxStep = Math.max(maxStep, Math.abs(center() - before));
  centers.push(center());
}
console.log(JSON.stringify({
  start, state: physics.state, thrown: physics.thrown, first: messages[0] || null,
  kinds: [...new Set(messages.map((m) => m.state))],
  bonks: messages.filter((m) => m.state === 'bonk'),
  flies: messages.filter((m) => m.state === 'fly').length,
  minCenter: Math.min(...centers), maxCenter: Math.max(...centers), final: center(),
  maxStep, edge: THROW.edge, max: THROW.max,
}));
"""


def _throw(tmp_path, **scenario):
    script = tmp_path / "throw.cjs"
    script.write_text(THROW_HARNESS % {"physics": json.dumps(str(PHYSICS)), "scenario": json.dumps(scenario)}, encoding="utf-8")
    result = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


def test_a_throw_flies_sideways_and_lands_further_on(tmp_path):
    out = _throw(tmp_path, velocity={"vx": 1800, "vy": -500})
    assert out["first"] == {"state": "falling", "thrown": True, "vx": 1800}
    assert out["state"] == "ground" and out["thrown"] is False
    assert {"fly", "landed"} <= set(out["kinds"])
    assert out["flies"] > 5
    assert out["final"] > out["start"] + 300


def test_a_throw_bounces_off_the_screen_edge(tmp_path):
    out = _throw(tmp_path, x=1450, velocity={"vx": 3000, "vy": -200})
    assert out["bonks"] and out["bonks"][0]["side"] == "right"
    assert 0 < out["bonks"][0]["impact"] <= 1
    # Never past the edge, and after the hit she comes back.
    assert out["maxCenter"] <= 1920 - 300 * out["edge"] + 1
    assert out["final"] < out["maxCenter"]


def test_a_throw_upwards_bounces_off_the_top(tmp_path):
    out = _throw(tmp_path, y=150, velocity={"vx": 0, "vy": -3000})
    assert any(bonk["side"] == "top" for bonk in out["bonks"])
    assert out["state"] == "ground"


@pytest.mark.parametrize(
    "velocity",
    [None, {"vx": 120, "vy": 80}, {"vx": "x", "vy": 2000}, {"vx": float("nan"), "vy": 0}, {"vy": 5000}],
)
def test_a_gentle_or_invalid_release_just_falls(tmp_path, velocity):
    out = _throw(tmp_path, velocity=velocity)
    assert out["first"] == {"state": "falling"}
    assert out["flies"] == 0
    assert out["minCenter"] == out["maxCenter"] == out["start"]
    assert out["state"] == "ground"


def test_a_throw_is_capped(tmp_path):
    out = _throw(tmp_path, velocity={"vx": 1e9, "vy": 0})
    assert out["first"]["vx"] == out["max"]
    assert out["maxStep"] <= out["max"] / 60 + 1


def test_sitting_on_a_window_survives_a_wider_window(tmp_path):
    """The menu island widens her window around her: sitting on a window she must not jump aside."""
    script = tmp_path / "ride.cjs"
    script.write_text(
        """
const { PetPhysics } = require(%s);
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const target = { hwnd: 7, x: 400, y: 600, width: 900, height: 400, maximized: false };
const bounds = { x: 600, y: 100, width: 300, height: 460 };
const physics = new PetPhysics({
  bounds: () => ({ ...bounds }),
  move: (x, y) => { bounds.x = x; bounds.y = y; },
  workArea: () => area,
  windows: () => [target],
  windowRect: () => ({ ...target }),
  emit: () => {},
  random: () => 0.5,
});
physics.state = 'falling';
for (let i = 0; i < 240 && physics.state === 'falling'; i += 1) physics.step(1 / 60);
const axis = () => bounds.x + bounds.width * physics.anchors.center;
const before = axis();
// Wider by 140 px, extended only to the left (near a screen edge): she is 70 px right of the centre.
bounds.x -= 140; bounds.width += 140;
physics.setAnchors({ center: (bounds.width / 2 + 70) / bounds.width });
for (let i = 0; i < 30; i += 1) physics.step(1 / 60);
const wide = axis();
target.x += 50;  // the window moves: she rides along
for (let i = 0; i < 5; i += 1) physics.step(1 / 60);
console.log(JSON.stringify({ state: physics.state, before, wide, moved: axis() }));
"""
        % json.dumps(str(PHYSICS)),
        encoding="utf-8",
    )
    out = json.loads(subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=30, check=True).stdout)
    assert out["state"] == "window"
    assert abs(out["wide"] - out["before"]) < 1
    assert abs(out["moved"] - (out["before"] + 50)) < 1


def test_the_moved_island_holds_her_up_until_it_closes(tmp_path):
    """Moved by its black and let go, the island stays in the air with her; closed, she falls."""
    script = tmp_path / "park.cjs"
    script.write_text(
        """
const { PetPhysics } = require(%s);
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const bounds = { x: 600, y: 200, width: 460, height: 460 };
const messages = [];
const physics = new PetPhysics({
  bounds: () => ({ ...bounds }),
  move: (x, y) => { bounds.x = x; bounds.y = y; },
  workArea: () => area,
  windows: () => [],
  windowRect: () => null,
  emit: (message) => messages.push(message),
  random: () => 0.5,
});
physics.grab();
bounds.x = 300; bounds.y = 120;
physics.park();
for (let i = 0; i < 120; i += 1) physics.step(1 / 60);
const parked = { state: physics.state, x: bounds.x, y: bounds.y };
physics.park();  // only from "held"
const again = physics.state;
physics.release();
for (let i = 0; i < 240 && physics.state === 'falling'; i += 1) physics.step(1 / 60);
console.log(JSON.stringify({ parked, again, state: physics.state, y: bounds.y, first: messages[0] }));
"""
        % json.dumps(str(PHYSICS)),
        encoding="utf-8",
    )
    out = json.loads(subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=30, check=True).stdout)
    assert out["parked"] == {"state": "parked", "x": 300, "y": 120}
    assert out["again"] == "parked"
    assert out["first"] == {"state": "falling"}
    assert out["state"] == "ground"
    assert out["y"] > 120
