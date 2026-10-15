/**
 * "A new version is out": asks GitHub which release is the latest and
 * compares it with the running one. It only tells: downloading and
 * installing stay a click by the user on the release page.
 *
 * GitHub's /releases/latest skips drafts and pre-releases, so a version is
 * announced only once it's really published. A build with a suffix ("3.1.1-dev")
 * compares by its numbers alone, so it isn't told about its own public twin.
 */

const REPO = 'Ananas2916/tsukumo';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Only pages of this repository's releases are ever opened from a reply. */
const RELEASES_PAGE = `https://github.com/${REPO}/releases/`;

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
  };
}

module.exports = { checkForUpdate, isNewer, parseVersion, RELEASES_PAGE };
