"""electron/pet-physics.js: lo sprint della fiammella, con finestre e schermo finti."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PHYSICS = ROOT / "electron" / "pet-physics.js"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="serve node")

# Uno schermo 1920x1040 (la barra sotto), la finestra 300x460 in piedi in basso a destra.
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
    # random: direzione, poi il traguardo (0 = il piu' a sinistra possibile).
    out = _run(tmp_path, kind="dash", randoms=[0.9, 0.0])
    assert out["started"] and out["state"] == "ground" and out["run"] is None
    assert out["phases"] == ["ready", "go", "brake", "proud", "ready", "go", "brake", "proud", "end"]
    assert abs(out["final"] - out["home"]) < 1
    # Lontano almeno un terzo di schermo, ma sempre dentro, rimbalzo compreso.
    assert out["minCenter"] <= out["home"] - out["area"]["width"] / 3
    assert 0 <= out["minCenter"] and out["maxCenter"] <= out["area"]["width"]
    assert out["topSpeed"] > 0.99
    # Sempre in piedi sulla barra, e veloce: tutto in pochi secondi.
    assert len(out["ys"]) == 1
    assert out["t"] < 5


def test_lap_leaves_one_edge_and_comes_back_from_the_other(tmp_path):
    out = _run(tmp_path, kind="lap", randoms=[0.9])  # 0.9: verso destra
    assert out["first"]["lap"] is True
    assert out["phases"] == ["ready", "go", "brake", "proud", "end"]
    assert out["maxX"] > out["area"]["width"]  # uscita del tutto a destra...
    assert out["minX"] < -300 + 1  # ...e rientrata da sinistra
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
