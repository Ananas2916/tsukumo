"""electron/updates.js (new-version notices) and the files the installer packs."""

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ELECTRON = ROOT / "electron"

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="needs node")

HARNESS = """
const updates = require(%(module)s);
const reply = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 403, json: async () => body });
(async () => {
  const out = {};
  out.newer = %(pairs)s.map(([remote, local]) => updates.isNewer(remote, local));
  out.found = await updates.checkForUpdate('3.1.0', { fetchImpl: reply({
    tag_name: 'v3.1.1', html_url: 'https://github.com/Ananas2916/tsukumo/releases/tag/v3.1.1' }) });
  out.same = await updates.checkForUpdate('3.1.1-dev', { fetchImpl: reply({ tag_name: 'v3.1.1' }) });
  out.prerelease = await updates.checkForUpdate('3.1.0', { fetchImpl: reply({ tag_name: 'v4.0.0', prerelease: true }) });
  out.foreign = await updates.checkForUpdate('3.1.0', { fetchImpl: reply({
    tag_name: 'v3.2.0', html_url: 'https://example.com/fake-release' }) });
  try { await updates.checkForUpdate('3.1.0', { fetchImpl: reply({}, false) }); out.error = null; }
  catch (error) { out.error = error.message; }
  console.log(JSON.stringify(out));
})();
"""

PAIRS = [
    ("3.1.1", "3.1.0", True),
    ("v3.2.0", "3.1.9", True),
    ("3.10.0", "3.9.0", True),
    ("4.0.0", "3.99.99", True),
    ("3.1.1", "3.1.1-dev", False),
    ("3.1.0", "3.1.1", False),
    ("3.1.1", "3.1.1", False),
    ("not a version", "3.1.0", False),
    ("", "3.1.0", False),
]


@needs_node
def test_update_check():
    script = HARNESS % {
        "module": json.dumps(str(ELECTRON / "updates.js")),
        "pairs": json.dumps([[remote, local] for remote, local, _ in PAIRS]),
    }
    result = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=30, check=True)
    out = json.loads(result.stdout)
    assert out["newer"] == [expected for *_, expected in PAIRS]
    assert out["found"] == {"version": "3.1.1", "url": "https://github.com/Ananas2916/tsukumo/releases/tag/v3.1.1"}
    # A suffixed build isn't told about its own public twin, and pre-releases wait.
    assert out["same"] is None and out["prerelease"] is None
    # A reply can only ever send the user to this repository's releases.
    assert out["foreign"]["url"] == "https://github.com/Ananas2916/tsukumo/releases/latest"
    assert out["error"] == "GitHub answered 403"


def test_installer_packs_every_local_module():
    """electron-builder's `files` is an allowlist: a local require left out crashes the installed app at launch."""
    packed = set(json.loads((ELECTRON / "package.json").read_text(encoding="utf-8"))["build"]["files"])
    for source in ("main.js", *(name for name in packed if name.endswith(".js"))):
        text = (ELECTRON / source).read_text(encoding="utf-8")
        for module in re.findall(r"require\('\./([\w-]+)'\)", text):
            assert f"{module}.js" in packed, f"{source} requires ./{module} but the installer leaves it out"
