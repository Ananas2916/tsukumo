"""frontend/src/news.js: what's new after an update, in the interface's and the voice's language."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
NEWS = ROOT / "frontend" / "src" / "news.js"

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="needs node")

HARNESS = """
const { NEWS, newsBetween } = await import(%(module)s);
console.log(JSON.stringify({
  versions: NEWS.map((entry) => entry.version),
  shapes: NEWS.map((entry) => [entry.en.length, entry.it.length, Boolean(entry.say.en && entry.say.it)]),
  one: newsBetween('3.3.0', '3.3.1', 'it', 'en'),
  two: newsBetween('3.2.0', '3.3.1-privato', 'en', 'it', 6),
  unknown: newsBetween(null, '3.3.0', 'en', 'en'),
  none: newsBetween('3.3.1', '3.3.1', 'en', 'en'),
  bad: newsBetween('3.3.0', 'nope', 'en', 'en'),
}));
"""


@needs_node
def test_news_between_versions():
    script = HARNESS % {"module": json.dumps(NEWS.as_uri())}
    result = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30, check=True)
    out = json.loads(result.stdout)
    # Newest first, every version in both languages.
    assert out["versions"] == sorted(out["versions"], key=lambda v: [int(n) for n in v.split(".")], reverse=True)
    assert all(en == it and en > 0 and said for en, it, said in out["shapes"])
    # The card in the interface's language, the sentence in the voice's.
    assert out["one"]["lines"][0].startswith("Quando esce una versione nuova") and out["one"]["say"].startswith("Here I am, I'm version 3.3.1")
    # Skipping versions: the newest's lines first, the suffix doesn't count.
    assert len(out["two"]["lines"]) == 6 and out["two"]["lines"][3].startswith("Ask me") and "3.3.1" in out["two"]["say"]
    assert out["unknown"]["lines"][0].startswith("Ask me")
    assert out["none"] is None and out["bad"] is None
