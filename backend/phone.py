"""Tsukumo on the phone, away from home: Tailscale + a text-only page.

The backend stays on 127.0.0.1. Opening it to the phone is done by
``tailscale serve``: HTTPS with a real certificate, reachable only from the
devices of the same Tailscale account. In front there's still
``security.py``'s token: the phone gets it once, from the QR code shown on
the PC.

The link is ``https://<pc>.<tailnet>.ts.net/mobile.html#t=<token>``. The token
is after ``#``: the browser never sends it to the server (no logs, no
Referer), the page reads it and trades it for a cookie
(``POST /api/phone/session``). Safari, with "Add to Home Screen", keeps the
whole link.
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .languages import system_language

logger = logging.getLogger(__name__)

#: The phone's page (frontend/mobile.html).
PAGE = "/mobile.html"
#: Where ``tailscale serve`` asks to enable HTTPS on the tailnet the first time.
_ENABLE_URL = re.compile(r"https://login\.tailscale\.com/\S+")


@dataclass
class Tailscale:
    """What there is to know about Tailscale on this PC."""

    installed: bool = False
    running: bool = False
    #: ``pc.tail1234.ts.net`` (without the final dot), if on and connected.
    hostname: str = ""
    #: ``tailscale serve`` is already running towards our backend.
    serving: bool = False
    #: Open to the whole Internet with Funnel (it stays protected by the token).
    funnel: bool = False
    detail: str = ""


def tailscale_cli() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            candidate = Path(base or "C:/Program Files") / "Tailscale" / "tailscale.exe"
            if candidate.is_file():
                return str(candidate)
    return None


def _run_sync(cli: str, args: tuple[str, ...], timeout: float) -> tuple[int, str]:
    try:
        result = subprocess.run(
            [cli, *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as exc:
        # What it has written so far (e.g. the link to enable HTTPS) is useful.
        return -1, (exc.output or b"").decode("utf-8", "replace")
    return result.returncode, result.stdout.decode("utf-8", "replace")


async def _run(cli: str, *args: str, timeout: float = 8.0) -> tuple[int, str]:
    """Runs Tailscale's CLI (it talks only to the local service)."""
    return await asyncio.to_thread(_run_sync, cli, args, timeout)


def _proxies_to(handlers: dict[str, Any], port: int) -> bool:
    """A ``serve`` handler that forwards to ``127.0.0.1:<port>`` or ``localhost:<port>``."""
    for handler in handlers.values():
        target = str((handler or {}).get("Proxy") or "").rstrip("/")
        if re.fullmatch(rf"(https?://)?(127\.0\.0\.1|localhost):{port}", target):
            return True
    return False


#: The page and the messages, in the PC's language (Italian on an Italian PC, English otherwise).
#: Markup here is ours; anything coming from Tailscale is escaped where it's used.
_WORDS = {
    "en": {
        "not_installed_pc": "Tailscale is not installed on this PC.",
        "not_installed": "Tailscale is not installed.",
        "not_answering": "Tailscale isn't answering: {error}",
        "off": "Tailscale is off or you haven't signed in.",
        "no_name": "Tailscale didn't give this PC a name (MagicDNS off?).",
        "enable_https": "Enable HTTPS on Tailscale from this link, then try again: {url}",
        "serve_failed": "tailscale serve didn't start.",
        "title": "Tsukumo on the phone",
        "subtitle": "Text-only chat, away from home too.",
        "step_install_pc": 'Install Tailscale on the PC (<a href="https://tailscale.com/download/windows" target="_blank" rel="noreferrer">tailscale.com/download</a>) and sign in.',
        "step_install_phone": "On the iPhone install the Tailscale app from the App Store, with the same account.",
        "step_reload": "Reload this page.",
        "turn_on": "Turn on access from the phone",
        "turn_on_hint": "Runs <code>tailscale serve --bg</code>: Tsukumo becomes reachable at <code>https://{host}</code>, only from your Tailscale devices.",
        "funnel": "Funnel is on: the link is reachable from the whole Internet, protected only by the token.",
        "step_keep_on": "On the iPhone keep Tailscale on.",
        "step_scan": "Scan the QR code with the Camera and open the link in Safari.",
        "step_home": "Share &rarr; <b>Add to Home Screen</b>.",
        "secret": "The QR code holds the access key: don't photograph it or send it in a chat. To revoke it delete <code>state/access_token</code> and restart Tsukumo.",
    },
    "it": {
        "not_installed_pc": "Tailscale non è installato su questo PC.",
        "not_installed": "Tailscale non è installato.",
        "not_answering": "Tailscale non risponde: {error}",
        "off": "Tailscale è spento o non hai fatto l'accesso.",
        "no_name": "Tailscale non ha dato un nome a questo PC (MagicDNS spento?).",
        "enable_https": "Abilita HTTPS su Tailscale da questo link, poi riprova: {url}",
        "serve_failed": "tailscale serve non è partito.",
        "title": "Tsukumo sul telefono",
        "subtitle": "Chat solo testo, anche fuori casa.",
        "step_install_pc": 'Installa Tailscale sul PC (<a href="https://tailscale.com/download/windows" target="_blank" rel="noreferrer">tailscale.com/download</a>) e fai l\'accesso.',
        "step_install_phone": "Sull'iPhone installa l'app Tailscale dall'App Store, con lo stesso account.",
        "step_reload": "Ricarica questa pagina.",
        "turn_on": "Attiva l'accesso dal telefono",
        "turn_on_hint": "Esegue <code>tailscale serve --bg</code>: Tsukumo diventa raggiungibile su <code>https://{host}</code>, solo dai tuoi dispositivi Tailscale.",
        "funnel": "Funnel è attivo: il link è raggiungibile da tutta Internet, protetto solo dal token.",
        "step_keep_on": "Sull'iPhone tieni acceso Tailscale.",
        "step_scan": "Inquadra il QR con la Fotocamera e apri il link in Safari.",
        "step_home": "Condividi &rarr; <b>Aggiungi alla schermata Home</b>.",
        "secret": "Il QR contiene la chiave di accesso: non fotografarlo e non mandarlo in chat. Per invalidarlo cancella <code>state/access_token</code> e riavvia Tsukumo.",
    },
}


def _language() -> str:
    return "it" if system_language() == "it" else "en"


def _t(key: str, **values: object) -> str:
    return _WORDS[_language()][key].format(**values)


async def tailscale_status(port: int) -> Tailscale:
    cli = tailscale_cli()
    if cli is None:
        return Tailscale(detail=_t("not_installed_pc"))
    info = Tailscale(installed=True)
    try:
        code, output = await _run(cli, "status", "--json")
        status = json.loads(output) if code == 0 or output.lstrip().startswith("{") else {}
    except (OSError, ValueError) as exc:
        info.detail = _t("not_answering", error=exc)
        return info
    if status.get("BackendState") != "Running":
        info.detail = _t("off")
        return info
    info.running = True
    info.hostname = str((status.get("Self") or {}).get("DNSName") or "").rstrip(".").lower()
    if not info.hostname:
        info.detail = _t("no_name")
        return info
    try:
        _, output = await _run(cli, "serve", "status", "--json")
        serve = json.loads(output) if output.strip().startswith("{") else {}
    except (OSError, ValueError):
        serve = {}
    web = serve.get("Web") or {}
    site = web.get(f"{info.hostname}:443") or {}
    info.serving = _proxies_to(site.get("Handlers") or {}, port)
    info.funnel = bool((serve.get("AllowFunnel") or {}).get(f"{info.hostname}:443"))
    return info


async def start_serve(port: int) -> tuple[bool, str]:
    """``tailscale serve --bg``: HTTPS on the PC's name -> the backend, only in the tailnet."""
    cli = tailscale_cli()
    if cli is None:
        return False, _t("not_installed")
    code, output = await _run(cli, "serve", "--bg", f"http://127.0.0.1:{port}", timeout=20.0)
    if code == 0:
        return True, ""
    enable = _ENABLE_URL.search(output)
    if enable:
        # First time: Tailscale wants HTTPS to be enabled on the tailnet.
        return False, _t("enable_https", url=enable.group(0))
    return False, output.strip()[-400:] or _t("serve_failed")


def phone_link(hostname: str, token: str) -> str:
    return f"https://{hostname}{PAGE}#t={token}"


def qr_svg(text: str) -> str:
    import segno

    return segno.make(text, error="m").svg_inline(scale=6, border=3, dark="#111115", light="#ffffff")


# ----------------------------------------------------------------------
# The page on the PC (GET /api/phone): no JavaScript, the CSP wouldn't
# allow it inline and it isn't needed. A single form to turn serve on.

_STYLE = """
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111115;
       color: #ececf1; font: 15px/1.5 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; }
main { width: min(440px, calc(100vw - 32px)); padding: 28px; border-radius: 20px; background: #1a1a20;
       border: 1px solid rgba(255,255,255,.08); box-shadow: 0 18px 50px rgba(0,0,0,.45); }
h1 { margin: 0 0 4px; font-size: 22px; }
p, li { color: #b4b4c0; }
ol { padding-left: 20px; }
.qr { display: grid; place-items: center; margin: 18px 0; }
.qr svg { width: 100%; max-width: 300px; height: auto; border-radius: 14px; }
.warn { color: #f5c451; }
.bad { color: #ff6b81; }
code { font-family: 'Cascadia Code', Consolas, monospace; font-size: 13px; color: #ececf1;
       background: #22222a; padding: 2px 6px; border-radius: 6px; word-break: break-all; }
button { font: inherit; color: #fff; border: 0; border-radius: 12px; padding: 10px 18px; cursor: pointer;
         background: linear-gradient(135deg, #8f7bff 0%, #b98cf5 55%, #e89bd8 100%); }
a { color: #a58bff; }
small { color: #85858f; }
"""


def _page(body: str) -> str:
    return (
        f'<!doctype html><html lang="{_language()}"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{html.escape(_t('title'))}</title>"
        f"<style>{_STYLE}</style></head><body><main>{body}</main></body></html>"
    )


def _linkify(text: str) -> str:
    escaped = html.escape(text)
    return _ENABLE_URL.sub(lambda m: f'<a href="{m.group(0)}" target="_blank" rel="noreferrer">{m.group(0)}</a>', escaped)


def render_page(info: Tailscale, token: str, message: str = "") -> str:
    head = f"<h1>{_t('title')}</h1><p>{_t('subtitle')}</p>"
    note = f'<p class="bad">{_linkify(message)}</p>' if message else ""
    if not info.installed or not info.running or not info.hostname:
        steps = f"<ol><li>{_t('step_install_pc')}</li><li>{_t('step_install_phone')}</li><li>{_t('step_reload')}</li></ol>"
        return _page(f'{head}<p class="warn">{html.escape(info.detail)}</p>{steps}{note}')
    if not info.serving:
        form = (
            f'<form method="post" action="/api/phone/serve"><button type="submit">{_t("turn_on")}</button></form>'
            f"<p><small>{_t('turn_on_hint', host=html.escape(info.hostname))}</small></p>"
        )
        return _page(f"{head}{note}{form}")
    link = phone_link(info.hostname, token)
    funnel = f'<p class="warn">{_t("funnel")}</p>' if info.funnel else ""
    steps = f"<ol><li>{_t('step_keep_on')}</li><li>{_t('step_scan')}</li><li>{_t('step_home')}</li></ol>"
    return _page(f'{head}{note}<div class="qr">{qr_svg(link)}</div>{steps}{funnel}<p><small>{_t("secret")}</small></p>')
