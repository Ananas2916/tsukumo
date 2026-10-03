"""Tsukumo sul telefono, fuori casa: Tailscale + una pagina solo testo.

Il backend resta su 127.0.0.1. Ad aprirlo verso il telefono ci pensa
``tailscale serve``: HTTPS con un certificato vero, raggiungibile solo dai
dispositivi dello stesso account Tailscale. Davanti c'e' comunque il token di
``security.py``: il telefono lo riceve una volta, dal QR mostrato sul PC.

Il link e' ``https://<pc>.<tailnet>.ts.net/mobile.html#t=<token>``. Il token sta
dopo ``#``: il browser non lo manda mai al server (niente log, niente Referer),
lo legge la pagina e lo scambia con un cookie (``POST /api/phone/session``).
Safari, con "Aggiungi alla schermata Home", si tiene il link intero.
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

logger = logging.getLogger(__name__)

#: La pagina del telefono (frontend/mobile.html).
PAGE = "/mobile.html"
#: Dove ``tailscale serve`` chiede di abilitare HTTPS sul tailnet la prima volta.
_ENABLE_URL = re.compile(r"https://login\.tailscale\.com/\S+")


@dataclass
class Tailscale:
    """Quello che serve sapere di Tailscale su questo PC."""

    installed: bool = False
    running: bool = False
    #: ``pc.tail1234.ts.net`` (senza il punto finale), se acceso e collegato.
    hostname: str = ""
    #: ``tailscale serve`` gira gia' verso il nostro backend.
    serving: bool = False
    #: Aperto a tutta Internet con Funnel (resta protetto dal token).
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
        # Quello che ha scritto finora (es. il link per abilitare HTTPS) serve.
        return -1, (exc.output or b"").decode("utf-8", "replace")
    return result.returncode, result.stdout.decode("utf-8", "replace")


async def _run(cli: str, *args: str, timeout: float = 8.0) -> tuple[int, str]:
    """Lancia la CLI di Tailscale (parla solo col servizio locale)."""
    return await asyncio.to_thread(_run_sync, cli, args, timeout)


def _proxies_to(handlers: dict[str, Any], port: int) -> bool:
    """Un handler di ``serve`` che inoltra a ``127.0.0.1:<port>`` o ``localhost:<port>``."""
    for handler in handlers.values():
        target = str((handler or {}).get("Proxy") or "").rstrip("/")
        if re.fullmatch(rf"(https?://)?(127\.0\.0\.1|localhost):{port}", target):
            return True
    return False


async def tailscale_status(port: int) -> Tailscale:
    cli = tailscale_cli()
    if cli is None:
        return Tailscale(detail="Tailscale non e' installato su questo PC.")
    info = Tailscale(installed=True)
    try:
        code, output = await _run(cli, "status", "--json")
        status = json.loads(output) if code == 0 or output.lstrip().startswith("{") else {}
    except (OSError, ValueError) as exc:
        info.detail = f"Tailscale non risponde: {exc}"
        return info
    if status.get("BackendState") != "Running":
        info.detail = "Tailscale e' spento o non hai fatto l'accesso."
        return info
    info.running = True
    info.hostname = str((status.get("Self") or {}).get("DNSName") or "").rstrip(".").lower()
    if not info.hostname:
        info.detail = "Tailscale non ha dato un nome a questo PC (MagicDNS spento?)."
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
    """``tailscale serve --bg``: HTTPS sul nome del PC -> il backend, solo nel tailnet."""
    cli = tailscale_cli()
    if cli is None:
        return False, "Tailscale non e' installato."
    code, output = await _run(cli, "serve", "--bg", f"http://127.0.0.1:{port}", timeout=20.0)
    if code == 0:
        return True, ""
    enable = _ENABLE_URL.search(output)
    if enable:
        # Prima volta: Tailscale vuole che HTTPS sia abilitato sul tailnet.
        return False, f"Abilita HTTPS su Tailscale da questo link, poi riprova: {enable.group(0)}"
    return False, output.strip()[-400:] or "tailscale serve non e' partito."


def phone_link(hostname: str, token: str) -> str:
    return f"https://{hostname}{PAGE}#t={token}"


def qr_svg(text: str) -> str:
    import segno

    return segno.make(text, error="m").svg_inline(scale=6, border=3, dark="#111115", light="#ffffff")


# ----------------------------------------------------------------------
# La pagina sul PC (GET /api/phone): niente JavaScript, la CSP non lo
# permetterebbe inline e non serve. Un solo modulo per attivare serve.

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
        '<!doctype html><html lang="it"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>Tsukumo sul telefono</title>"
        f"<style>{_STYLE}</style></head><body><main>{body}</main></body></html>"
    )


def _linkify(text: str) -> str:
    escaped = html.escape(text)
    return _ENABLE_URL.sub(lambda m: f'<a href="{m.group(0)}" target="_blank" rel="noreferrer">{m.group(0)}</a>', escaped)


def render_page(info: Tailscale, token: str, message: str = "") -> str:
    head = "<h1>Tsukumo sul telefono</h1><p>Chat solo testo, anche fuori casa.</p>"
    note = f'<p class="bad">{_linkify(message)}</p>' if message else ""
    if not info.installed or not info.running or not info.hostname:
        steps = (
            "<ol>"
            '<li>Installa Tailscale sul PC (<a href="https://tailscale.com/download/windows" target="_blank" '
            'rel="noreferrer">tailscale.com/download</a>) e fai l\'accesso.</li>'
            "<li>Sull'iPhone installa l'app Tailscale dall'App Store, con lo stesso account.</li>"
            "<li>Ricarica questa pagina.</li>"
            "</ol>"
        )
        return _page(f'{head}<p class="warn">{html.escape(info.detail)}</p>{steps}{note}')
    if not info.serving:
        form = (
            '<form method="post" action="/api/phone/serve"><button type="submit">Attiva l\'accesso dal telefono</button></form>'
            f"<p><small>Esegue <code>tailscale serve --bg</code>: Tsukumo diventa raggiungibile su "
            f"<code>https://{html.escape(info.hostname)}</code>, solo dai tuoi dispositivi Tailscale.</small></p>"
        )
        return _page(f"{head}{note}{form}")
    link = phone_link(info.hostname, token)
    funnel = (
        '<p class="warn">Funnel e\' attivo: il link e\' raggiungibile da tutta Internet, protetto solo dal token.</p>'
        if info.funnel
        else ""
    )
    steps = (
        "<ol>"
        "<li>Sull'iPhone tieni acceso Tailscale.</li>"
        "<li>Inquadra il QR con la Fotocamera e apri il link in Safari.</li>"
        "<li>Condividi &rarr; <b>Aggiungi alla schermata Home</b>.</li>"
        "</ol>"
    )
    return _page(
        f'{head}{note}<div class="qr">{qr_svg(link)}</div>{steps}{funnel}'
        "<p><small>Il QR contiene la chiave di accesso: non fotografarlo e non mandarlo in chat. "
        "Per invalidarlo cancella <code>state/access_token</code> e riavvia Tsukumo.</small></p>"
    )
