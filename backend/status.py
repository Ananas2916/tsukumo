"""Stato dei motori attivi: cervello, voce, ascolto.

Prima c'era una spia sola, dedicata al Gateway OpenClaw, anche quando il
cervello era un altro. Qui il monitor chiede a *qualunque* motore attivo se sta
bene (``LLMClient.probe``) e avvisa i client solo quando qualcosa cambia.

Il risultato e' sempre in cache: ``/api/health`` e il messaggio ``hello`` lo
leggono senza mai toccare la rete, quindi non possono restare appesi.

Stati possibili: ``online`` (verde), ``degraded`` (giallo: risponde ma con un
problema), ``offline`` (rosso), ``unknown`` (grigio: non ancora controllato),
``off`` (spento di proposito, come l'ascolto disattivato).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from .providers import REGISTRIES

if TYPE_CHECKING:  # pragma: no cover
    from .pipeline import Companion

logger = logging.getLogger(__name__)

OnChange = Callable[[dict[str, Any]], Awaitable[None]]


def _spec_fields(kind: str, provider: str) -> dict[str, Any]:
    spec = REGISTRIES[kind].get(provider)
    if spec is None:
        return {"id": provider, "label": provider, "category": "local"}
    return {"id": spec.id, "label": spec.label, "category": spec.category, "pricing": spec.pricing}


def llm_entry(provider: str, probe: dict[str, Any] | None) -> dict[str, Any]:
    """Traduce la risposta di ``probe()`` nel formato della spia."""
    entry = {**_spec_fields("llm", provider), "state": "unknown", "detail": None, "hint": None}
    if probe is None:
        return entry
    if probe.get("ok"):
        entry["state"] = "degraded" if probe.get("degraded") or probe.get("modelAvailable") is False else "online"
    else:
        entry["state"] = "offline"
    entry["detail"] = probe.get("error") or None
    entry["hint"] = probe.get("hint") or None
    entry["model"] = probe.get("model") or None
    if probe.get("models"):
        entry["models"] = list(probe["models"])[:50]
    return entry


class EngineMonitor:
    """Controlla periodicamente i motori del companion attivo."""

    def __init__(
        self,
        companion: Callable[[], "Companion | None"],
        interval: float = 10.0,
        on_change: OnChange | None = None,
    ) -> None:
        self._companion = companion
        self.interval = max(2.0, interval)
        self.on_change = on_change
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()
        self._status: dict[str, Any] = {"type": "engines", "llm": None, "tts": None, "stt": None, "checkedAt": None}

    # ------------------------------------------------------------------
    @property
    def status(self) -> dict[str, Any]:
        """L'ultimo stato noto, senza fare rete. Sempre immediato."""
        current = self._companion()
        if current is not None and self._status["llm"] is None:
            # Prima del primo controllo: almeno chi e' attivo, in grigio.
            return {**self._status, **self._local(current, None)}
        return dict(self._status)

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="engine-monitor")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def poke(self) -> None:
        """Controlla subito (per esempio dopo un cambio di motore)."""
        self._wake.set()

    # ------------------------------------------------------------------
    async def _loop(self) -> None:
        logger.info("Controllo dei motori ogni %.0fs", self.interval)
        while True:
            try:
                await self.check()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - il monitor non deve mai morire
                logger.exception("Controllo dei motori fallito in modo imprevisto")
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), self.interval)
            except asyncio.TimeoutError:
                pass

    async def check(self) -> dict[str, Any]:
        """Un giro di controllo; notifica i client se qualcosa e' cambiato."""
        async with self._lock:
            companion = self._companion()
            if companion is None:
                return self.status
            probe = await companion.llm.probe()
            fresh = {**self._status, **self._local(companion, probe), "checkedAt": time.time()}
            changed = _signature(fresh) != _signature(self._status)
            self._status = fresh
        if changed:
            llm = fresh["llm"]
            logger.info(
                "Cervello %s: %s%s", llm["id"], llm["state"], f" ({llm['detail']})" if llm.get("detail") else ""
            )
            if self.on_change is not None:
                await self.on_change(self.status)
        return self.status

    # ------------------------------------------------------------------
    @staticmethod
    def _local(companion: "Companion", probe: dict[str, Any] | None) -> dict[str, Any]:
        settings = companion.settings
        llm = llm_entry(settings.selected("llm"), probe)
        if llm["state"] == "online" and companion.last_errors.get("llm"):
            # Il servizio risponde, ma l'ultimo turno e' fallito: lo si dice.
            llm["state"] = "degraded"
            llm["detail"] = companion.last_errors["llm"]

        tts_id = settings.selected("tts")
        tts = {**_spec_fields("tts", tts_id), "state": "online", "detail": None, "voice": companion.voice}
        reason = getattr(companion.tts, "fallback_reason", None)
        if reason:
            tts.update(state="degraded", detail=f"Uso la voce di servizio: {reason}")
        elif companion.last_errors.get("tts"):
            tts.update(state="degraded", detail=companion.last_errors["tts"])
        if companion.muted:
            tts["muted"] = True

        stt_id = settings.selected("stt") or "none"
        if stt_id in ("none", "off", "disabled"):
            stt = {**_spec_fields("stt", "none"), "state": "off", "detail": None}
        elif stt_id == "browser" or companion.stt is not None:
            stt = {**_spec_fields("stt", stt_id), "state": "online", "detail": None}
        else:
            stt = {**_spec_fields("stt", stt_id), "state": "offline", "detail": "Motore non avviato: guarda il log"}
        return {"llm": llm, "tts": tts, "stt": stt}


def _signature(status: dict[str, Any]) -> tuple:
    """Quello che conta per decidere se avvisare (non l'ora del controllo)."""
    parts = []
    for kind in ("llm", "tts", "stt"):
        entry = status.get(kind) or {}
        parts.append((entry.get("id"), entry.get("state"), entry.get("detail"), entry.get("muted"), entry.get("voice")))
    return tuple(parts)
