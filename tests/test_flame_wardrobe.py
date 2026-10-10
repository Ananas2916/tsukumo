"""frontend/src/flame/wardrobe.js and palettes.js: what the flame wears and what colour she is."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FLAME = ROOT / "frontend" / "src" / "flame"
PANEL = ROOT / "frontend" / "src" / "panel"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="serve node")

HARNESS = """
import { OUTFITS, SELECTIONS, OUTFIT_LABELS, parseOutfit, resolveOutfit, seasonalOutfit } from %(wardrobe)s;
import { palette, paletteKey, PALETTES, PALETTE_LABELS, swatchColor, fromColor } from %(palettes)s;
import { outfitPreview } from %(art)s;

const day = (m, d, y = 2026) => new Date(y, m - 1, d, 12);
const out = {};
out.seasons = Object.fromEntries([
  ['12-31', day(12, 31)], ['01-01', day(1, 1)], ['01-02', day(1, 2)], ['01-03', day(1, 3)],
  ['12-01', day(12, 1)], ['12-26', day(12, 26)], ['12-27', day(12, 27)],
  ['10-01', day(10, 1)], ['10-09', day(10, 9)], ['10-31', day(10, 31)], ['11-01', day(11, 1)], ['11-02', day(11, 2)],
  ['03-24', day(3, 24)], ['03-25', day(3, 25)], ['04-15', day(4, 15)], ['04-16', day(4, 16)],
  ['06-30', day(6, 30)], ['07-01', day(7, 1)], ['08-31', day(8, 31)], ['09-01', day(9, 1)],
  ['02-14', day(2, 14)], ['05-10', day(5, 10)],
].map(([k, d]) => [k, seasonalOutfit(d)]));
out.parse = ['witch', 'auto', 'none', 'topHat', '', null, 42, '__proto__'].map(parseOutfit);
out.resolve = [resolveOutfit('auto', day(10, 9)), resolveOutfit('scarf', day(10, 9)), resolveOutfit('bogus', day(12, 5))];
out.labels = SELECTIONS.every((s) => typeof OUTFIT_LABELS[s] === 'string');
out.selections = SELECTIONS;
out.outfits = OUTFITS;

out.keys = ['lilac', '#AbCdEf', '#abc', 'red', '#12345g', null, '#000000'].map(paletteKey);
const free = palette('#3fa7ff');
const fields = ['low', 'high', 'emissive', 'glow', 'accent', 'soft'];
out.free = Object.fromEntries(fields.map((f) => [f, free[f]]));
out.freeOk = fields.every((f) => Number.isInteger(free[f]) && free[f] >= 0 && free[f] <= 0xffffff);
out.fallback = palette('nope') === PALETTES.lilac;
out.swatches = Object.keys(PALETTE_LABELS).map(swatchColor);
out.grey = fromColor(0x808080);

// Every preview in the panel draws, in every colour, with no holes.
out.previews = [];
for (const outfit of ['none', ...OUTFITS]) {
  for (const color of ['lilac', 'ember', '#3fa7ff']) {
    const svg = outfitPreview(outfit, color, { badge: outfit === 'witch' });
    out.previews.push({ outfit, color, ok: svg.startsWith('<svg') && !/undefined|NaN|null/.test(svg) });
  }
}
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def result():
    script = HARNESS % {
        "wardrobe": json.dumps((FLAME / "wardrobe.js").as_uri()),
        "palettes": json.dumps((FLAME / "palettes.js").as_uri()),
        "art": json.dumps((PANEL / "wardrobe-art.js").as_uri()),
    }
    done = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30, check=False)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


@pytest.mark.parametrize(
    ("date", "outfit"),
    [
        ("12-31", "party"),
        ("01-01", "party"),
        ("01-02", "party"),
        ("01-03", "scarf"),
        ("12-01", "santa"),
        ("12-26", "santa"),
        ("12-27", "none"),
        ("10-01", "witch"),
        ("10-09", "witch"),
        ("10-31", "witch"),
        ("11-01", "witch"),
        ("11-02", "none"),
        ("03-24", "none"),
        ("03-25", "sakura"),
        ("04-15", "sakura"),
        ("04-16", "none"),
        ("06-30", "none"),
        ("07-01", "kasa"),
        ("08-31", "kasa"),
        ("09-01", "none"),
        ("02-14", "scarf"),
        ("05-10", "none"),
    ],
)
def test_seasonal_outfit(result, date, outfit):
    assert result["seasons"][date] == outfit


def test_unknown_choices_fall_back_to_auto(result):
    assert result["parse"] == ["witch", "auto", "none", "auto", "auto", "auto", "auto", "auto"]


def test_auto_resolves_to_the_season(result):
    assert result["resolve"] == ["witch", "scarf", "santa"]


def test_every_choice_has_a_label(result):
    assert result["labels"]
    assert result["selections"][:2] == ["auto", "none"]
    assert set(result["selections"][2:]) == set(result["outfits"])


def test_palette_keys_accept_names_and_hex_only(result):
    assert result["keys"] == ["lilac", "#abcdef", None, None, None, None, "#000000"]


def test_free_colour_makes_a_whole_palette(result):
    assert result["freeOk"]
    assert result["free"]["accent"] == 0x3FA7FF
    # The tip is lighter than the base.
    def light(c):
        return ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255)

    assert light(result["free"]["high"]) > light(result["free"]["low"])
    assert result["fallback"]


def test_swatches_are_hex_colours(result):
    assert len(result["swatches"]) == 6
    assert all(len(s) == 7 and s.startswith("#") for s in result["swatches"])


def test_every_preview_draws(result):
    assert all(p["ok"] for p in result["previews"]), [p for p in result["previews"] if not p["ok"]]
