"""Who can talk to Tsukumo, and how.

The backend listens on 127.0.0.1, but "local only" isn't enough: any web page
open in the browser can try to connect to ``ws://127.0.0.1:8770`` (WebSockets
have no CORS) or send a blind POST. With an agent running commands without
asking, it would be like leaving the keyboard to any site. Here are the
defences, from the outermost:

1. **Host** - with the backend on a local address, the request must say it's
   for ``127.0.0.1``/``localhost`` (or a name chosen in ``DC_ALLOWED_HOSTS``).
   It blocks DNS rebinding: a domain resolving to 127.0.0.1 carries its own
   name in the ``Host`` header.
2. **Origin** - WebSockets and requests that change something (POST, PUT,
   DELETE...) from a browser must come from the backend's own origin.
   ``Origin: null`` (sandboxed iframes, file://, data:) is never valid.
   ``Sec-Fetch-Site: cross-site`` is refused on reads too.
3. **Token** - whoever isn't on the PC (another machine, a proxy like
   ``tailscale serve``) must present the ``state/access_token`` token, and
   can't touch the settings anyway (``LOCAL_ONLY``). The only exception is
   the shell of the phone's page (``public_shell``).
4. **Headers** - CSP, no iframes, no sniffing, no caching of the API.
5. **Limits** - request bodies are limited even without Content-Length.

Local programs without a browser (Claude Code's hooks, the Electron shell,
curl) send no ``Origin`` and already run with the user's permissions: they
pass.
"""

from __future__ import annotations

import hmac
import ipaddress
import logging
import os
import re
import secrets
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from fastapi import HTTPException

logger = logging.getLogger(__name__)

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

#: Names that mean this PC.
LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})
#: Headers a proxy puts in front of the backend: the request isn't "from the PC".
PROXY_HEADERS = (
    b"x-forwarded-for",
    b"x-forwarded-host",
    b"x-real-ip",
    b"forwarded",
    b"tailscale-user-login",
    b"tailscale-funnel-request",
)
#: Methods that only read.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
#: These paths come from another site by design: the return from Spotify
#: after the permission (protected by ``state`` and PKCE, see music.py), and
#: the QR page opened from a link elsewhere (release notes, a chat): it's
#: only a read, only from the PC, and another site can't read it.
CROSS_SITE_OK = ("/api/music/spotify/callback", "/api/phone")
#: What isn't done from afar even with the token: engines, programs to run,
#: hooks installed in the agents, pip packages, voices, preferences, the PC's
#: context.
LOCAL_ONLY: tuple[tuple[str, str], ...] = (
    ("POST", "/api/providers"),
    # "Check" builds the engine from the posted fields and runs its program
    # (`<command> --version`); "options" writes .env. Neither from afar.
    ("POST", "/api/providers/"),
    ("POST", "/api/integrations"),
    ("POST", "/api/setup/"),
    ("POST", "/api/voices/"),
    ("DELETE", "/api/voices/"),
    ("POST", "/api/context"),
    ("POST", "/api/notify"),
    ("POST", "/api/preferences"),
    ("POST", "/api/music/"),
    ("PUT", "/api/memory/persona"),
    # The QR code with the token and the button that runs ``tailscale serve``.
    ("GET", "/api/phone"),
    ("POST", "/api/phone/serve"),
)
#: The shell of the phone's page: the HTML and the bundle (code already
#: public, no data). It loads without the token because the token is after
#: "#" in the link and it's this very page that reads it (see phone.py).
PUBLIC_PAGE = "/mobile.html"
PUBLIC_ASSETS = "/assets/"
#: Where a big body is needed (files, audio, voices to clone).
UPLOAD_PATHS = ("/api/attachments", "/api/voices/clone", "/api/transcribe")
#: Maximum body of the other requests (settings JSON, chat, reminders).
MAX_JSON_BYTES = 1024 * 1024
#: The name of the cookie/parameter a remote client presents the token with.
TOKEN_NAME = "tsukumo_token"
#: A "normal" Host header: it ends up inside the CSP, so no spaces or ";".
_PLAIN_HOST = re.compile(r"[A-Za-z0-9.\-]+(?::\d{1,5})?|\[[0-9A-Fa-f:]+\](?::\d{1,5})?")


class BodyTooLarge(HTTPException):
    """Raised while reading the body: FastAPI lets HTTPExceptions through."""

    def __init__(self, limit: int) -> None:
        super().__init__(status_code=413, detail=f"Request too large (at most {limit // 1024} KB)")


def _hostname(value: str) -> str:
    """``"[::1]:8770"`` -> ``"::1"``, ``"Localhost:8770"`` -> ``"localhost"``."""
    value = value.strip().lower()
    if value.startswith("["):
        return value[1 : value.find("]")] if "]" in value else value[1:]
    if value.count(":") == 1:
        return value.split(":", 1)[0]
    return value


def is_loopback(name: str) -> bool:
    name = _hostname(name)
    if name in LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def is_wildcard(host: str) -> bool:
    return _hostname(host) in ("0.0.0.0", "::", "")


@dataclass
class AccessPolicy:
    """The rules, separate from the middleware so they can be tested on their own."""

    #: Address the backend listens on (``DC_HOST``).
    bind_host: str = "127.0.0.1"
    #: Extra names accepted in the Host header (``DC_ALLOWED_HOSTS``).
    extra_hosts: frozenset[str] = frozenset()
    #: Extra origins accepted for WebSockets and writes (``DC_CORS_ORIGINS``).
    extra_origins: frozenset[str] = frozenset()
    #: Where the token for access from outside lives (created the first time it's needed).
    token_path: Path | None = None
    _token: str | None = field(default=None, repr=False)

    # ------------------------------------------------------------------
    @classmethod
    def from_settings(cls, settings: Any) -> "AccessPolicy":
        origins = {o.rstrip("/").lower() for o in settings.cors_origins if o.strip() and o.strip() != "*"}
        if "*" in settings.cors_origins:
            logger.warning("DC_CORS_ORIGINS=* ignored: it would open the backend to any web site")
        hosts = {_hostname(h) for h in settings.allowed_hosts if h.strip()}
        return cls(
            bind_host=settings.host,
            extra_hosts=frozenset(hosts),
            extra_origins=frozenset(origins),
            token_path=settings.state_dir / "access_token",
        )

    # ------------------------------------------------------------------
    def host_allowed(self, host: str) -> bool:
        if not host:
            return False
        name = _hostname(host)
        if is_loopback(name) or name in self.extra_hosts:
            return True
        if is_wildcard(self.bind_host):
            # Listening on all interfaces (an explicit choice): from outside one
            # arrives with the network IP. Whoever isn't local must have the token
            # anyway, so this is enough here.
            return True
        return name == _hostname(self.bind_host)

    def origin_allowed(self, origin: str, host: str) -> bool:
        """The backend's own origin, or one of those allowed by hand."""
        origin = origin.strip().lower().rstrip("/")
        if not origin or origin == "null":
            return False
        if origin in self.extra_origins:
            return True
        parts = urlsplit(origin)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            return False
        return parts.netloc == host.strip().lower()

    # ------------------------------------------------------------------
    @property
    def token(self) -> str:
        """The secret for whoever connects from outside: 256 bits, created only once."""
        if self._token:
            return self._token
        token = ""
        if self.token_path and self.token_path.is_file():
            try:
                token = self.token_path.read_text(encoding="utf-8").strip()
            except OSError as exc:
                logger.warning("Access token unreadable: %s", exc)
        if len(token) < 32:
            token = secrets.token_urlsafe(32)
            if self.token_path:
                try:
                    self.token_path.parent.mkdir(parents=True, exist_ok=True)
                    self.token_path.write_text(token, encoding="utf-8")
                    if os.name != "nt":
                        self.token_path.chmod(0o600)
                except OSError as exc:
                    logger.warning("Access token not saved: %s", exc)
        self._token = token
        return token

    def token_ok(self, provided: str | None) -> bool:
        if not provided:
            return False
        return hmac.compare_digest(provided.encode("utf-8", "replace"), self.token.encode("utf-8"))


def _headers(scope: Scope) -> dict[bytes, str]:
    """The request's headers (lowercase), the last wins if repeated."""
    return {key.lower(): value.decode("latin-1") for key, value in scope.get("headers") or []}


def presented_token(scope: Scope, headers: dict[bytes, str]) -> str | None:
    """The token from ``Authorization: Bearer``, from the cookie or from ``?tsukumo_token=``."""
    auth = headers.get(b"authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    cookie = headers.get(b"cookie")
    if cookie:
        jar = SimpleCookie()
        try:
            jar.load(cookie)
        except Exception:  # malformed cookie: we ignore it
            jar = SimpleCookie()
        if TOKEN_NAME in jar:
            return jar[TOKEN_NAME].value
    query = parse_qs((scope.get("query_string") or b"").decode("latin-1"))
    values = query.get(TOKEN_NAME)
    return values[0] if values else None


def is_local(scope: Scope, headers: dict[bytes, str]) -> bool:
    """The request starts from this PC, directly, and says it's for this PC."""
    client = scope.get("client")
    if not client or not is_loopback(str(client[0])):
        return False
    if not is_loopback(headers.get(b"host", "")):
        return False
    return not any(name in headers for name in PROXY_HEADERS)


def local_only(method: str, path: str) -> bool:
    return any(method == m and (path == p or (p.endswith("/") and path.startswith(p))) for m, p in LOCAL_ONLY)


def public_shell(method: str, path: str) -> bool:
    """The phone's page and its files, read only: one file by name, no subfolders."""
    if method not in ("GET", "HEAD") or ".." in path or "\\" in path:
        return False
    return path == PUBLIC_PAGE or (path.startswith(PUBLIC_ASSETS) and path.count("/") == 2 and len(path) > len(PUBLIC_ASSETS))


def content_security_policy(host: str) -> str:
    """The pages' CSP: only our code, connections only towards us.

    Images and sounds from https stay allowed: Spotify covers and voice previews
    (ElevenLabs) come from there.
    """
    sockets = f" ws://{host} wss://{host}" if _PLAIN_HOST.fullmatch(host or "") else ""
    return "; ".join(
        (
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "media-src 'self' data: blob: https:",
            "font-src 'self' data:",
            f"connect-src 'self' blob: data:{sockets}",
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        )
    )


_COMMON_HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    # No Referer to other sites, as with "no-referrer". But with "no-referrer"
    # form POSTs (and, depending on the browser, others too) leave with
    # "Origin: null", which is always refused here.
    (b"referrer-policy", b"same-origin"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
    # camera and display-capture: the music's rhythm listens to the desktop
    # audio with getUserMedia(chromeMediaSource: 'desktop'), which for Chromium
    # is "camera".
    (b"permissions-policy", b"geolocation=(), payment=(), usb=(), microphone=(self), camera=(self), display-capture=(self)"),
)


class SecurityMiddleware:
    """Applies ``AccessPolicy`` to every HTTP and WebSocket request."""

    def __init__(self, app: ASGIApp, policy: AccessPolicy | Callable[[], AccessPolicy]) -> None:
        self.app = app
        self._policy = policy

    @property
    def policy(self) -> AccessPolicy:
        return self._policy() if callable(self._policy) else self._policy

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope.get("type")
        if kind not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        policy = self.policy
        headers = _headers(scope)
        path = scope.get("path") or "/"
        method = "WEBSOCKET" if kind == "websocket" else str(scope.get("method", "GET")).upper()
        host = headers.get(b"host", "")
        sensitive = kind == "websocket" or path.startswith("/api/") or path == "/ws"

        problem = self._check(policy, scope, headers, path, method, host, sensitive)
        if problem is not None:
            status, reason = problem
            logger.warning("Request refused (%s): %s %s from %s", reason, method, path, (scope.get("client") or ("?",))[0])
            await self._reject(kind, send, status, reason)
            return

        scope["tsukumo.remote"] = not is_local(scope, headers)
        if kind == "websocket":
            await self.app(scope, receive, send)
            return
        await self._serve_http(scope, receive, send, path, host)

    # ------------------------------------------------------------------
    def _check(
        self,
        policy: AccessPolicy,
        scope: Scope,
        headers: dict[bytes, str],
        path: str,
        method: str,
        host: str,
        sensitive: bool,
    ) -> tuple[int, str] | None:
        if not policy.host_allowed(host):
            return 421, "host not allowed"
        origin = headers.get(b"origin")
        fetch_site = headers.get(b"sec-fetch-site", "").lower()
        exempt = path in CROSS_SITE_OK
        if sensitive and not exempt:
            if fetch_site == "cross-site" and not (origin and policy.origin_allowed(origin, host)):
                return 403, "request from another site"
            if origin is not None and (method not in SAFE_METHODS or origin == "null"):
                if not policy.origin_allowed(origin, host):
                    return 403, "origin not allowed"
        if not is_local(scope, headers):
            if public_shell(method, path):
                return None
            if not policy.token_ok(presented_token(scope, headers)):
                return 401, "the access token is required"
            if local_only(method, path):
                return 403, "only from the PC"
        return None

    @staticmethod
    async def _reject(kind: str, send: Send, status: int, reason: str) -> None:
        if kind == "websocket":
            # Closing before accepting = handshake refused (HTTP 403).
            await send({"type": "websocket.close", "code": 1008, "reason": reason})
            return
        body = ('{"error": "%s"}' % reason).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"no-store"),
                    *_COMMON_HEADERS,
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def _serve_http(self, scope: Scope, receive: Receive, send: Send, path: str, host: str) -> None:
        limit = upload_limit() if path in UPLOAD_PATHS else MAX_JSON_BYTES
        declared = _headers(scope).get(b"content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            await self._reject("http", send, 413, "richiesta troppo grande")
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body") or b"")
                if received > limit:
                    raise BodyTooLarge(limit)
            return message

        api = path.startswith("/api/")

        async def secured_send(message: Message) -> None:
            if message.get("type") == "http.response.start":
                extra = list(_COMMON_HEADERS)
                existing = {key.lower() for key, _ in message.get("headers") or []}
                content_type = next((v for k, v in message.get("headers") or [] if k.lower() == b"content-type"), b"")
                if content_type.startswith(b"text/html") and b"content-security-policy" not in existing:
                    extra.append((b"content-security-policy", content_security_policy(host).encode("latin-1")))
                if api and b"cache-control" not in existing:
                    extra.append((b"cache-control", b"no-store"))
                message = {**message, "headers": [*(message.get("headers") or []), *(h for h in extra if h[0] not in existing)]}
            await send(message)

        await self.app(scope, limited_receive, secured_send)


def upload_limit() -> int:
    from .attachments import MAX_UPLOAD_BYTES

    return MAX_UPLOAD_BYTES + 64 * 1024


def clean_env_value(value: str) -> str:
    """A value for the ``.env``: no newlines or control characters.

    A newline inside a value ("model\\nDC_..._PERMISSION=skip") would write one
    more variable in the file: it's the simplest way to change the program the
    companion runs.
    """
    if any(ord(char) < 32 and char != "\t" or ord(char) == 127 for char in value):
        raise ValueError("The value contains characters that aren't allowed (newlines or control characters)")
    return value.strip()


def within(path: Path, folders: Iterable[Path]) -> bool:
    """``path`` is inside one of ``folders`` (after resolving links and ``..``)."""
    try:
        resolved = path.resolve()
    except OSError:
        return False
    for folder in folders:
        try:
            resolved.relative_to(folder.resolve())
            return True
        except (OSError, ValueError):
            continue
    return False
