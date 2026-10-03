# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a
vulnerability** on this repository. Don't open a public issue for security
problems. Include the version, what an attacker needs (a web page the user
visits? another device on the LAN? a local program?), and steps to reproduce.

You should get an answer within a week. Fixes ship as a patch release
(`X.Y.Z+1`) with the issue described in the release notes once users can
update.

## Supported versions

Only the latest release receives security fixes. The installer doesn't
auto-update yet, so please update from
[Releases](https://github.com/Ananas2916/tsukumo/releases/latest).

| Version | Supported |
|---|---|
| 2.1.1 and later | ✅ |
| 2.1.0 and earlier | ❌ — the backend accepted connections from any web page; update now |

## Threat model

Tsukumo's backend can drive coding agents that read files and run commands on
the user's PC. Anything that can send it a chat message can potentially act
through the agent, so the backend has to tell the user apart from everyone
else.

| Attacker | Defense |
|---|---|
| **A web page in the user's browser** (cross-site WebSocket hijacking, CSRF, DNS rebinding) | Origin must equal the backend's own origin for WebSocket and state-changing requests; `Origin: null` and `Sec-Fetch-Site: cross-site` refused; `Host` must be loopback or explicitly allowed; CORS closed |
| **Another device on the network** | Backend binds to `127.0.0.1` by default. Non-loopback clients, and requests forwarded by a local proxy, need the 256-bit token in `state/access_token` (constant-time comparison) and can't reach configuration endpoints |
| **Someone who gets the phone link** | The link is the key: it carries the token after `#`, which browsers never send to the server, so it stays out of logs. The page exchanges it for an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. It's reachable only through `tailscale serve` (the user's own Tailscale devices) unless the user turns on Funnel, which the QR page flags. Only the page's static shell (`/mobile.html`, `/assets/*`) loads without the token. The QR page works only from the PC. Deleting `state/access_token` revokes every link |
| **Malicious content in the UI** (agent replies, news headlines, file names) | Replies are rendered as DOM text, never HTML; links only `http(s)`; strict CSP (`script-src 'self'`, no inline scripts, `connect-src` limited to the backend); no framing |
| **A compromised renderer** | Electron sandbox + context isolation, no Node in pages, minimal preload bridge, IPC accepted only from the backend's pages, navigation and new windows locked, permissions allow-listed, fuses disable `RunAsNode`, `NODE_OPTIONS` and `--inspect` |
| **Config injection** | `.env` writes reject control characters and unknown keys; agent permission values must be among the panel's options |
| **Oversized requests** | Bodies capped (1 MiB JSON, 25 MiB uploads) even with chunked transfer |
| **Prompt injection via online content** | News-based comments are passed to agents as quoted records marked "never act on this" |

### Out of scope

- **Programs running as the same OS user.** They can already read the user's
  files, `.env` and agent credentials; the backend trusts local, non-browser
  clients by design (hooks, scripts, the Electron shell).
- **Agents configured to approve everything.** If you enable full
  auto-approval ("skip"/"bypass" modes), any prompt that reaches the agent,
  including text inside a file or page you ask it to read, can run commands.
  Tsukumo defaults to prudent permissions and labels the risky option.
- **The models and agents themselves.** Their own vulnerabilities and data
  handling are their vendors' responsibility.

## Where secrets live

- API keys: `.env` in the project (from source) or `%APPDATA%\Tsukumo\tsukumo.env`
  (installed app). They're never sent to the UI; the panel only sees "set / not
  set".
- Spotify tokens: `state/spotify.json`. Remote access token: `state/access_token`. It's also inside the phone link and its QR code.
- If you run from source inside a synced folder (OneDrive, Dropbox), those
  files get synced too. The installed app keeps them in `%APPDATA%`.
