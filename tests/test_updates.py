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
    assert out["found"] == {"version": "3.1.1", "url": "https://github.com/Ananas2916/tsukumo/releases/tag/v3.1.1", "installer": None}
    # A suffixed build isn't told about its own public twin, and pre-releases wait.
    assert out["same"] is None and out["prerelease"] is None
    # A reply can only ever send the user to this repository's releases.
    assert out["foreign"]["url"] == "https://github.com/Ananas2916/tsukumo/releases/latest"
    assert out["error"] == "GitHub answered 403"


INSTALLER_HARNESS = """
const updates = require(%(module)s);
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const DL = 'https://github.com/Ananas2916/tsukumo/releases/download/v3.4.0/';
const body = Buffer.from('MZ fake installer bytes '.repeat(1000));
const sha = crypto.createHash('sha256').update(body).digest('hex');
const asset = (extra) => ({ name: 'Tsukumo.Setup.3.4.0.exe', size: body.length, digest: 'sha256:' + sha, browser_download_url: DL + 'Tsukumo.Setup.3.4.0.exe', ...extra });
const release = (assets) => ({ tag_name: 'v3.4.0', html_url: 'https://github.com/Ananas2916/tsukumo/releases/tag/v3.4.0', assets });
const stream = (bytes) => new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 4096) c.enqueue(bytes.subarray(i, i + 4096)); c.close(); } });
const serve = (bytes) => async (url) => ({ ok: true, status: 200, url, body: stream(bytes) });
(async () => {
  const out = {};
  out.good = updates.installerOf(release([{ name: 'notes.txt' }, asset()]), '3.4.0');
  out.spaced = Boolean(updates.installerOf(release([asset({ name: 'Tsukumo Setup 3.4.0.exe' })]), '3.4.0'));
  out.foreign = updates.installerOf(release([asset({ browser_download_url: 'https://evil.example/Tsukumo.Setup.3.4.0.exe' })]), '3.4.0');
  out.noDigest = updates.installerOf(release([asset({ digest: null })]), '3.4.0');
  out.otherVersion = updates.installerOf(release([asset({ name: 'Tsukumo.Setup.3.3.0.exe' })]), '3.4.0');
  out.blockmap = updates.installerOf(release([asset({ name: 'Tsukumo.Setup.3.4.0.exe.blockmap' })]), '3.4.0');
  out.self = ['3.4.0', '3.4.0-privato', '3.4.0-dev', 'x'].map(updates.selfUpdatable);
  const found = await updates.checkForUpdate('3.3.0', { fetchImpl: async () => ({ ok: true, json: async () => release([asset()]) }) });
  out.checked = Boolean(found.installer);
  const folder = path.join(%(folder)s);
  const progress = [];
  const file = await updates.downloadInstaller(found, folder, { fetchImpl: serve(body), onProgress: (f) => progress.push(f) });
  out.file = path.basename(file);
  out.same = fs.readFileSync(file).equals(body);
  out.progress = [progress.length > 1, progress[progress.length - 1]];
  const tampered = Buffer.from(body); tampered[10] ^= 1;
  for (const [name, bytes] of [['tampered', tampered], ['short', body.subarray(0, 100)], ['long', Buffer.concat([body, body])]]) {
    fs.rmSync(file, { force: true });
    try { await updates.downloadInstaller(found, folder, { fetchImpl: serve(bytes) }); out[name] = 'downloaded'; }
    catch (error) { out[name] = error.message; }
  }
  out.leftovers = fs.readdirSync(folder);
  try { await updates.downloadInstaller({ version: '3.4.0', installer: { url: 'https://evil.example/x.exe', size: 1, sha256: sha } }, folder, { fetchImpl: serve(body) }); out.evil = 'downloaded'; }
  catch (error) { out.evil = error.message; }
  console.log(JSON.stringify(out));
})();
"""


@needs_node
def test_installer_is_picked_downloaded_and_checked(tmp_path):
    script = INSTALLER_HARNESS % {"module": json.dumps(str(ELECTRON / "updates.js")), "folder": json.dumps(str(tmp_path / "update"))}
    result = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=60, check=True)
    out = json.loads(result.stdout)
    # Only this version's installer, from this repository, with its SHA-256.
    assert out["good"]["url"].startswith("https://github.com/Ananas2916/tsukumo/releases/download/") and len(out["good"]["sha256"]) == 64
    assert out["spaced"] and out["checked"]
    assert out["foreign"] is None and out["noDigest"] is None and out["otherVersion"] is None and out["blockmap"] is None
    # A build with a suffix is someone's own: it's only told.
    assert out["self"] == [True, False, False, False]
    assert out["file"] == "Tsukumo-Setup-3.4.0.exe" and out["same"] and out["progress"] == [True, 1]
    # A file that doesn't match is never left to run.
    assert out["tampered"] == "The download doesn't match the release"
    assert out["short"] == "The download is incomplete"
    assert out["long"] == "The download is bigger than announced"
    assert out["leftovers"] == [] and out["evil"] == "Not a Tsukumo installer"


def test_installer_packs_every_local_module():
    """electron-builder's `files` is an allowlist: a local require left out crashes the installed app at launch."""
    packed = set(json.loads((ELECTRON / "package.json").read_text(encoding="utf-8"))["build"]["files"])
    for source in ("main.js", *(name for name in packed if name.endswith(".js"))):
        text = (ELECTRON / source).read_text(encoding="utf-8")
        for module in re.findall(r"require\('\./([\w-]+)'\)", text):
            assert f"{module}.js" in packed, f"{source} requires ./{module} but the installer leaves it out"
