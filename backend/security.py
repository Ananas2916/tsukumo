"""Chi puo' parlare con Tsukumo, e come.

Il backend ascolta su 127.0.0.1, ma "solo in locale" non basta: ogni pagina
web aperta nel browser puo' provare a collegarsi a ``ws://127.0.0.1:8770``
(i WebSocket non hanno il CORS) o mandare una POST alla cieca. Con un agente
che esegue comandi senza chiedere, sarebbe come lasciare la tastiera a
qualunque sito. Qui ci sono le difese, dalla piu' esterna:

1. **Host** - con il backend su un indirizzo locale, la richiesta deve dire
   di essere per ``127.0.0.1``/``localhost`` (o un nome scelto in
   ``DC_ALLOWED_HOSTS``). Blocca il DNS rebinding: un dominio che si risolve
   in 127.0.0.1 porta il proprio nome nell'header ``Host``.
2. **Origin** - WebSocket e richieste che cambiano qualcosa (POST, PUT,
   DELETE...) da un browser devono venire dalla stessa origine del backend.
   ``Origin: null`` (iframe in sandbox, file://, data:) non e' mai valido.
   ``Sec-Fetch-Site: cross-site`` viene respinto anche sulle letture.
3. **Token** - chi non e' sul PC (un'altra macchina, un proxy come
   ``tailscale serve``) deve presentare il token di ``state/access_token``,
   e non puo' comunque toccare le impostazioni (``LOCAL_ONLY``).
4. **Header** - CSP, niente iframe, niente sniffing, niente cache delle API.
5. **Limiti** - corpo delle richieste limitato anche senza Content-Length.

I programmi locali senza browser (gli hook di Claude Code, la shell Electron,
curl) non mandano ``Origin`` e girano gia' con i permessi dell'utente: passano.
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

#: Nomi che indicano questo PC.
LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})
#: Header che mette un proxy davanti al backend: la richiesta non e' "dal PC".
PROXY_HEADERS = (
    b"x-forwarded-for",
    b"x-forwarded-host",
    b"x-real-ip",
    b"forwarded",
    b"tailscale-user-login",
    b"tailscale-funnel-request",
)
#: Metodi che leggono soltanto.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
#: Questi percorsi arrivano da un altro sito per costruzione: il ritorno da
#: Spotify dopo il permesso (protetto da ``state`` e PKCE, vedi music.py).
CROSS_SITE_OK = ("/api/music/spotify/callback",)
#: Cosa non si fa da lontano nemmeno col token: motori, programmi da lanciare,
#: hook installati negli agenti, pacchetti pip, voci, preferenze, contesto del PC.
LOCAL_ONLY: tuple[tuple[str, str], ...] = (
    ("POST", "/api/providers"),
    ("POST", "/api/integrations"),
    ("POST", "/api/setup/"),
    ("POST", "/api/voices/"),
    ("DELETE", "/api/voices/"),
    ("POST", "/api/context"),
    ("POST", "/api/notify"),
    ("POST", "/api/preferences"),
    ("POST", "/api/music/"),
    ("PUT", "/api/memory/persona"),
)
#: Dove serve un corpo grande (file, audio, voci da clonare).
UPLOAD_PATHS = ("/api/attachments", "/api/voices/clone", "/api/transcribe")
#: Corpo massimo delle altre richieste (JSON di impostazioni, chat, promemoria).
MAX_JSON_BYTES = 1024 * 1024
#: Il nome del cookie/parametro con cui un client remoto presenta il token.
TOKEN_NAME = "tsukumo_token"
#: Un header Host "normale": finisce dentro la CSP, quindi niente spazi ne' ";".
_PLAIN_HOST = re.compile(r"[A-Za-z0-9.\-]+(?::\d{1,5})?|\[[0-9A-Fa-f:]+\](?::\d{1,5})?")


class BodyTooLarge(HTTPException):
    """Sollevata leggendo il corpo: FastAPI lascia passare le HTTPException."""

    def __init__(self, limit: int) -> None:
        super().__init__(status_code=413, detail=f"Richiesta troppo grande (massimo {limit // 1024} KB)")


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
    """Le regole, separate dal middleware per poterle provare da sole."""

    #: Indirizzo su cui ascolta il backend (``DC_HOST``).
    bind_host: str = "127.0.0.1"
    #: Nomi in piu' accettati nell'header Host (``DC_ALLOWED_HOSTS``).
    extra_hosts: frozenset[str] = frozenset()
    #: Origini in piu' accettate per WebSocket e scritture (``DC_CORS_ORIGINS``).
    extra_origins: frozenset[str] = frozenset()
    #: Dove sta il token per l'accesso da fuori (creato la prima volta che serve).
    token_path: Path | None = None
    _token: str | None = field(default=None, repr=False)

    # ------------------------------------------------------------------
    @classmethod
    def from_settings(cls, settings: Any) -> "AccessPolicy":
        origins = {o.rstrip("/").lower() for o in settings.cors_origins if o.strip() and o.strip() != "*"}
        if "*" in settings.cors_origins:
            logger.warning("DC_CORS_ORIGINS=* ignorato: aprirebbe il backend a qualunque sito web")
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
            # In ascolto su tutte le interfacce (scelta esplicita): da fuori
            # si arriva con l'IP della rete. Chi non e' locale deve comunque
            # avere il token, quindi qui basta.
            return True
        return name == _hostname(self.bind_host)

    def origin_allowed(self, origin: str, host: str) -> bool:
        """Stessa origine del backend, oppure una di quelle permesse a mano."""
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
        """Il segreto per chi si collega da fuori: 256 bit, creato una volta sola."""
        if self._token:
            return self._token
        token = ""
        if self.token_path and self.token_path.is_file():
            try:
                token = self.token_path.read_text(encoding="utf-8").strip()
            except OSError as exc:
                logger.warning("Token di accesso non leggibile: %s", exc)
        if len(token) < 32:
            token = secrets.token_urlsafe(32)
            if self.token_path:
                try:
                    self.token_path.parent.mkdir(parents=True, exist_ok=True)
                    self.token_path.write_text(token, encoding="utf-8")
                    if os.name != "nt":
                        self.token_path.chmod(0o600)
                except OSError as exc:
                    logger.warning("Token di accesso non salvato: %s", exc)
        self._token = token
        return token

    def token_ok(self, provided: str | None) -> bool:
        if not provided:
            return False
        return hmac.compare_digest(provided.encode("utf-8", "replace"), self.token.encode("utf-8"))


def _headers(scope: Scope) -> dict[bytes, str]:
    """Header della richiesta (minuscoli), l'ultimo vince se ripetuto."""
    return {key.lower(): value.decode("latin-1") for key, value in scope.get("headers") or []}


def presented_token(scope: Scope, headers: dict[bytes, str]) -> str | None:
    """Il token da ``Authorization: Bearer``, dal cookie o da ``?tsukumo_token=``."""
    auth = headers.get(b"authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    cookie = headers.get(b"cookie")
    if cookie:
        jar = SimpleCookie()
        try:
            jar.load(cookie)
        except Exception:  # cookie malformato: lo ignoriamo
            jar = SimpleCookie()
        if TOKEN_NAME in jar:
            return jar[TOKEN_NAME].value
    query = parse_qs((scope.get("query_string") or b"").decode("latin-1"))
    values = query.get(TOKEN_NAME)
    return values[0] if values else None


def is_local(scope: Scope, headers: dict[bytes, str]) -> bool:
    """La richiesta parte da questo PC, direttamente, e dice di essere per questo PC."""
    client = scope.get("client")
    if not client or not is_loopback(str(client[0])):
        return False
    if not is_loopback(headers.get(b"host", "")):
        return False
    return not any(name in headers for name in PROXY_HEADERS)


def local_only(method: str, path: str) -> bool:
    return any(method == m and (path == p or (p.endswith("/") and path.startswith(p))) for m, p in LOCAL_ONLY)


def content_security_policy(host: str) -> str:
    """La CSP delle pagine: solo codice nostro, connessioni solo verso di noi.

    Le immagini e i suoni da https restano permessi: copertine di Spotify e
    anteprime delle voci (ElevenLabs) arrivano da li'.
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
    (b"referrer-policy", b"no-referrer"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
    # camera e display-capture: il ritmo della musica ascolta l'audio del desktop
    # con getUserMedia(chromeMediaSource: 'desktop'), che per Chromium e' "camera".
    (b"permissions-policy", b"geolocation=(), payment=(), usb=(), microphone=(self), camera=(self), display-capture=(self)"),
)


class SecurityMiddleware:
    """Applica ``AccessPolicy`` a ogni richiesta HTTP e WebSocket."""

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
            logger.warning("Richiesta respinta (%s): %s %s da %s", reason, method, path, (scope.get("client") or ("?",))[0])
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
            return 421, "host non permesso"
        origin = headers.get(b"origin")
        fetch_site = headers.get(b"sec-fetch-site", "").lower()
        exempt = path in CROSS_SITE_OK
        if sensitive and not exempt:
            if fetch_site == "cross-site" and not (origin and policy.origin_allowed(origin, host)):
                return 403, "richiesta da un altro sito"
            if origin is not None and (method not in SAFE_METHODS or origin == "null"):
                if not policy.origin_allowed(origin, host):
                    return 403, "origine non permessa"
        if not is_local(scope, headers):
            if not policy.token_ok(presented_token(scope, headers)):
                return 401, "serve il token di accesso"
            if local_only(method, path):
                return 403, "si fa solo dal PC"
        return None

    @staticmethod
    async def _reject(kind: str, send: Send, status: int, reason: str) -> None:
        if kind == "websocket":
            # Chiudere prima di accettare = handshake rifiutato (HTTP 403).
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
    """Un valore per il ``.env``: niente a capo ne' caratteri di controllo.

    Un a capo dentro un valore ("modello\\nDC_..._PERMISSION=skip") scriverebbe
    una variabile in piu' nel file: e' il modo piu' semplice per cambiare il
    programma che il companion lancia.
    """
    if any(ord(char) < 32 and char != "\t" or ord(char) == 127 for char in value):
        raise ValueError("Il valore contiene caratteri non permessi (a capo o di controllo)")
    return value.strip()


def within(path: Path, folders: Iterable[Path]) -> bool:
    """``path`` sta dentro una di ``folders`` (dopo aver risolto link e ``..``)."""
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
