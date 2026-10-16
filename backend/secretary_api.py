"""The secretary's HTTP API: to-dos, notes, focus, the vault, the services'
settings, what the agents send to her body (MCP, ``scripts/tsukumo_mcp.py``)
and the permission requests.

Which of these are local-only is decided in security.py (``LOCAL_ONLY``):
the settings, the vault, the agents' endpoints and the approvals never
answer a remote client. The one exception is ``/api/phone/approvals/{id}``:
allow or deny, from the phone, for the exact request it was shown.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .approvals import Approvals
from .calendar_ics import split_urls
from .config import save_dotenv
from .mailbox import MailConfig, check as check_mail, guess_host
from .notebook import end_of_day
from .preferences import TRAVEL_MODES, Preferences
from .secretary import Secretary
from .vault import Vault

logger = logging.getLogger(__name__)

Broadcast =Callable[[dict[str, Any]], Awaitable[None]]

_HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}$")


def mail_config() -> MailConfig:
    """The mailbox's settings, read live from the environment (the panel updates it)."""
    user = os.environ.get("DC_MAIL_USER", "").strip()
    try:
        port = int(os.environ.get("DC_MAIL_PORT") or 993)
    except ValueError:
        port = 993
    return MailConfig(
        host=os.environ.get("DC_MAIL_HOST", "").strip() or guess_host(user),
        user=user,
        password=os.environ.get("DC_MAIL_PASSWORD", ""),
        port=port,
    )


def calendar_urls() -> str:
    return os.environ.get("DC_CALENDAR_URLS", "")


@dataclass
class Services:
    secretary: Secretary
    vault: Vault
    approvals: Approvals
    preferences: Preferences
    broadcast: Broadcast
    #: The companion's language ("it"/"en"), for the cards' texts.
    language: Callable[[], str]


class TodoRequest(BaseModel):
    text: str = Field(..., max_length=300)
    by: str | None = Field(None, description="YYYY-MM-DD")
    important: bool = False


class TodoUpdate(BaseModel):
    done: bool | None = None
    text: str | None = Field(None, max_length=300)
    by: str | None = Field(None, description="YYYY-MM-DD, '' clears it")
    important: bool | None = None


class NoteRequest(BaseModel):
    text: str = Field(..., max_length=1200)


class FocusRequest(BaseModel):
    minutes: float = Field(60, ge=5, le=480)


class SecretRequest(BaseModel):
    label: str = Field(..., max_length=60)
    value: str = Field(..., max_length=500)


class SecretarySettings(BaseModel):
    calendarUrls: str | None = Field(None, max_length=4000)
    mailUser: str | None = Field(None, max_length=200)
    mailPassword: str | None = Field(None, max_length=300)
    mailHost: str | None = Field(None, max_length=253)
    mailPort: int | None = Field(None, ge=1, le=65535)
    home: str | None = Field(None, max_length=160)
    travel: str | None = None


class AgentSay(BaseModel):
    text: str = Field(..., max_length=1000)
    source: str = Field("agent", max_length=40)


class AgentShow(BaseModel):
    title: str = Field(..., max_length=120)
    text: str = Field("", max_length=4000)
    url: str | None = Field(None, max_length=2000)
    source: str = Field("agent", max_length=40)


class ApprovalRequest(BaseModel):
    source: str = Field("claude", max_length=40)
    label: str = Field("Claude Code", max_length=60)
    tool: str = Field("", max_length=80)
    input: Any = None
    project: str = Field("", max_length=120)


class ApprovalDecision(BaseModel):
    decision: str


class PhoneApprovalDecision(BaseModel):
    """The phone's answer: no "always", and the command it showed, to bind the answer to it."""

    decision: Literal["allow", "deny"]
    summary: str = Field(..., max_length=400)


def _by(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return end_of_day(date.fromisoformat(value[:10]))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date: use YYYY-MM-DD.") from exc


def create_router(services: Services) -> APIRouter:
    router = APIRouter()
    secretary = services.secretary
    notebook = secretary.notebook

    async def changed() -> None:
        await secretary.changed()

    # ------------------------------------------------------------ overview
    @router.get("/api/secretary")
    async def get_secretary() -> dict[str, Any]:
        return secretary.status()

    @router.post("/api/secretary/refresh")
    async def refresh_secretary() -> dict[str, Any]:
        await secretary.refresh(force=True)
        await changed()
        return secretary.status()

    @router.get("/api/secretary/settings")
    async def secretary_settings() -> dict[str, Any]:
        config = mail_config()
        return {
            "calendars": len(split_urls(calendar_urls())),
            "mail": {"user": config.user, "host": os.environ.get("DC_MAIL_HOST", ""), "guessedHost": guess_host(config.user), "port": config.port, "password": bool(config.password)},
            "home": services.preferences.data.get("home", ""),
            "travel": services.preferences.data.get("travel", "car"),
            "travelModes": list(TRAVEL_MODES),
        }

    @router.post("/api/secretary/settings")
    async def save_secretary_settings(request: SecretarySettings) -> dict[str, Any]:
        updates: dict[str, str] = {}
        if request.calendarUrls is not None:
            urls = split_urls(request.calendarUrls)
            if request.calendarUrls.strip() and not urls:
                raise HTTPException(status_code=400, detail="The calendar links must start with https:// or webcal://.")
            updates["DC_CALENDAR_URLS"] = " ".join(urls)
        if request.mailUser is not None:
            updates["DC_MAIL_USER"] = request.mailUser.strip()
            if not updates["DC_MAIL_USER"]:
                # No account any more: its password goes too.
                updates["DC_MAIL_PASSWORD"] = ""
        if request.mailPassword and updates.get("DC_MAIL_USER", "x"):
            # The app passwords Google shows have spaces: they're not part of it.
            updates["DC_MAIL_PASSWORD"] = request.mailPassword.replace(" ", "") if len(request.mailPassword.replace(" ", "")) == 16 else request.mailPassword
        if request.mailHost is not None:
            host = request.mailHost.strip()
            if host and not _HOST.match(host):
                raise HTTPException(status_code=400, detail="Invalid mail server name.")
            updates["DC_MAIL_HOST"] = host
        if request.mailPort is not None:
            updates["DC_MAIL_PORT"] = str(request.mailPort)
        if request.travel is not None and request.travel not in TRAVEL_MODES:
            raise HTTPException(status_code=400, detail="Unknown travel mode.")
        if updates:
            await asyncio.to_thread(save_dotenv, updates)
            for key, value in updates.items():
                if value:
                    os.environ[key] = value
                else:
                    os.environ.pop(key, None)
        prefs = {key: value for key, value in (("home", request.home), ("travel", request.travel)) if value is not None}
        if prefs:
            services.preferences.update(prefs)
        if "DC_CALENDAR_URLS" in updates or any(key.startswith("DC_MAIL") for key in updates):
            secretary.mail.mails, secretary.mail.fetched_at = [], None
            await secretary.refresh(force=True)
        await changed()
        return await secretary_settings()

    @router.post("/api/secretary/check")
    async def check_services() -> dict[str, Any]:
        result: dict[str, Any] = {}
        if split_urls(calendar_urls()):
            await secretary.calendar.refresh(force=True)
            result["calendar"] = {"ok": not secretary.calendar.error, "error": secretary.calendar.error, "events": len(secretary.calendar.events), "names": secretary.calendar.names}
        config = mail_config()
        if config.ready:
            error = await asyncio.to_thread(check_mail, config)
            result["mail"] = {"ok": not error, "error": error or None}
        await changed()
        return result

    # ------------------------------------------------------------ to-dos and notes
    @router.post("/api/todos")
    async def add_todo(request: TodoRequest) -> dict[str, Any]:
        item = notebook.add_todo(request.text, due=_by(request.by), important=request.important, source="panel")
        if item is None:
            raise HTTPException(status_code=400, detail="Empty to-do.")
        await changed()
        return {"ok": True, "todo": item.as_dict()}

    @router.post("/api/todos/{todo_id}")
    async def update_todo(todo_id: str, request: TodoUpdate) -> dict[str, Any]:
        if todo_id not in {item.id for item in notebook.todos(include_done=True)}:
            raise HTTPException(status_code=404, detail="To-do not found")
        if request.done is not None:
            notebook.complete(todo_id, request.done)
        due: float | None | bool = False if request.by is None else _by(request.by)
        item = notebook.update_todo(todo_id, text=request.text, due=due, important=request.important)
        await changed()
        return {"ok": True, "todo": item.as_dict() if item else None}

    @router.delete("/api/todos/{todo_id}")
    async def delete_todo(todo_id: str) -> dict[str, Any]:
        if notebook.remove_todo(todo_id) is None:
            raise HTTPException(status_code=404, detail="To-do not found")
        await changed()
        return {"ok": True}

    @router.post("/api/notes")
    async def add_note(request: NoteRequest) -> dict[str, Any]:
        item = notebook.add_note(request.text, source="panel")
        if item is None:
            raise HTTPException(status_code=400, detail="Empty note.")
        await changed()
        return {"ok": True, "note": item.as_dict()}

    @router.delete("/api/notes/{note_id}")
    async def delete_note(note_id: str) -> dict[str, Any]:
        if notebook.remove_note(note_id) is None:
            raise HTTPException(status_code=404, detail="Note not found")
        await changed()
        return {"ok": True}

    # ------------------------------------------------------------ focus
    @router.post("/api/focus")
    async def start_focus(request: FocusRequest) -> dict[str, Any]:
        until = secretary.start_focus(request.minutes)
        await changed()
        return {"ok": True, "until": until}

    @router.delete("/api/focus")
    async def stop_focus() -> dict[str, Any]:
        secretary.stop_focus()
        await changed()
        return {"ok": True}

    # ------------------------------------------------------------ the vault
    @router.get("/api/vault")
    async def get_vault() -> dict[str, Any]:
        return services.vault.as_dict()

    @router.get("/api/vault/{secret_id}")
    async def read_secret(secret_id: str) -> dict[str, Any]:
        value = services.vault.value(secret_id)
        if value is None:
            raise HTTPException(status_code=404, detail="Not in the vault")
        return {"value": value}

    @router.post("/api/vault")
    async def add_secret(request: SecretRequest) -> dict[str, Any]:
        try:
            item = services.vault.add(request.label, request.value)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        # No broadcast: the labels would reach the phone too. The panel reloads the list.
        return {"ok": True, "item": item.public()}

    @router.delete("/api/vault/{secret_id}")
    async def delete_secret(secret_id: str) -> dict[str, Any]:
        if services.vault.remove(secret_id) is None:
            raise HTTPException(status_code=404, detail="Not in the vault")
        return {"ok": True}

    # ------------------------------------------------------------ the agents (MCP)
    @router.post("/api/agent/say")
    async def agent_say(request: AgentSay) -> dict[str, Any]:
        text = " ".join(request.text.split())
        if not text:
            raise HTTPException(status_code=400, detail="Empty text.")
        spoken = await secretary.say(text, f"Message from {request.source}: {text[:200]}", kind="agent")
        return {"ok": True, "spoken": spoken, "kept": not spoken}

    @router.post("/api/agent/show")
    async def agent_show(request: AgentShow) -> dict[str, Any]:
        url = (request.url or "").strip()
        if url and not url.lower().startswith(("https://", "http://")):
            raise HTTPException(status_code=400, detail="Only http(s) links.")
        card = {"type": "card", "title": request.title.strip(), "text": request.text.strip(), "url": url or None, "source": request.source, "at": time.time()}
        await services.broadcast(card)
        return {"ok": True}

    @router.get("/api/agent/presence")
    async def agent_presence() -> dict[str, Any]:
        context = secretary.context
        return {
            "present": context.present,
            "absentSeconds": round(context.absent_seconds()) if context.fresh else None,
            "activity": context.activity.kind if context.fresh else "unknown",
            "doNotDisturb": context.activity.dnd if context.fresh else False,
            "focusUntil": secretary.focus_until or None,
        }

    @router.get("/api/agent/agenda")
    async def agent_agenda(days: int = 1) -> dict[str, Any]:
        days = max(1, min(14, days))
        now = time.time()
        start = datetime.combine(date.today(), datetime.min.time())
        items = []
        for offset in range(days):
            day = (start + timedelta(days=offset)).date()
            for ts, title in secretary.agenda_items(day, since=now if offset == 0 else None):
                items.append({"at": datetime.fromtimestamp(ts).isoformat(timespec="minutes"), "title": title})
        todos = [item.as_dict() for item in notebook.todos()][:30]
        return {"agenda": items, "todos": todos}

    @router.get("/api/agent/search")
    async def agent_search(q: str = "") -> dict[str, Any]:
        answer = secretary.search_text(q[:200], services.language()) if q.strip() else None
        return {"found": answer}

    # ------------------------------------------------------------ approvals
    @router.get("/api/approvals")
    async def list_approvals() -> dict[str, Any]:
        return {"approvals": services.approvals.public()}

    @router.post("/api/approvals")
    async def ask_approval(request: ApprovalRequest) -> dict[str, Any]:
        decision = await services.approvals.ask(request.source, request.label, request.tool, request.input, request.project)
        return {"decision": decision}

    @router.post("/api/approvals/{approval_id}")
    async def decide_approval(approval_id: str, request: ApprovalDecision) -> dict[str, Any]:
        if not services.approvals.decide(approval_id, request.decision):
            raise HTTPException(status_code=404, detail="Request expired or already answered")
        return {"ok": True}

    @router.post("/api/phone/approvals/{approval_id}")
    async def decide_from_phone(approval_id: str, request: PhoneApprovalDecision) -> dict[str, Any]:
        outcome = services.approvals.decide_remote(approval_id, request.decision, request.summary)
        if outcome == "gone":
            raise HTTPException(status_code=404, detail="Request expired or already answered")
        if outcome != "ok":
            raise HTTPException(status_code=409, detail="This answer is for another request")
        logger.info("Permission %s answered from the phone: %s", approval_id, request.decision)
        return {"ok": True}

    return router
