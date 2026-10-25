/**
 * "A new version is out": asks GitHub which release is the latest and
 * compares it with the running one. The public build can then install it by
 * itself (one click on the lantern beside her): the installer is downloaded
 * from this repository's release only, checked against the SHA-256 GitHub
 * publishes for it, and run silently. A build with a suffix ("3.3.0-privato")
 * is someone's own: it's only told, since the public installer would
 * replace it.
 *
 * GitHub's /releases/latest skips drafts and pre-releases, so a version is
 * announced only once it's really published. A build with a suffix compares
 * by its numbers alone, so it isn't told about its own public twin.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'Ananas2916/tsukumo';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Only pages of this repository's releases are ever opened from a reply. */
const RELEASES_PAGE = `https://github.com/${REPO}/releases/`;
/** And only its release files are ever downloaded. */
const DOWNLOADS = `https://github.com/${REPO}/releases/download/`;

/** "v3.1.1", "3.1.1-dev" -> [3, 1, 1]; null when it isn't a version. */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** True when `remote` is a higher version than `local` (suffixes ignored). */
function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Only a plain public build installs updates by itself; "3.3.0-privato" is just told. */
function selfUpdatable(current) {
  return /^\d+\.\d+\.\d+$/.test(String(current ?? ''));
}

/**
 * The release's Windows installer, if it's there as expected: named for the
 * version, served from this repository, with its size and its SHA-256.
 */
function installerOf(release, version) {
  const expected = `Setup.${version}.exe`;
  const asset = (release?.assets ?? []).find((item) => {
    const name = String(item?.name ?? '').replace(/ /g, '.');
    return name === `Tsukumo.${expected}`;
  });
  const url = String(asset?.browser_download_url ?? '');
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest ?? ''))?.[1]?.toLowerCase();
  const size = Number(asset?.size);
  if (!asset || !url.startsWith(DOWNLOADS) || !sha256 || !Number.isSafeInteger(size) || size <= 0) return null;
  return { url, size, sha256 };
}

/**
 * The latest published release, or null when it's not newer than `current`.
 * Throws on network errors: the caller just tries again later.
 */
async function checkForUpdate(current, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const response = await fetchImpl(LATEST_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Tsukumo/${current}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = await response.json();
  if (release?.draft || release?.prerelease) return null;
  const version = String(release?.tag_name ?? '').replace(/^v/, '');
  if (!isNewer(version, current)) return null;
  const page = String(release?.html_url ?? '');
  return {
    version,
    url: page.startsWith(RELEASES_PAGE) ? page : `${RELEASES_PAGE}latest`,
    installer: parseVersion(version) ? installerOf(release, version) : null,
  };
}

/**
 * Downloads the installer into `folder` and checks it: the size first, then
 * the SHA-256 GitHub published. A file that doesn't match is deleted, never run.
 *
 * @param {{version: string, installer: {url: string, size: number, sha256: string}}} update
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Promise<string>} the installer's path
 */
async function downloadInstaller(update, folder, { fetchImpl = fetch, onProgress = () => {}, timeoutMs = 20 * 60_000 } = {}) {
  const { installer, version } = update ?? {};
  if (!installer?.url?.startsWith(DOWNLOADS) || !parseVersion(version)) throw new Error('Not a Tsukumo installer');
  const response = await fetchImpl(installer.url, {
    headers: { 'User-Agent': 'Tsukumo' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) throw new Error(`GitHub answered ${response.status}`);
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, `Tsukumo-Setup-${parseVersion(version).join('.')}.exe`);
  const partial = `${target}.part`;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(partial);
  const done = new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  // A failure is handled below: this promise only mustn't go unheard when it's abandoned.
  done.catch(() => {});
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > installer.size) throw new Error('The download is bigger than announced');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress(received / installer.size);
    }
    out.end();
    await done;
    if (received !== installer.size) throw new Error('The download is incomplete');
    if (hash.digest('hex') !== installer.sha256) throw new Error("The download doesn't match the release");
    fs.renameSync(partial, target);
  } catch (error) {
    out.destroy();
    if (!out.closed) await new Promise((resolve) => out.once('close', resolve));
    fs.rmSync(partial, { force: true });
    throw error;
  }
  return target;
}

module.exports = { checkForUpdate, downloadInstaller, installerOf, isNewer, parseVersion, selfUpdatable, RELEASES_PAGE };
