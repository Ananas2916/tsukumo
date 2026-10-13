"""The mailbox, read only: what's new, what waits for an answer, parcels and bills.

IMAP with an app password (Gmail: Google account -> Security -> App
passwords; most providers have the same). The inbox is opened read-only
(``EXAMINE``) and only ``BODY.PEEK`` is fetched: nothing is marked as read,
nothing is moved, nothing is ever sent. The one write is on request: a
reply *draft* in the Drafts folder ([[draft]] from the brain, see
secretary.py), which leaves only when the user sends it from their mail app.

What it reads is sorted without any brain:

* **bulk** (newsletters, notifications: ``List-Unsubscribe``,
  ``Precedence: bulk``, no-reply senders) vs **people**;
* **waiting**: from a person, not answered (``\\Answered``) for 3+ days;
* **parcels**: shipping and delivery notices ("in consegna oggi");
* **bills**: invoices, renewals, payments due.

Mail comes from anyone on the internet: whatever reaches a brain is framed as
data, and only headers and a short snippet ever leave this module.
"""

from __future__ import annotations

import email
import email.header
import email.utils
import imaplib
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from email.message import Message
from typing import Any, Callable

logger = logging.getLogger(__name__)

REFRESH_EVERY = 10 * 60
#: How far back the inbox is read.
DAYS_BACK = 14
MAX_MESSAGES = 80
WAITING_AFTER = 3 * 86400
SNIPPET = 240

_NOREPLY = re.compile(r"no-?reply|do-?not-?reply|notifications?@|newsletter|mailer-daemon|bounce|info@|news@|marketing", re.IGNORECASE)
_PARCEL = re.compile(
    r"\b(?:spedit[oa]|spedizione|in consegna|consegna prevista|consegnat[oa]|tracking|traccia(?:mento)?|corriere|pacco|ordine .{0,30}(?:inviato|partito)"
    r"|shipped|shipping|out for delivery|delivered|delivery|your package|parcel|tracking number|on its way)\b",
    re.IGNORECASE,
)
_TODAY_DELIVERY = re.compile(r"\b(?:in consegna oggi|consegna oggi|arriva oggi|out for delivery|arriving today|delivery today)\b", re.IGNORECASE)
_BILL = re.compile(
    r"\b(?:fattura|bolletta|scadenza (?:del )?pagamento|pagamento (?:in scadenza|richiesto)|rinnovo|abbonamento|addebito|ricevuta di pagamento"
    r"|invoice|bill(?:ing)?|payment (?:due|failed|reminder)|subscription|renew(?:al|s)?|receipt|charged)\b",
    re.IGNORECASE,
)


@dataclass
class Mail:
    uid: str
    sender: str
    address: str
    subject: str
    date: float
    snippet: str = ""
    seen: bool = False
    answered: bool = False
    bulk: bool = False
    kinds: list[str] = field(default_factory=list)

    @property
    def person(self) -> bool:
        return not self.bulk

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def decode(value: str | None) -> str:
    if not value:
        return ""
    parts = []
    for text, charset in email.header.decode_header(value):
        if isinstance(text, bytes):
            try:
                parts.append(text.decode(charset or "utf-8", errors="replace"))
            except LookupError:
                parts.append(text.decode("utf-8", errors="replace"))
        else:
            parts.append(text)
    return " ".join("".join(parts).split())


def strip_html(text: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;|&#160;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    return " ".join(text.split())


def body_snippet(message: Message, limit: int = SNIPPET) -> str:
    """The first words of the text part (the HTML one, stripped, if there's no plain text)."""
    plain, html = "", ""
    for part in message.walk() if message.is_multipart() else [message]:
        if part.get_content_maintype() != "text" or part.get_filename():
            continue
        try:
            payload = part.get_payload(decode=True) or b""
            text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except Exception:
            continue
        if part.get_content_subtype() == "plain" and not plain:
            plain = text
        elif part.get_content_subtype() == "html" and not html:
            html = strip_html(text)
    text = plain or html
    # Quoted replies and signatures add nothing.
    text = re.split(r"\n\s*(?:>|On .+ wrote:|Il giorno .+ ha scritto:|-- \n)", text, maxsplit=1)[0]
    text = " ".join(text.split())
    return text[:limit] + ("…" if len(text) > limit else "")


def classify(message: Message, sender: str, address: str, subject: str, snippet: str) -> tuple[bool, list[str]]:
    bulk = bool(
        message.get("List-Unsubscribe")
        or (message.get("Precedence") or "").lower() in ("bulk", "list", "junk")
        or (message.get("Auto-Submitted") or "no").lower() != "no"
        or _NOREPLY.search(address)
    )
    kinds = []
    text = f"{subject} {snippet}"
    if _PARCEL.search(text):
        kinds.append("parcel-today" if _TODAY_DELIVERY.search(text) else "parcel")
    if _BILL.search(text):
        kinds.append("bill")
    return bulk, kinds


def parse_message(uid: str, raw: bytes, flags: str) -> Mail | None:
    try:
        message = email.message_from_bytes(raw)
    except Exception:
        return None
    sender_name, address = email.utils.parseaddr(decode(message.get("From")))
    subject = decode(message.get("Subject"))[:200] or "(no subject)"
    try:
        stamp = email.utils.parsedate_to_datetime(message.get("Date")).timestamp()
    except Exception:
        stamp = time.time()
    snippet = body_snippet(message)
    bulk, kinds = classify(message, sender_name, address, subject, snippet)
    return Mail(
        uid=uid,
        sender=(sender_name or address.split("@")[0])[:80],
        address=address.lower()[:120],
        subject=subject,
        date=stamp,
        snippet=snippet,
        seen="\\Seen" in flags,
        answered="\\Answered" in flags,
        bulk=bulk,
        kinds=kinds,
    )


@dataclass
class MailConfig:
    host: str = ""
    user: str = ""
    password: str = ""
    port: int = 993
    folder: str = "INBOX"

    @property
    def ready(self) -> bool:
        return bool(self.host and self.user and self.password)


def guess_host(user: str) -> str:
    """The IMAP server of the common providers, from the address."""
    domain = user.rpartition("@")[2].lower()
    known = {
        "gmail.com": "imap.gmail.com",
        "googlemail.com": "imap.gmail.com",
        "outlook.com": "outlook.office365.com",
        "hotmail.com": "outlook.office365.com",
        "live.com": "outlook.office365.com",
        "yahoo.com": "imap.mail.yahoo.com",
        "yahoo.it": "imap.mail.yahoo.com",
        "libero.it": "imapmail.libero.it",
        "virgilio.it": "in.virgilio.it",
        "icloud.com": "imap.mail.me.com",
        "me.com": "imap.mail.me.com",
        "tiscali.it": "imap.tiscali.it",
        "aruba.it": "imaps.aruba.it",
        "fastwebnet.it": "imap.fastwebnet.it",
    }
    return known.get(domain, f"imap.{domain}" if domain else "")


def _connect(config: MailConfig) -> imaplib.IMAP4_SSL:
    client = imaplib.IMAP4_SSL(config.host, config.port, timeout=25)
    client.login(config.user, config.password)
    return client


def fetch(config: MailConfig, now: float | None = None) -> list[Mail]:
    """The last DAYS_BACK days of the inbox (blocking: call it in a thread)."""
    now = time.time() if now is None else now
    client = _connect(config)
    try:
        client.select(config.folder, readonly=True)
        since = time.strftime("%d-%b-%Y", time.gmtime(now - DAYS_BACK * 86400))
        status, data = client.uid("SEARCH", None, f"SINCE {since}")
        if status != "OK" or not data or not data[0]:
            return []
        uids = data[0].split()[-MAX_MESSAGES:]
        mails: list[Mail] = []
        for chunk in range(0, len(uids), 20):
            batch = b",".join(uids[chunk : chunk + 20]).decode()
            status, rows = client.uid("FETCH", batch, "(FLAGS BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.6000>)")
            if status != "OK":
                continue
            mails.extend(_parse_fetch(rows))
        mails.sort(key=lambda item: -item.date)
        return mails
    finally:
        try:
            client.logout()
        except Exception:
            pass


def _parse_fetch(rows: list[Any]) -> list[Mail]:
    """imaplib's FETCH answer: tuples (meta, bytes) per part, one message after the other."""
    found: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, tuple):
            continue
        meta = row[0].decode(errors="replace")
        uid = re.search(r"UID (\d+)", meta)
        if not uid:
            continue
        entry = found.setdefault(uid.group(1), {"flags": "", "header": b"", "text": b""})
        flags = re.search(r"FLAGS \(([^)]*)\)", meta)
        if flags:
            entry["flags"] = flags.group(1)
        if "HEADER" in meta:
            entry["header"] = row[1]
        elif "TEXT" in meta:
            entry["text"] = row[1]
    mails = []
    for uid, entry in found.items():
        mail = parse_message(uid, entry["header"] + b"\r\n" + entry["text"], entry["flags"])
        if mail:
            mails.append(mail)
    return mails


def check(config: MailConfig) -> str:
    """Logs in and out: "" if it works, otherwise what went wrong (for the panel)."""
    try:
        client = _connect(config)
        client.logout()
        return ""
    except imaplib.IMAP4.error as exc:
        return f"login refused: {exc}"[:200]
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"[:200]


def save_draft(config: MailConfig, to: str, subject: str, body: str) -> str:
    """Puts a reply draft in the Drafts folder; returns the folder's name. Never sends."""
    message = email.message.EmailMessage()
    message["From"] = config.user
    message["To"] = to
    message["Subject"] = subject
    message["Date"] = email.utils.formatdate(localtime=True)
    message.set_content(body)
    client = _connect(config)
    try:
        folder = _drafts_folder(client)
        client.append(folder, "(\\Draft)", imaplib.Time2Internaldate(time.time()), message.as_bytes())
        return folder
    finally:
        try:
            client.logout()
        except Exception:
            pass


def _drafts_folder(client: imaplib.IMAP4_SSL) -> str:
    """The folder marked \\Drafts (its name is localized: "[Gmail]/Bozze")."""
    status, rows = client.list()
    if status == "OK":
        for row in rows or []:
            line = row.decode(errors="replace") if isinstance(row, bytes) else str(row)
            if "\\Drafts" in line:
                name = line.rsplit(' "/" ', 1)[-1].rsplit(' "." ', 1)[-1].strip()
                return name if name.startswith('"') else f'"{name}"'
    return "Drafts"


class MailService:
    """Reads the inbox now and then and keeps what the secretary needs."""

    def __init__(self, config: Callable[[], MailConfig], clock: Callable[[], float] = time.time, fetcher: Callable[[MailConfig], list[Mail]] | None = None) -> None:
        self._config = config
        self.clock = clock
        self._fetch = fetcher or fetch
        self.mails: list[Mail] = []
        self.fetched_at: float | None = None
        self.error: str | None = None

    @property
    def configured(self) -> bool:
        return self._config().ready

    def config(self) -> MailConfig:
        return self._config()

    async def refresh(self, force: bool = False) -> list[Mail]:
        """Reads again if it's time; returns the mails that weren't there before."""
        import asyncio

        config = self._config()
        if not config.ready:
            self.mails, self.fetched_at, self.error = [], None, None
            return []
        now = self.clock()
        if not force and self.fetched_at and now - self.fetched_at < REFRESH_EVERY:
            return []
        try:
            mails = await asyncio.to_thread(self._fetch, config)
            self.error = None
        except Exception as exc:
            # Never the password: the exception's type and imaplib's short message.
            self.error = f"{type(exc).__name__}: {str(exc)[:120]}"
            logger.warning("Mail not read: %s", self.error)
            self.fetched_at = now
            return []
        known = {mail.uid for mail in self.mails}
        first = self.fetched_at is None
        self.mails, self.fetched_at = mails, now
        return [] if first else [mail for mail in mails if mail.uid not in known]

    # ------------------------------------------------------------ views
    def people(self, unread_only: bool = True) -> list[Mail]:
        return [mail for mail in self.mails if mail.person and (not unread_only or not mail.seen)]

    def waiting(self, now: float | None = None) -> list[Mail]:
        """From a person, not answered, 3 to 14 days old."""
        now = self.clock() if now is None else now
        return [mail for mail in self.mails if mail.person and not mail.answered and WAITING_AFTER <= now - mail.date <= DAYS_BACK * 86400]

    def of_kind(self, kind: str) -> list[Mail]:
        return [mail for mail in self.mails if kind in mail.kinds]

    def wrote_since(self, who: str, since: float) -> Mail | None:
        """A mail from ``who`` (name or address, partial) after ``since``: for the follow-ups."""
        who = who.lower().strip()
        if not who:
            return None
        for mail in self.mails:
            if mail.date >= since and (who in mail.address or who in mail.sender.lower()):
                return mail
        return None

    def summary(self) -> dict[str, Any]:
        unread = [mail for mail in self.mails if not mail.seen]
        return {
            "unread": len(unread),
            "people": len([mail for mail in unread if mail.person]),
            "waiting": len(self.waiting()),
            "parcels": len(self.of_kind("parcel")) + len(self.of_kind("parcel-today")),
            "bills": len(self.of_kind("bill")),
        }

    def status(self) -> dict[str, Any]:
        config = self._config()
        return {
            "configured": config.ready,
            "account": config.user if config.ready else "",
            "summary": self.summary(),
            "important": [mail.as_dict() for mail in self.people()[:12]],
            "waiting": [mail.as_dict() for mail in self.waiting()[:12]],
            "parcels": [mail.as_dict() for mail in (self.of_kind("parcel-today") + self.of_kind("parcel"))[:8]],
            "bills": [mail.as_dict() for mail in self.of_kind("bill")[:8]],
            "fetchedAt": self.fetched_at,
            "error": self.error,
        }

    def context(self, limit: int = 8) -> str:
        """For a brain: the important mails as data (headers and a short snippet)."""
        rows = []
        for mail in (self.people() or self.people(unread_only=False))[:limit]:
            when = time.strftime("%a %d %b %H:%M", time.localtime(mail.date))
            flags = ", ".join(filter(None, ["unread" if not mail.seen else "", "answered" if mail.answered else ""]))
            rows.append(f"- from {mail.sender} <{mail.address}>, {when}{' (' + flags + ')' if flags else ''}: «{mail.subject}» {mail.snippet[:160]}")
        return "\n".join(rows)
