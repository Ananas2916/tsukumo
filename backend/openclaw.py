"""Monitor di connessione al Gateway OpenClaw.

Il Gateway espone tre coppie di probe HTTP **non autenticate**:

* ``/health``   - il server HTTP e' vivo;
* ``/startupz`` - l'avvio e' completo e non sta andando in drain;
* ``/readyz``   - come sopra, ma verifica anche i canali configurati.

Qui interroghiamo ``/health`` per la spia verde/rossa e, quando il Gateway
risponde, anche ``/readyz`` per distinguere "acceso ma con un canale in
errore" (giallo) da "tutto a posto" (verde).

Il polling gira in un task di background e avvisa solo quando lo stato
*cambia*, cosi' il frontend non riceve un messaggio ogni pochi secondi.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

logger = logging.getLogger(__name__)

#: Callback invocata quando lo stato cambia.
OnChange = Callable[[dict[str, Any]], Awaitable[None]]

#: I tre stati possibili della spia.
OFFLINE = "offline"  # rosso: il Gateway non risponde
DEGRADED = "degraded"  # giallo: risponde ma non e' pronto
ONLINE = "online"  # verde: raggiungibile e pronto


class OpenClawMonitor:
    """Sonda periodicamente il Gateway OpenClaw."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:18789",
        interval: float = 5.0,
        timeout: float = 3.0,
        on_change: OnChange | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.interval = max(1.0, interval)
        self.on_change = on_change
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=timeout))
        self._task: asyncio.Task | None = None
        self._state = OFFLINE
        self._detail: dict[str, Any] = {}
        self._error: str | None = "Nessun controllo ancora eseguito"
        self._checked_at: float | None = None

    # ------------------------------------------------------------------
    @property
    def status(self) -> dict[str, Any]:
        """Istantanea pronta da spedire al frontend."""
        return {
            "type": "openclaw",
            "state": self._state,
            # `connected` e' la spia verde/rossa vera e propria: giallo conta
            # comunque come connesso, perche' il Gateway sta rispondendo.
            "connected": self._state != OFFLINE,
            "url": self.base_url,
            "error": self._error,
            "checkedAt": self._checked_at,
            **self._detail,
        }

    # ------------------------------------------------------------------
    async def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._loop(), name="openclaw-monitor")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self._client.aclose()

    # ------------------------------------------------------------------
    async def _loop(self) -> None:
        logger.info("Monitoraggio OpenClaw su %s ogni %.0fs", self.base_url, self.interval)
        while True:
            try:
                await self.check()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - il monitor non deve mai morire
                logger.exception("Controllo OpenClaw fallito in modo imprevisto")
            await asyncio.sleep(self.interval)

    async def check(self) -> dict[str, Any]:
        """Esegue un controllo e notifica se lo stato e' cambiato."""
        previous = self._state
        state, detail, error = await self._probe()

        self._state = state
        self._detail = detail
        self._error = error
        self._checked_at = time.time()

        if state != previous:
            logger.info(
                "OpenClaw: %s -> %s%s", previous, state, f" ({error})" if error else ""
            )
            if self.on_change is not None:
                await self.on_change(self.status)
        return self.status

    # ------------------------------------------------------------------
    async def _probe(self) -> tuple[str, dict[str, Any], str | None]:
        try:
            health = await self._client.get(f"{self.base_url}/health")
        except httpx.RequestError as exc:
            # Gateway spento: e' il caso normale, non un errore da stack trace.
            return OFFLINE, {}, _short_error(exc)

        if health.status_code >= 400:
            return OFFLINE, {}, f"HTTP {health.status_code} su /health"

        detail = _json_fields(health, ("version", "uptimeMs", "status"))

        # Il Gateway risponde: chiediamo anche se e' davvero pronto.
        try:
            ready = await self._client.get(f"{self.base_url}/readyz")
        except httpx.RequestError:
            # /health ha risposto un attimo fa: lo consideriamo su ma incerto.
            return DEGRADED, detail, "Sonda di readiness non raggiungibile"

        if ready.status_code < 400:
            return ONLINE, detail, None

        ready_detail = _json_fields(ready, ("status", "failing", "pendingReason"))
        detail.update(ready_detail)
        reason = ready_detail.get("pendingReason") or ready_detail.get("status") or "non pronto"
        failing = ready_detail.get("failing")
        if failing:
            reason = f"{reason}: {', '.join(str(f) for f in failing)}"
        return DEGRADED, detail, str(reason)


def _json_fields(response: httpx.Response, keys: tuple[str, ...]) -> dict[str, Any]:
    """Estrae dal corpo JSON solo le chiavi note, se il corpo e' JSON."""
    try:
        payload = response.json()
    except ValueError:
        return {}
    if not isinstance(payload, dict):
        return {}
    return {key: payload[key] for key in keys if key in payload}


def _short_error(exc: Exception) -> str:
    """Messaggi di rete leggibili al posto delle stringhe chilometriche di httpx."""
    text = str(exc) or exc.__class__.__name__
    if "connection attempts failed" in text.lower() or isinstance(exc, httpx.ConnectError):
        return "Gateway non in ascolto"
    if isinstance(exc, httpx.TimeoutException):
        return "Timeout"
    return text[:120]
