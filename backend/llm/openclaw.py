"""LLM client talking to a real OpenClaw agent, through the Gateway protocol.

Unlike the other backends (Ollama, LM Studio): here the "model" is your
configured OpenClaw agent (`~/.openclaw/openclaw.json`), with its
personality, its persistent memory and its tools. The companion literally
becomes that agent's voice and face, not a separate chatbot.

Protocol (verified by hand against a real Gateway, not only from the docs)
--------------------------------------------------------------------------
* First frame: ``connect`` with ``client: {id: "gateway-client", mode: "backend"}``
  - it's the documented path for trusted backend clients on loopback with the
  shared token. Answer: ``hello-ok``.
* ``chat.send`` wants ``{sessionKey, agentId, message, idempotencyKey}`` (not
  ``text``/``key``: names that look obvious but aren't the right ones).
* The reply arrives on the ``chat`` event channel, not token-by-token
  streaming by default: with the "block streaming" configuration off
  (OpenClaw's default) **a single event** arrives with the final state and
  all the text in ``deltaText``. The code below handles several chunks
  anyway, in case you turn block streaming on in OpenClaw in the future.
* The ``agent`` event channel also carries a ``"thinking"`` stream: it's the
  model's internal reasoning, token by token. It must ALWAYS be ignored,
  never read aloud - the same caution used for ``reasoning_content`` in
  ``openai_compatible.py``. Here we don't touch it at all.
* ``health`` and ``tick`` events arrive all the time and are just discarded.
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

from .activity import describe_openclaw_tool
from .base import LLMClient, Message, describe_error, with_directive

logger = logging.getLogger(__name__)

#: Terminal states of the "chat" event: the turn is over (well or badly).
_TERMINAL_STATES = {"final", "done", "complete", "error", "canceled", "cancelled"}


class OpenClawError(RuntimeError):
    """An RPC to the OpenClaw Gateway failed."""


class OpenClawClient(LLMClient):
    """Sends the companion's messages to a real OpenClaw agent.

    It keeps ONE persistent WebSocket connection (it reconnects by itself if it
    drops), and uses ONE dedicated, persistent session for the companion,
    reused across restarts: the memory of previous chats stays, exactly as you'd
    want from a companion who remembers you.
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
        # The status probes use http://; the chat uses ws:// on the same host.
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
        # One topic per chat turn: only whoever holds the turn reads its events.
        # The companion already serializes the turns (one Companion._turn_lock at a
        # time), so a single queue is enough and avoids routing the events by runId.
        self._chat_events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        self._session_key: str | None = None
        self._session_id: str | None = None
        self._closing = False

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------
    async def _ensure_connected(self) -> ClientConnection:
        """Opens the connection if needed; safe to call concurrently."""
        if self._socket is not None and not self._socket.close_code:
            return self._socket

        async with self._connect_lock:
            if self._socket is not None and not self._socket.close_code:
                return self._socket

            logger.info("Connecting to the OpenClaw Gateway at %s", self.ws_url)
            socket = await asyncio.wait_for(
                websockets.connect(self.ws_url, max_size=16 * 1024 * 1024),
                self.connect_timeout,
            )
            self._socket = socket
            self._pending.clear()
            # A single reader dispatches replies (by id) and events (to the queue).
            self._reader_task = asyncio.create_task(self._read_loop(socket))

            await self._handshake(socket)
            return socket

    async def _handshake(self, socket: ClientConnection) -> None:
        hello = await self._request(
            "connect",
            {
                "minProtocol": 4,
                "maxProtocol": 4,
                # The documented path for trusted backend clients on loopback with the
                # shared token (see the comment at the top of the file).
                "client": {
                    "id": "gateway-client",
                    "version": "1.0.0",
                    "platform": "windows",
                    "mode": "backend",
                },
                "role": "operator",
                "scopes": ["operator.read", "operator.write"],
                # "tool-events": the Gateway also sends us the tools the agent uses (only
                # name and arguments, never the reasoning).
                "caps": ["tool-events"],
                "commands": [],
                "permissions": {},
                "auth": {"token": self.token},
                "userAgent": "desk-companion/1.0",
            },
        )
        protocol = hello["payload"]["protocol"]
        logger.info("OpenClaw Gateway connected (protocol v%s)", protocol)

    async def _read_loop(self, socket: ClientConnection) -> None:
        """Dispatches every incoming frame: replies to the pending requests, chat
        events to the queue, everything else (health/tick/thinking) away.
        """
        try:
            async for raw in socket:
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Non-JSON frame from the Gateway ignored")
                    continue

                frame_type = message.get("type")
                if frame_type == "res":
                    future = self._pending.pop(message.get("id"), None)
                    if future and not future.done():
                        future.set_result(message)
                elif frame_type == "event" and message.get("event") == "chat":
                    self._chat_events.put_nowait(message.get("payload", {}))
                elif frame_type == "event" and message.get("event") == "agent":
                    # Of the "agent" channel we keep only the start of a tool: the thinking
                    # passing through here is never read.
                    payload = message.get("payload") or {}
                    data = payload.get("data") or {}
                    if payload.get("stream") == "tool" and data.get("phase") == "start" and not data.get("parentToolCallId"):
                        self._chat_events.put_nowait({"runId": payload.get("runId"), "tool": data})
                # "health", "tick", "connect.challenge": discarded on purpose.
        except websockets.ConnectionClosed:
            pass
        finally:
            # Unblocks whoever was waiting for a reply that will never arrive.
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(OpenClawError("Connection to the Gateway closed"))
            self._pending.clear()
            if not self._closing:
                logger.warning("Connection to the OpenClaw Gateway interrupted")

    async def _request(self, method: str, params: dict[str, Any], timeout: float = 30.0) -> dict:
        """Sends an RPC and waits for its reply (not an event)."""
        socket = self._socket
        if socket is None:
            raise OpenClawError("No connection to the Gateway")

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
            raise OpenClawError(f"{method} failed: {error.get('message', error)}")
        return response

    # ------------------------------------------------------------------
    # Persistent session
    # ------------------------------------------------------------------
    async def _ensure_session(self) -> str:
        """Finds or creates the companion's dedicated session, and remembers it on disk."""
        if self._session_key:
            return self._session_key

        cached = self._load_cached_session()
        if cached:
            self._session_key, self._session_id = cached
            logger.info("Reusing the existing OpenClaw session: %s", self._session_key)
            return self._session_key

        logger.info("Creating a new OpenClaw session dedicated to the companion")
        payload = await self._create_session_with_label("Desk Companion")
        self._session_key = payload["key"]
        self._session_id = payload["sessionId"]
        self._save_cached_session()
        return self._session_key

    async def _create_session_with_label(self, label: str) -> dict[str, Any]:
        """``sessions.create`` with a guaranteed unique label.

        Labels stay taken even after a session has been archived (verified: the
        label of an archived test still blocks an identical new
        ``sessions.create``). If it happens - also because of a state file lost
        after a test or an update - there's no point making the companion's start
        fail: we add a suffix and try again, instead of propagating the error.
        """
        try:
            response = await self._request("sessions.create", {"agentId": self.agent_id, "label": label})
            return response["payload"]
        except OpenClawError as exc:
            if "label already in use" not in str(exc):
                raise
            fallback_label = f"{label} ({uuid.uuid4().hex[:6]})"
            logger.warning(
                "Session label %r already taken (probably left over from an "
                "earlier test): using %r",
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
            # Files saved before this field belong to the "main" agent.
            if data.get("agentId", "main") != self.agent_id:
                logger.info("Saved session of another agent (%s): creating one for %s", data.get("agentId", "main"), self.agent_id)
                return None
            return data["sessionKey"], data["sessionId"]
        except (OSError, KeyError, json.JSONDecodeError) as exc:
            logger.warning("OpenClaw session state unreadable (%s): creating a new one", exc)
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
        """Sends only the user's LAST message: the conversation's memory already
        lives in the OpenClaw session on the server, so sending the whole local
        history again (as the other, stateless backends do) would be redundant and
        waste context.
        """
        if not any(m.role == "user" for m in messages):
            return
        # The agent has its own personality and doesn't see our system prompt: we
        # only pass it the speech constraints (the voice's language, no emoji) in
        # front of the message. Without them, it answers in the language you write
        # in even if the voice is English, and becomes incomprehensible.
        text = with_directive(messages)

        try:
            await self._ensure_connected()
        except (OSError, asyncio.TimeoutError) as exc:
            raise OpenClawError(f"OpenClaw Gateway unreachable ({describe_error(exc)})") from exc
        session_key = await self._ensure_session()

        # Empty any chat events left from a previous turn interrupted halfway
        # (for example by a cancel on the user's side).
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
        logger.info("OpenClaw turn started (runId=%s)", run_id)

        # Listen only to the "chat" channel: the thinking ("agent" channel) we
        # never read, on purpose (see the comment at the top of the file).
        #
        # The text can arrive in two forms, both seen live AND not mutually
        # exclusive as it first seemed: short replies arrive ONLY in the final
        # event's "message", but longer replies arrive WITH "deltaText" during the
        # turn *and then again in full* in the final event's "message". If we
        # already received text via deltaText, the final "message" must therefore
        # be ignored: it's a summary, not new content, and reading it would
        # duplicate the reply (verified live: without this check the sentence came
        # out twice, identical).
        got_delta_text = False
        while True:
            payload = await asyncio.wait_for(self._chat_events.get(), 120)

            # A shared connection may see other sessions' traffic (for example an
            # agent heartbeat): we drop everything that isn't our turn instead of
            # blindly trusting the order.
            if run_id and payload.get("runId") != run_id:
                logger.debug("Chat event of another turn ignored (runId=%s)", payload.get("runId"))
                continue

            tool = payload.get("tool")
            if tool is not None:
                activity = describe_openclaw_tool(str(tool.get("name") or ""), tool.get("args"))
                if activity is not None:
                    self.report(activity)
                continue

            state = payload.get("state")
            logger.debug("Chat event: state=%s seq=%s", state, payload.get("seq"))

            delta = payload.get("deltaText")
            if delta:
                got_delta_text = True
                yield delta
            elif state == "final" and not got_delta_text:
                # No delta received for this turn: the only text there is is the one in
                # the final message.
                message = payload.get("message") or {}
                content = message.get("content") or []
                text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
                if text:
                    yield text

            if state == "error":
                reason = payload.get("errorMessage") or "turn failed"
                raise OpenClawError(f"The OpenClaw agent answered with an error: {reason}")
            if state in _TERMINAL_STATES:
                return

    # ------------------------------------------------------------------
    async def reset(self) -> None:
        """Leaves the session: the next turn opens a new, empty one.

        Without this "Reset chat" reset nothing: the conversation lives in the
        OpenClaw session on the server, not in the local history, and a wrong reply
        left in there would stay in front of it forever.
        """
        self._session_key = None
        self._session_id = None
        if self.session_state_path and self.session_state_path.is_file():
            try:
                self.session_state_path.unlink()
            except OSError as exc:
                logger.warning("Session state not deleted (%s)", exc)
        logger.info("OpenClaw session reset: a new one is created at the next message")

    # ------------------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        """The Gateway's state through its HTTP probes, without opening the chat.

        Here we used to open the WebSocket connection and the session: with the
        Gateway off every check cost two seconds and queued up behind the others,
        so /api/health hung for minutes and the Electron shell took the backend for
        dead at startup.

        ``/health`` says whether the server is alive, ``/readyz`` whether it's ready
        (configured channels included): on but not ready counts as "degraded".
        """
        base = {"backend": self.name, "model": self.agent_id, "session": self._session_key}
        try:
            # On Windows a closed port refuses after ~2 s (it retries the SYN): with a
            # shorter connect it would look like a timeout, not "off".
            async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=3.0)) as client:
                alive = await client.get(f"{self.http_url}/health")
                if alive.status_code >= 400:
                    return {**base, "ok": False, "error": f"The Gateway answers {alive.status_code}"}
                ready = await client.get(f"{self.http_url}/readyz")
        except httpx.HTTPError as exc:
            off = isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout))
            return {
                **base,
                "ok": False,
                "error": "OpenClaw Gateway off" if off else describe_error(exc),
                "hint": "Start it with: openclaw gateway start",
            }

        if ready.status_code < 400:
            return {**base, "ok": True}
        try:
            detail = ready.json()
        except ValueError:
            detail = {}
        reason = detail.get("pendingReason") or detail.get("status") or "not ready"
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
