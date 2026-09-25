"""Client LLM che parla con un agente OpenClaw vero, via il protocollo Gateway.

Diverso dagli altri backend (Ollama, LM Studio): qui il "modello" e' il tuo
agente OpenClaw configurato (`~/.openclaw/openclaw.json`), con la sua
personalita', la sua memoria persistente e i suoi tool. Il companion diventa
letteralmente la voce e la faccia di quell'agente, non un chatbot a parte.

Protocollo (verificato a mano contro un Gateway reale, non solo dai docs)
--------------------------------------------------------------------------
* Prima frame: ``connect`` con ``client: {id: "gateway-client", mode: "backend"}``
  - e' il percorso documentato per client di backend fidati su loopback con il
  token condiviso. Risposta: ``hello-ok``.
* ``chat.send`` vuole ``{sessionKey, agentId, message, idempotencyKey}`` (non
  ``text``/``key``: sono nomi che sembrano ovvi ma non sono quelli giusti).
* La risposta arriva sul canale evento ``chat``, non in streaming token per
  token per default: con la configurazione "block streaming" spenta (il default
  di OpenClaw) arriva **un solo evento** con lo stato finale e tutto il testo in
  ``deltaText``. Il codice qui sotto gestisce comunque piu' frammenti, nel caso
  in futuro tu attivi il block streaming lato OpenClaw.
* Il canale evento ``agent`` porta anche uno stream ``"thinking"``: e' il
  ragionamento interno del modello, token per token. Va SEMPRE ignorato, mai
  letto ad alta voce - stessa cautela usata per ``reasoning_content`` in
  ``openai_compatible.py``. Qui non lo tocchiamo proprio.
* Gli eventi ``health`` e ``tick`` arrivano di continuo e vanno solo scartati.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import websockets
from websockets.asyncio.client import ClientConnection

from .base import LLMClient, Message, describe_error, with_directive

logger = logging.getLogger(__name__)

#: Stati terminali dell'evento "chat": il turno e' finito (bene o male).
_TERMINAL_STATES = {"final", "done", "complete", "error", "canceled", "cancelled"}


class OpenClawError(RuntimeError):
    """Un RPC verso il Gateway OpenClaw e' fallito."""


class OpenClawClient(LLMClient):
    """Manda i messaggi del companion a un agente OpenClaw vero.

    Tiene UNA connessione WebSocket persistente (si riconnette da sola se
    cade), e usa UNA sessione dedicata e persistente per il companion,
    riutilizzata tra i riavvii: la memoria delle chat precedenti resta,
    esattamente come vorresti da un compagno che si ricorda di te.
    """

    name = "openclaw"
    stateful = True

    def __init__(
        self,
        gateway_url: str,
        token: str,
        agent_id: str = "main",
        session_state_path: Path | None = None,
        connect_timeout: float = 10.0,
    ) -> None:
        # Le sonde di stato usano http://; la chat serve ws:// sullo stesso host.
        self.http_url = gateway_url.rstrip("/").replace("ws://", "http://").replace("wss://", "https://")
        self.ws_url = self.http_url.replace("http://", "ws://").replace("https://", "wss://")
        self.token = token
        self.agent_id = agent_id
        self.session_state_path = session_state_path
        self.connect_timeout = connect_timeout

        self._socket: ClientConnection | None = None
        self._connect_lock = asyncio.Lock()
        self._reader_task: asyncio.Task | None = None
        self._pending: dict[str, asyncio.Future] = {}
        # Un topic per turno di chat: solo chi ha in mano il turno legge i suoi
        # eventi. Il companion serializza gia' i turni (un solo Companion._turn_lock
        # alla volta), quindi una singola coda basta ed evita di dover instradare
        # gli eventi per runId.
        self._chat_events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        self._session_key: str | None = None
        self._session_id: str | None = None
        self._closing = False

    # ------------------------------------------------------------------
    # Connessione
    # ------------------------------------------------------------------
    async def _ensure_connected(self) -> ClientConnection:
        """Apre la connessione se serve; sicura da chiamare in concorrenza."""
        if self._socket is not None and not self._socket.close_code:
            return self._socket

        async with self._connect_lock:
            if self._socket is not None and not self._socket.close_code:
                return self._socket

            logger.info("Connessione al Gateway OpenClaw su %s", self.ws_url)
            socket = await asyncio.wait_for(
                websockets.connect(self.ws_url, max_size=16 * 1024 * 1024),
                self.connect_timeout,
            )
            self._socket = socket
            self._pending.clear()
            # Un lettore unico smista risposte (per id) ed eventi (in coda).
            self._reader_task = asyncio.create_task(self._read_loop(socket))

            await self._handshake(socket)
            return socket

    async def _handshake(self, socket: ClientConnection) -> None:
        hello = await self._request(
            "connect",
            {
                "minProtocol": 4,
                "maxProtocol": 4,
                # Percorso documentato per client di backend fidati su loopback
                # con il token condiviso (vedi il commento in testa al file).
                "client": {
                    "id": "gateway-client",
                    "version": "1.0.0",
                    "platform": "windows",
                    "mode": "backend",
                },
                "role": "operator",
                "scopes": ["operator.read", "operator.write"],
                "caps": [],
                "commands": [],
                "permissions": {},
                "auth": {"token": self.token},
                "userAgent": "desk-companion/1.0",
            },
        )
        protocol = hello["payload"]["protocol"]
        logger.info("Gateway OpenClaw connesso (protocollo v%s)", protocol)

    async def _read_loop(self, socket: ClientConnection) -> None:
        """Smista ogni frame in arrivo: risposte alle richieste in sospeso,
        eventi di chat nella coda, tutto il resto (health/tick/thinking) via.
        """
        try:
            async for raw in socket:
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Frame non JSON dal Gateway ignorato")
                    continue

                frame_type = message.get("type")
                if frame_type == "res":
                    future = self._pending.pop(message.get("id"), None)
                    if future and not future.done():
                        future.set_result(message)
                elif frame_type == "event" and message.get("event") == "chat":
                    self._chat_events.put_nowait(message.get("payload", {}))
                # Eventi come "agent" (contiene il thinking, da non leggere mai),
                # "health", "tick", "connect.challenge": scartati di proposito.
        except websockets.ConnectionClosed:
            pass
        finally:
            # Sblocca chi stava aspettando una risposta che non arrivera' piu'.
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(OpenClawError("Connessione al Gateway chiusa"))
            self._pending.clear()
            if not self._closing:
                logger.warning("Connessione al Gateway OpenClaw interrotta")

    async def _request(self, method: str, params: dict[str, Any], timeout: float = 30.0) -> dict:
        """Manda una RPC e aspetta la sua risposta (non un evento)."""
        socket = self._socket
        if socket is None:
            raise OpenClawError("Nessuna connessione al Gateway")

        request_id = str(uuid.uuid4())
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future

        await socket.send(json.dumps({"type": "req", "id": request_id, "method": method, "params": params}))
        try:
            response = await asyncio.wait_for(future, timeout)
        finally:
            self._pending.pop(request_id, None)

        if not response.get("ok"):
            error = response.get("error", {})
            raise OpenClawError(f"{method} fallita: {error.get('message', error)}")
        return response

    # ------------------------------------------------------------------
    # Sessione persistente
    # ------------------------------------------------------------------
    async def _ensure_session(self) -> str:
        """Trova o crea la sessione dedicata del companion, e la ricorda su disco."""
        if self._session_key:
            return self._session_key

        cached = self._load_cached_session()
        if cached:
            self._session_key, self._session_id = cached
            logger.info("Riuso la sessione OpenClaw esistente: %s", self._session_key)
            return self._session_key

        logger.info("Creo una nuova sessione OpenClaw dedicata al companion")
        payload = await self._create_session_with_label("Desk Companion")
        self._session_key = payload["key"]
        self._session_id = payload["sessionId"]
        self._save_cached_session()
        return self._session_key

    async def _create_session_with_label(self, label: str) -> dict[str, Any]:
        """``sessions.create`` con etichetta univoca garantita.

        Le etichette restano occupate anche dopo che una sessione e' stata
        archiviata (verificato: un'etichetta di un test archiviato blocca
        comunque una nuova ``sessions.create`` identica). Se capita - anche
        per un file di stato perso dopo un test o un aggiornamento - non ha
        senso far fallire l'avvio del companion: aggiungiamo un suffisso e
        proviamo di nuovo, invece di propagare l'errore.
        """
        try:
            response = await self._request("sessions.create", {"agentId": self.agent_id, "label": label})
            return response["payload"]
        except OpenClawError as exc:
            if "label already in use" not in str(exc):
                raise
            fallback_label = f"{label} ({uuid.uuid4().hex[:6]})"
            logger.warning(
                "Etichetta sessione %r già occupata (probabile residuo di un test "
                "precedente): uso %r",
                label,
                fallback_label,
            )
            response = await self._request(
                "sessions.create", {"agentId": self.agent_id, "label": fallback_label}
            )
            return response["payload"]

    def _load_cached_session(self) -> tuple[str, str] | None:
        if not self.session_state_path or not self.session_state_path.is_file():
            return None
        try:
            data = json.loads(self.session_state_path.read_text(encoding="utf-8"))
            # I file salvati prima di questo campo appartengono all'agente "main".
            if data.get("agentId", "main") != self.agent_id:
                logger.info("Sessione salvata di un altro agente (%s): ne creo una per %s", data.get("agentId", "main"), self.agent_id)
                return None
            return data["sessionKey"], data["sessionId"]
        except (OSError, KeyError, json.JSONDecodeError) as exc:
            logger.warning("Stato sessione OpenClaw illeggibile (%s): ne creo una nuova", exc)
            return None

    def _save_cached_session(self) -> None:
        if not self.session_state_path:
            return
        self.session_state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"agentId": self.agent_id, "sessionKey": self._session_key, "sessionId": self._session_id}
        self.session_state_path.write_text(json.dumps(payload), encoding="utf-8")

    # ------------------------------------------------------------------
    # LLMClient
    # ------------------------------------------------------------------
    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        """Manda solo l'ULTIMO messaggio dell'utente: la memoria della
        conversazione vive gia' nella sessione OpenClaw sul server, quindi
        rimandare tutta la cronologia locale (come fanno gli altri backend
        stateless) sarebbe ridondante e sprecherebbe contesto.
        """
        if not any(m.role == "user" for m in messages):
            return
        # L'agente ha la sua personalita' e non vede il nostro system prompt:
        # gli passiamo solo i vincoli del parlato (lingua della voce, niente
        # emoji) davanti al messaggio. Senza, risponde nella lingua in cui
        # scrivi anche se la voce e' inglese, e diventa incomprensibile.
        text = with_directive(messages)

        try:
            await self._ensure_connected()
        except (OSError, asyncio.TimeoutError) as exc:
            raise OpenClawError(f"Gateway OpenClaw non raggiungibile ({describe_error(exc)})") from exc
        session_key = await self._ensure_session()

        # Svuota eventuali eventi di chat rimasti da un turno precedente
        # interrotto a meta' (per esempio da un cancel lato utente).
        while not self._chat_events.empty():
            self._chat_events.get_nowait()

        send_response = await self._request(
            "chat.send",
            {
                "sessionKey": session_key,
                "agentId": self.agent_id,
                "message": text,
                "idempotencyKey": str(uuid.uuid4()),
            },
        )
        run_id = send_response["payload"].get("runId")
        logger.info("Turno OpenClaw avviato (runId=%s)", run_id)

        # Ascolta solo il canale "chat": il thinking (canale "agent") non lo
        # leggiamo mai, di proposito (vedi il commento in testa al file).
        #
        # Il testo puo' arrivare in due forme, viste entrambe dal vivo E non a
        # vicenda esclusive come sembrava all'inizio: risposte brevi arrivano
        # SOLO nel "message" dell'evento finale, ma risposte piu' lunghe
        # arrivano CON "deltaText" durante il turno *e poi di nuovo per intero*
        # nel "message" dell'evento finale. Se abbiamo gia' ricevuto del testo
        # via deltaText, il "message" finale va quindi ignorato: e' un
        # riepilogo, non contenuto nuovo, e leggerlo duplicherebbe la risposta
        # (verificato dal vivo: senza questo controllo la frase usciva due
        # volte identica).
        got_delta_text = False
        while True:
            payload = await asyncio.wait_for(self._chat_events.get(), 120)

            # Un connect condiviso puo' vedere traffico di altre sessioni
            # (per esempio un heartbeat dell'agente): scartiamo tutto cio' che
            # non e' il nostro turno invece di fidarci ciecamente dell'ordine.
            if run_id and payload.get("runId") != run_id:
                logger.debug("Evento chat di un altro turno ignorato (runId=%s)", payload.get("runId"))
                continue

            state = payload.get("state")
            logger.debug("Evento chat: state=%s seq=%s", state, payload.get("seq"))

            delta = payload.get("deltaText")
            if delta:
                got_delta_text = True
                yield delta
            elif state == "final" and not got_delta_text:
                # Nessun delta ricevuto per questo turno: l'unico testo che
                # esiste e' quello nel messaggio finale.
                message = payload.get("message") or {}
                content = message.get("content") or []
                text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
                if text:
                    yield text

            if state == "error":
                reason = payload.get("errorMessage") or "turno fallito"
                raise OpenClawError(f"L'agente OpenClaw ha risposto con un errore: {reason}")
            if state in _TERMINAL_STATES:
                return

    # ------------------------------------------------------------------
    async def reset(self) -> None:
        """Abbandona la sessione: il turno dopo ne apre una nuova, vuota.

        Senza questo "Azzera chat" non azzerava niente: la conversazione vive
        nella sessione OpenClaw sul server, non nella cronologia locale, e una
        risposta sbagliata rimasta li' dentro se la ritrova per sempre davanti.
        """
        self._session_key = None
        self._session_id = None
        if self.session_state_path and self.session_state_path.is_file():
            try:
                self.session_state_path.unlink()
            except OSError as exc:
                logger.warning("Stato sessione non cancellato (%s)", exc)
        logger.info("Sessione OpenClaw azzerata: al prossimo messaggio ne creo una nuova")

    # ------------------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        """Stato del Gateway con le sue sonde HTTP, senza aprire la chat.

        Prima qui si apriva la connessione WebSocket e la sessione: con il
        Gateway spento ogni controllo costava due secondi e si metteva in coda
        agli altri, cosi' /api/health restava appeso per minuti e la shell
        Electron dava il backend per morto all'avvio.

        ``/health`` dice se il server e' vivo, ``/readyz`` se e' pronto (canali
        configurati compresi): acceso ma non pronto vale "degraded".
        """
        base = {"backend": self.name, "model": self.agent_id, "session": self._session_key}
        try:
            # Su Windows una porta chiusa rifiuta dopo ~2 s (ritenta il SYN):
            # con un connect piu' corto sembrerebbe un timeout, non un "spento".
            async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=3.0)) as client:
                alive = await client.get(f"{self.http_url}/health")
                if alive.status_code >= 400:
                    return {**base, "ok": False, "error": f"Il Gateway risponde {alive.status_code}"}
                ready = await client.get(f"{self.http_url}/readyz")
        except httpx.HTTPError as exc:
            off = isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout))
            return {
                **base,
                "ok": False,
                "error": "Gateway OpenClaw spento" if off else describe_error(exc),
                "hint": "Avvialo con: openclaw gateway start",
            }

        if ready.status_code < 400:
            return {**base, "ok": True}
        try:
            detail = ready.json()
        except ValueError:
            detail = {}
        reason = detail.get("pendingReason") or detail.get("status") or "non pronto"
        failing = detail.get("failing")
        if failing:
            reason = f"{reason}: {', '.join(str(item) for item in failing)}"
        return {**base, "ok": True, "degraded": True, "error": str(reason)}

    async def close(self) -> None:
        self._closing = True
        if self._reader_task:
            self._reader_task.cancel()
        if self._socket is not None:
            await self._socket.close()
