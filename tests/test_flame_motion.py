"""frontend/src/flame/motion.js and moves.js: the curves of the flame's gestures."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FLAME = ROOT / "frontend" / "src" / "flame"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="serve node")

HARNESS = """
import { chain, EASE, hop, length, REST, sample, Spring, Squash, wait, duration, play } from %(motion)s;
import { MOVES } from %(moves)s;

const out = {};
// Simple curves: the ends, a pause, past the end.
const line = [0, [1, 100, 'lin'], [1, 100, 'lin'], [0, 200, 'inOut']];
out.line = [0, 0.05, 0.1, 0.15, 0.3, 0.4, 9].map((s) => +sample(line, s).toFixed(4));
out.lineLength = length(line);
// back goes past and comes back; anticipate starts backwards.
out.backMax = Math.max(...Array.from({ length: 101 }, (_, i) => EASE.back(i / 100)));
out.anticipateMin = Math.min(...Array.from({ length: 101 }, (_, i) => EASE.anticipate(i / 100)));
out.easeEnds = Object.fromEntries(Object.entries(EASE).map(([k, f]) => [k, [+f(0).toFixed(6), +f(1).toFixed(6)]]));

// chain: the channels stay aligned.
const c = chain({}, { y: [[1, 100, 'out']] }, { sq: [[0.5, 50, 'out']] }, wait(30));
out.chain = { y: c.y, sq: c.sq, duration: duration(c) };

// Every gesture ends at rest (no jumps when the reaction ends).
const TAU = Math.PI * 2;
out.moves = {};
for (const [name, make] of Object.entries(MOVES)) {
  const tracks = make(0.5);
  const end = play(tracks, duration(tracks) + 0.001);
  const bad = {};
  for (const [channel, value] of Object.entries(end)) {
    const rest = channel === 'gx' || channel === 'gy' ? 0 : REST[channel];
    const off = channel === 'spin' ? Math.abs(value - Math.round(value / TAU) * TAU) : Math.abs(value - rest);
    if (rest === undefined || off > 1e-6) bad[channel] = value;
  }
  const lengths = Object.values(tracks).map(length);
  out.moves[name] = { bad, duration: duration(tracks), starts: Object.fromEntries(Object.entries(tracks).map(([k, v]) => [k, v[0]])), lengths };
}

// The spring goes back to its target.
const spring = new Spring(0, 0.3, 0.4);
spring.kick(5);
let peak = 0;
for (let i = 0; i < 240; i++) peak = Math.max(peak, spring.step(1 / 60));
out.spring = { peak, value: spring.value, settled: spring.settled };

// A real hop: she stretches in the air, squashes on touching the ground, then goes back to 1.
const jump = chain({}, hop(0.3));
const squash = new Squash();
const sy = [];
for (let i = 0; i < 90; i++) sy.push(squash.update(1 / 60, sample(jump.y, i / 60)));
const landAt = Math.round(length(jump.y) / (1000 / 60));
out.squash = {
  air: Math.max(...sy.slice(8, landAt - 2)),
  landing: Math.min(...sy.slice(landAt - 1, landAt + 15)),
  end: sy[sy.length - 1],
  busy: squash.busy,
};
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def result():
    script = HARNESS % {"motion": json.dumps((FLAME / "motion.js").as_uri()), "moves": json.dumps((FLAME / "moves.js").as_uri())}
    done = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30, check=False)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def test_sample_follows_keys_and_holds(result):
    assert result["line"] == [0, 0.5, 1, 1, 0.5, 0, 0]
    assert result["lineLength"] == 400


def test_eases_start_at_zero_and_end_at_one(result):
    for name, (start, end) in result["easeEnds"].items():
        assert start == 0, name
        assert end == 1, name
    assert result["backMax"] > 1.05
    assert result["anticipateMin"] < -0.05


def test_chain_keeps_channels_aligned(result):
    chained = result["chain"]
    # y keeps its value until the end (during the pause too).
    assert chained["y"] == [0, [1, 100, "out"], [1, 80, "lin"]]
    # sq starts when the piece before ends: 100 ms still, then 50, then the pause.
    assert chained["sq"] == [1, [1, 100, "lin"], [0.5, 50, "out"], [0.5, 30, "lin"]]
    assert chained["duration"] == pytest.approx(0.18)


def test_every_move_ends_at_rest(result):
    for name, move in result["moves"].items():
        assert move["bad"] == {}, f"{name} finisce fuori riposo: {move['bad']}"
        assert 0.3 <= move["duration"] <= 3, name


def test_every_move_starts_at_rest(result):
    rest = {"y": 0, "sq": 1, "spin": 0, "tilt": 0, "bend": 0, "glow": 0, "es": 1, "mouth": 0, "glasses": 0, "sweat": 0, "bang": 0, "blush": 0, "gx": 0, "gy": 0}
    for name, move in result["moves"].items():
        for channel, start in move["starts"].items():
            assert start == rest[channel], f"{name}.{channel} parte da {start}"


def test_spring_settles(result):
    assert result["spring"]["peak"] > 0.1
    assert abs(result["spring"]["value"]) < 0.01
    assert result["spring"]["settled"]


def test_hop_stretches_in_the_air_and_squashes_on_landing(result):
    squash = result["squash"]
    assert squash["air"] > 1.05
    assert squash["landing"] < 0.92
    assert squash["end"] == pytest.approx(1, abs=0.01)
