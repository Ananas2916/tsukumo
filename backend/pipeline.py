"""Orchestrazione: testo utente -> cervello -> frasi -> voce -> visemi -> frontend.

Il punto chiave e' che non aspettiamo la fine della risposta del cervello:
appena una frase e' completa la mandiamo alla voce, ne estraiamo la timeline
dei visemi e la spediamo al frontend. Il companion inizia quindi a parlare
mentre il modello (o l'agente) sta ancora scrivendo il resto.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from collections import Counter, deque
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime
from typing import Any

from .attachments import Attachment, default_prompt, prepare, with_contents, with_paths
from .audio import encode_wav_base64
from .config import Settings
from .languages import reply_language, short_language, speech_directive
from .memory import MemoryStore, fact_from_tag, memory_command
from .llm import LLMClient, Message, MockLLM, create_llm_client, describe_error
from .llm.base import Activity
from .phonemes import phones_for
from .reminders import ReminderStore, TagFilter, action_directive, command_reply, confirmation, from_tag, parse_request
from .providers import LLM_REGISTRY
from .stt import SAMPLE_RATE as STT_SAMPLE_RATE
from .stt import STTEngine, Transcript, create_stt_engine, from_pcm16
from .tts import TTSEngine, build_tts_engine, create_tts_engine
from .visemes import build_timeline
from .vocals import vocal_line

logger = logging.getLogger(__name__)

#: Callback usata per spedire un messaggio al frontend.
Emit = Callable[[dict[str, Any]], Awaitable[None]]

#: Quanti versetti tenere in memoria (poche decine di KB ciascuno).
VOCAL_CACHE_SIZE = 64

#: Un agente che lavora in silenzio dice "un attimo" dopo questi secondi,
#: e "ancora un pochino" se il silenzio continua. Una volta ciascuno per turno.
WORKING_CUES = ((7.0, "working"), (45.0, "working_long"))

#: Per quanto tempo una frase detta da lei puo' tornare indietro dal
#: microfono (l'audio parte dopo la sintesi e le frasi si mettono in coda).
ECHO_WINDOW_S = 45.0
#: Quota di parole della trascrizione gia' dette da lei oltre la quale e' eco.
ECHO_OVERLAP = 0.7
_WORD = re.compile(r"\w+", re.UNICODE)

# Emoji e pittogrammi. Kokoro li pronuncerebbe per nome ("smiling face with
# smiling eyes"), e gli agenti ne usano parecchie: la loro personalita' non passa
# dal nostro system prompt, quindi non basta chiedergli di evitarle.
_EMOJI_CHARS = (
    "\U0001F000-\U0001FAFF"  # emoticon, pittogrammi, trasporti, bandiere, ...
    "\U0001FB00-\U0001FBFF"
    "\u2190-\u21FF"  # frecce
    "\u2300-\u23FF"  # simboli tecnici: orologi, clessidre, ...
    "\u25A0-\u25FF"  # forme geometriche: triangoli "play", quadratini
    "\u2600-\u27BF"  # simboli vari e dingbat: sole, cuori, stelline, spunte
    "\u2900-\u297F\u2B00-\u2BFF"  # altre frecce, stelle
    "\u203C\u2049\u3030\u303D\u3297\u3299"
    "\uFE00-\uFE0F\u200D\u20E3"  # selettori di variante, ZWJ, keycap
    "\U000E0020-\U000E007F"  # tag delle bandiere regionali
)
_EMOJI = re.compile(f"[{_EMOJI_CHARS}]+")
# Faccine testuali: ":)", ";-)", ":D", "xD", "<3", "^_^". Mai attaccate a una
# parola, cosi' "10:30", "C:/" o "https://" restano intatti.
_EMOTICON = re.compile(r"(?<![\w:/])(?:[:;=][-'^]?[)(\]\[DPpOo3/\\|*]+|<3+|\^[_.-]?\^|[xX]D+)(?!\w)")
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.!?;:…])")

# Fine frase: punteggiatura forte seguita da spazio/fine, oppure a capo. Le
# emoji subito dopo la punteggiatura ("Che bello! 😊") restano con la frase
# che commentano, non finiscono in testa alla successiva.
_TRAILING_EMOJI = rf"(?:\s*[{_EMOJI_CHARS}]+)*"
_SENTENCE_END = re.compile(
    rf"([.!?…]+[\"')\]]*{_TRAILING_EMOJI}\s+|[.!?…]+[\"')\]]*{_TRAILING_EMOJI}$|\n+)"
)
# Punti di taglio "morbidi" per spezzare una frase troppo lunga.
_SOFT_BREAK = re.compile(r"[,;:—–]\s+")
# Ripulitura del markdown che a volte sfugge all'LLM (verrebbe letto ad alta voce).
_MARKDOWN = re.compile(r"[*_`#>]+")
_MULTISPACE = re.compile(r"[ \t]+")

# Umore suggerito dalle emoji: diventa l'espressione del viso mentre il
# personaggio pronuncia la frase, invece di andare perso insieme alle emoji.
_MOODS = {
    "happy": "😀😃😄😁😆😂🤣😊☺🥰😍🤩😘😻😸😹😺🤗🥳🎉🎊💖💕💗💓💞💝❤♥🧡💛💚💙💜👍👏🙌",
    "relaxed": "🙂😉😌😇😏🤭😋😛😜😝😎✨🌸🌟⭐",
    "surprised": "😮😯😲😳🤯😱😵😦😧🙀‼⁉❗",
    "sad": "😢😭😞😔😟🙁☹😿💔😥😓😪😩😫🥺😕",
    "angry": "😠😡🤬👿💢😤😾",
}
_MOOD_OF = {char: mood for mood, chars in _MOODS.items() for char in chars}


def clean_markup(text: str) -> str:
    """Toglie markdown e spazi ridondanti, ma lascia le emoji (servono all'umore)."""
    cleaned = _MARKDOWN.sub(" ", text or "")
    cleaned = cleaned.replace("’", "'").replace("“", '"').replace("”", '"')
    return _MULTISPACE.sub(" ", cleaned).strip()


def strip_emoji(text: str) -> str:
    """Toglie emoji e faccine testuali, sistemando gli spazi rimasti."""
    cleaned = _EMOTICON.sub(" ", _EMOJI.sub(" ", text or ""))
    cleaned = _MULTISPACE.sub(" ", cleaned)
    return _SPACE_BEFORE_PUNCT.sub(r"\1", cleaned).strip()


def clean_for_speech(text: str) -> str:
    """Quello che resta dopo questa funzione viene pronunciato così com'e'."""
    return strip_emoji(clean_markup(text))


def _emoticon_mood(token: str) -> str | None:
    face = token.replace("-", "").replace("'", "")
    if face.startswith("<3") or "^" in face or face[0] in "xX" or face.endswith("D"):
        return "happy"
    mouth = face[-1]
    if mouth in ")]3*Pp":
        return "relaxed"
    if mouth in "([":
        return "sad"
    if mouth in "oO":
        return "surprised"
    return None


def detect_mood(text: str) -> str | None:
    """L'umore prevalente fra le emoji della frase, o ``None`` se non ce ne sono."""
    votes: Counter[str] = Counter()
    for match in _EMOJI.finditer(text or ""):
        for char in match.group():
            mood = _MOOD_OF.get(char)
            if mood:
                votes[mood] += 1
    for match in _EMOTICON.finditer(text or ""):
        mood = _emoticon_mood(match.group())
        if mood:
            votes[mood] += 1
    # A parita' vince la prima emoji comparsa (Counter conserva l'ordine).
    return votes.most_common(1)[0][0] if votes else None


_SCREEN = re.compile(
    r"\b(?:guarda|vedi|leggi|controlla|dai un'?\s?occhiata a(?:l|llo)?|cosa c'?\s?è|che c'?\s?è|cosa vedi|look at|see|check|read|what'?s on|what is on)\b"
    r"[^.?!]{0,40}\b(?:schermo|monitor|display|screen)\b|\bscreenshot\b",
    re.IGNORECASE,
)


def wants_screen(text: str) -> bool:
    """"guarda il mio schermo", "cosa vedi sullo schermo?", "look at my screen"."""
    return bool(_SCREEN.search(text))


def split_sentences(text: str, max_chars: int = 220) -> list[str]:
    """Divide il testo in frasi pronunciabili, senza superare ``max_chars``.

    Le emoji restano dentro le frasi: le toglie ``_build_speech`` subito prima
    della sintesi, dopo averne ricavato l'umore.
    """
    source = clean_markup(text)
    if not source:
        return []

    raw: list[str] = []
    cursor = 0
    for match in _SENTENCE_END.finditer(source):
        chunk = source[cursor : match.end()].strip()
        if chunk:
            raw.append(chunk)
        cursor = match.end()
    tail = source[cursor:].strip()
    if tail:
        raw.append(tail)

    sentences: list[str] = []
    for chunk in raw:
        if len(chunk) <= max_chars:
            sentences.append(chunk)
            continue
        sentences.extend(_split_long(chunk, max_chars))

    # Unisce i frammenti minuscoli ("Ok.") alla frase successiva.
    merged: list[str] = []
    for sentence in sentences:
        if merged and len(merged[-1]) < 24 and len(merged[-1]) + len(sentence) + 1 <= max_chars:
            merged[-1] = f"{merged[-1]} {sentence}"
        else:
            merged.append(sentence)
    return merged


def first_clause(text: str, min_chars: int = 28, max_chars: int = 140) -> tuple[str, str] | None:
    """Il primo inciso di una frase ancora a meta', se e' abbastanza lungo.

    La prima frase di una risposta decide quanto aspetti prima di sentirla:
    se il cervello scrive "Allora, ho guardato il meteo di domani e..." la
    voce puo' partire dalla prima virgola invece di aspettare il punto.
    Restituisce ``(inciso, resto)`` oppure ``None``.
    """
    for match in _SOFT_BREAK.finditer(text):
        if match.start() > max_chars:
            return None
        if match.start() >= min_chars:
            head = text[: match.start() + 1].strip()
            if clean_markup(head):
                return head, text[match.end() :]
    return None


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _ms(moment: float | None, started: float) -> int | None:
    return None if moment is None else int((moment - started) * 1000)


def _split_long(chunk: str, max_chars: int) -> list[str]:
    """Spezza una frase lunga su virgole, altrimenti su spazi."""
    pieces: list[str] = []
    current = ""
    for part in _SOFT_BREAK.split(chunk):
        candidate = f"{current} {part}".strip() if current else part
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                pieces.append(current)
            current = part
    if current:
        pieces.append(current)

    # Se anche cosi' resta troppo lungo, taglio duro sugli spazi.
    result: list[str] = []
    for piece in pieces:
        while len(piece) > max_chars:
            cut = piece.rfind(" ", 0, max_chars)
            if cut <= 0:
                cut = max_chars
            result.append(piece[:cut].strip())
            piece = piece[cut:].strip()
        if piece:
            result.append(piece)
    return result


class Companion:
    """Stato e logica del personaggio: storia conversazione, motori, visemi."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.tts: TTSEngine = create_tts_engine(settings)
        self.llm: LLMClient = create_llm_client(settings)
        # None quando l'input vocale e' spento o lo fa il browser: chi lo usa
        # deve sempre controllare prima.
        self.stt: STTEngine | None = create_stt_engine(settings)
        self._fallback_llm = MockLLM() if settings.llm_fallback_to_mock else None
        self.history: list[Message] = []
        self._turn_id = 0
        # Una sola pipeline alla volta: due voci sovrapposte sarebbero illeggibili.
        self._turn_lock = asyncio.Lock()
        self._cancel = asyncio.Event()
        self._tts_failed = False
        #: Il turno in corso ha gia' detto (o scritto nella bolla) qualcosa.
        self._turn_voiced = False
        #: Quando e' uscita la prima voce del turno (per misurare l'attesa).
        self._first_voice_at: float | None = None
        #: Le ultime frasi dette, con l'ora: per riconoscere la sua eco nel microfono.
        self._recent_speech: deque[tuple[float, str]] = deque(maxlen=16)
        #: Una sintesi alla volta: due frasi insieme sulla stessa GPU si
        #: rallentano a vicenda, e non tutti i motori reggono due thread.
        self._tts_lock = asyncio.Lock()
        # Scelte fatte a caldo dal pannello: valgono finche' il backend resta acceso.
        # Le voci sono del motore: DC_VOICE (una voce Kokoro) vale solo per Kokoro.
        self.voice = self.tts.default_voice or settings.voice
        self.reply_language = settings.reply_language
        #: Muta: il testo arriva comunque (bolla e chat), ma senza sintesi.
        #: Con una voce a consumo non spende nemmeno un carattere.
        self.muted = False
        #: Ultimo errore per motore ("llm", "tts"), finche' un turno non va bene.
        self.last_errors: dict[str, str] = {}
        #: Catalogo delle voci del motore attivo, caricato in background.
        self.voice_list: list[dict[str, Any]] | None = None
        #: Versetti gia' sintetizzati, per (motore, voce, frase): vedi vocal().
        self._vocals: dict[tuple[str, str, str], dict[str, Any]] = {}
        #: La voce l'ha scelta qualcuno (.env o pannello): la lingua del sistema non la tocca.
        self.voice_chosen = settings.voice_explicit
        #: Timer e promemoria (li collega il server). Senza, niente "Alexa".
        self.reminders: ReminderStore | None = None
        #: Avvisa il server quando i promemoria cambiano (pannello, pianificatore).
        self.on_reminders_changed: Callable[[], Awaitable[None]] | None = None
        #: Personalita' e ricordi, uguali per ogni cervello (li collega il server).
        self.memory: MemoryStore | None = None
        #: Avvisa il server quando un ricordo entra o esce (per il pannello).
        self.on_memory_changed: Callable[[], Awaitable[None]] | None = None
        #: Chiede lo screenshot alla shell (vero se qualcuno puo' farlo): "guarda lo schermo".
        self.screen_capture: Callable[[str], Awaitable[bool]] | None = None

    # ------------------------------------------------------------------
    # Motori
    # ------------------------------------------------------------------
    @property
    def llm_label(self) -> str:
        spec = LLM_REGISTRY.get(self.settings.selected("llm"))
        return spec.label if spec else self.llm.name

    async def load_voices(self) -> list[dict[str, Any]]:
        """Carica (in un thread: puo' fare rete) l'elenco delle voci del motore.

        Se nessuno ha scelto una voce, sceglie quella nella lingua del sistema.
        """
        catalog = await asyncio.to_thread(self.tts.voice_catalog)
        self.voice_list = [voice.as_dict() for voice in catalog]
        if not self.voice_chosen:
            picked = self.tts.voice_for_language(self.settings.system_language, catalog)
            if picked and picked != self.voice:
                logger.info("Lingua del sistema %r: parlo con la voce %s", self.settings.system_language, picked)
                self.voice = picked
        return self.voice_list

    def replace_engine(self, kind: str, settings: Settings) -> object | None:
        """Sostituisce un solo motore, tenendo la conversazione.

        Bloccante (carica modelli, fa rete): va chiamata in un thread. Solleva
        se il motore nuovo non parte, lasciando attivo quello di prima; se va
        bene restituisce il vecchio, da chiudere. A differenza dell'avvio qui
        non si ripiega sulla voce di servizio: se hai sbagliato chiave devi
        saperlo subito, non sentire una voce robotica.
        """
        old: object | None
        if kind == "llm":
            new_llm = create_llm_client(settings)
            old, self.llm = self.llm, new_llm
            self.last_errors.pop("llm", None)
        elif kind == "tts":
            new_tts = build_tts_engine(settings.selected("tts"), settings)
            old, self.tts = self.tts, new_tts
            self.voice = new_tts.default_voice or settings.voice
            self.voice_list = None
            self._vocals.clear()
            self.voice_chosen = settings.voice_explicit
            self.last_errors.pop("tts", None)
        elif kind == "stt":
            old, self.stt = self.stt, create_stt_engine(settings)
        else:
            raise ValueError(f"Tipo di motore sconosciuto: {kind!r}")
        self.settings = settings
        self._fallback_llm = MockLLM() if settings.llm_fallback_to_mock else None
        return old

    # ------------------------------------------------------------------
    # API pubblica
    # ------------------------------------------------------------------
    async def chat(
        self,
        text: str,
        emit: Emit,
        *,
        hidden: bool = False,
        files: list[str] | None = None,
        screen: bool = False,
    ) -> str:
        """Ciclo completo: cervello in streaming + sintesi frase per frase.

        ``hidden``: il messaggio non viene dall'utente (un'azione programmata, un
        commento spontaneo) e non compare in chat; la risposta si'.
        ``files``: percorsi di file allegati (trascinati su di lei, screenshot);
        ``screen`` dice che l'allegato e' lo schermo.
        """
        attachments = prepare(files)
        prompt = (text or "").strip()
        if not prompt and attachments:
            prompt = default_prompt(attachments, self.voice_language, screen)
        if not prompt:
            return ""
        # "Guarda lo schermo": lo screenshot lo fa la shell, che poi rimanda
        # qui lo stesso messaggio con l'immagine allegata.
        if not hidden and not attachments and self.screen_capture is not None and wants_screen(prompt):
            if await self.screen_capture(prompt):
                return ""

        async with self._turn_lock:
            self._cancel.clear()
            self._turn_id += 1
            turn = self._turn_id
            started = time.perf_counter()
            self._tts_failed = False
            self._turn_voiced = False
            self._first_voice_at = None
            first_token_at: float | None = None

            await emit({"type": "state", "value": "thinking", "turn": turn})
            if not hidden:
                files_info = [{"name": item.name, "kind": item.kind} for item in attachments]
                await emit({"type": "user", "text": prompt, "turn": turn, "files": files_info, "screen": screen})
                # Timer e promemoria che si capiscono da soli: risposta immediata.
                local = None if attachments else await self._local_reply(prompt)
                if local is not None:
                    return await self._finish_local(prompt, local, emit, turn, started)

            messages = self._build_messages(prompt, attachments)
            buffer = ""
            full_reply = ""
            spoken = 0
            failed = False
            tags = TagFilter()
            # Mentre l'agente lavora: i suoi tool diventano eventi "working",
            # e se tace a lungo dice "un attimo" con la voce in uso.
            steps: list[dict[str, str]] = []
            activities: asyncio.Queue[Activity] = asyncio.Queue()
            self.llm.on_activity = activities.put_nowait
            helpers = [asyncio.create_task(self._pump_activities(activities, steps, emit, turn))]
            if self.llm.stateful:
                helpers.append(asyncio.create_task(self._working_cues(emit, turn)))

            try:
                async for raw_piece in self._cancellable(self._stream_with_fallback(messages, emit)):
                    # Le etichette [[remind ...]] non si leggono ne' si mostrano.
                    piece = tags.feed(raw_piece)
                    if not piece:
                        continue
                    buffer += piece
                    full_reply += piece
                    if first_token_at is None:
                        first_token_at = time.perf_counter()
                    await emit({"type": "token", "text": piece, "turn": turn})

                    # Ogni volta che il buffer contiene almeno una frase intera
                    # la stacchiamo e la mandiamo subito in sintesi.
                    sentences = split_sentences(buffer, self.settings.max_sentence_chars)
                    if spoken == 0 and len(sentences) == 1:
                        # Prima frase ancora a meta': si parte dal primo inciso.
                        clause = first_clause(buffer)
                        if clause is not None:
                            head, buffer = clause
                            spoken += await self._speak(head, emit, turn, spoken)
                            sentences = split_sentences(buffer, self.settings.max_sentence_chars)
                    while len(sentences) > 1:
                        head = sentences.pop(0)
                        buffer = " ".join(sentences)
                        spoken += await self._speak(head, emit, turn, spoken)
                        sentences = split_sentences(buffer, self.settings.max_sentence_chars)

                tail = tags.flush()
                buffer += tail
                full_reply += tail
                if not self._cancel.is_set():
                    for sentence in split_sentences(buffer, self.settings.max_sentence_chars):
                        spoken += await self._speak(sentence, emit, turn, spoken)
                if full_reply.strip():
                    self.last_errors.pop("llm", None)
                await self._schedule_from_tags(tags.tags)
            except Exception as exc:
                failed = True
                logger.warning("Turno %s fallito: %s", turn, exc)
                detail = describe_error(exc)
                self.last_errors["llm"] = detail
                await emit(
                    {
                        "type": "error",
                        "source": "llm",
                        "message": f"{self.llm_label} non ha risposto: {detail}",
                        "hint": self._llm_hint(),
                        "action": "engines",
                        "turn": turn,
                    }
                )
            finally:
                self.llm.on_activity = None
                for helper in helpers:
                    helper.cancel()
                await asyncio.gather(*helpers, return_exceptions=True)
                # Gli ultimi passi arrivati insieme alla fine del turno.
                while not activities.empty():
                    await self._emit_activity(activities.get_nowait(), steps, emit, turn)
                reply = clean_for_speech(full_reply)
                if reply:
                    names = ", ".join(item.name for item in attachments)
                    self.history.append(Message("user", f"{prompt} [allegati: {names}]" if names else prompt))
                    self.history.append(Message("assistant", reply))
                    self._trim_history()

                elapsed = round(time.perf_counter() - started, 3)
                timings = {
                    "firstText": _ms(first_token_at, started),
                    "firstVoice": _ms(self._first_voice_at, started),
                    "total": int(elapsed * 1000),
                }
                logger.info(
                    "Turno %s: primo testo %s ms, prima voce %s ms, totale %s ms",
                    turn,
                    timings["firstText"],
                    timings["firstVoice"],
                    timings["total"],
                )
                await emit(
                    {
                        "type": "reply",
                        "text": reply,
                        "turn": turn,
                        "sentences": spoken,
                        "elapsed": elapsed,
                        "timings": timings,
                        "cancelled": self._cancel.is_set(),
                        "failed": failed,
                        "steps": steps,
                    }
                )
                await emit({"type": "state", "value": "idle", "turn": turn})

            return reply

    async def announce(self, text: str, emit: Emit, event: str = "") -> None:
        """Dice qualcosa di sua iniziativa (un promemoria, una notifica).

        Rispetta il muto (arriva solo il testo) e compare in chat come un suo
        messaggio. ``event`` descrive cosa l'ha fatta parlare: entra nella
        conversazione, cosi' il cervello sa di cosa si parla se rispondi.
        """
        async with self._turn_lock:
            self._cancel.clear()
            self._turn_id += 1
            turn = self._turn_id
            self._tts_failed = False
            spoken = 0
            for sentence in split_sentences(text, self.settings.max_sentence_chars):
                if self._cancel.is_set():
                    break
                spoken += await self._speak(sentence, emit, turn, spoken)
            if event:
                self.history.append(Message("user", f"({event})"))
                self.history.append(Message("assistant", clean_for_speech(text)))
                self._trim_history()
            await emit(
                {
                    "type": "reply",
                    "text": clean_for_speech(text),
                    "turn": turn,
                    "sentences": spoken,
                    "cancelled": self._cancel.is_set(),
                    "failed": False,
                    "proactive": True,
                }
            )
            await emit({"type": "state", "value": "idle", "turn": turn})

    # ------------------------------------------------------------------
    async def say(self, text: str, emit: Emit, voice: str | None = None) -> int:
        """Pronuncia un testo così com'e', senza passare dal cervello."""
        sentences = split_sentences(text, self.settings.max_sentence_chars)
        if not sentences:
            return 0

        async with self._turn_lock:
            self._cancel.clear()
            self._turn_id += 1
            turn = self._turn_id
            self._tts_failed = False
            await emit({"type": "state", "value": "speaking", "turn": turn})
            spoken = 0
            for sentence in sentences:
                if self._cancel.is_set():
                    break
                spoken += await self._speak(sentence, emit, turn, spoken, voice=voice, force=True)
            await emit({"type": "reply", "text": clean_for_speech(text), "turn": turn, "said": True})
            await emit({"type": "state", "value": "idle", "turn": turn})
        return len(sentences)

    async def vocal(self, event: str) -> dict[str, Any] | None:
        """Un versetto ("Hii!", "Ehehe!") con la voce in uso, per accompagnare un gesto.

        Non passa dal cervello e non entra nella conversazione. Resta zitto
        (``None``) se il companion e' muto o sta gia' pensando o parlando.
        Ogni frase si sintetizza una volta per voce e poi resta in memoria:
        le voci a pagamento costano a carattere.
        """
        if self.muted or self._turn_lock.locked():
            return None
        return {**await self._vocal_payload(event), "vocal": event}

    async def _vocal_payload(self, event: str) -> dict[str, Any]:
        """La sintesi di un versetto, dalla cache se c'e' gia'."""
        voice = self.voice
        text = vocal_line(event, self.voice_language)
        key = (self.tts.name, voice, text)
        payload = self._vocals.get(key)
        if payload is None:
            payload = await self._build_speech(text, 0, 0, voice, None)
            self._vocals[key] = payload
            while len(self._vocals) > VOCAL_CACHE_SIZE:
                self._vocals.pop(next(iter(self._vocals)))
        return payload

    # ------------------------------------------------------------------
    async def synthesize_payload(
        self, text: str, voice: str | None = None, speed: float | None = None
    ) -> list[dict[str, Any]]:
        """Versione "one shot" usata dagli endpoint REST (utile per i test)."""
        payloads: list[dict[str, Any]] = []
        for index, sentence in enumerate(split_sentences(text, self.settings.max_sentence_chars)):
            if strip_emoji(sentence):
                payloads.append(await self._build_speech(sentence, 0, index, voice, speed))
        return payloads

    def update_settings(
        self,
        voice: str | None = None,
        reply_language: str | None = None,
        muted: bool | None = None,
    ) -> dict[str, Any]:
        """Cambia voce, lingua delle risposte o muto (dal pannello, senza riavviare).

        Bloccante se il motore deve scaricare l'elenco delle voci: chiamala in
        un thread.
        """
        if voice:
            resolved = self.tts.resolve_voice(voice)
            if resolved != voice:
                logger.warning("Voce %r non disponibile per %s: uso %r", voice, self.tts.name, resolved)
            self.voice = resolved
            self.voice_chosen = True
        if reply_language:
            self.reply_language = reply_language
        if muted is not None:
            self.muted = bool(muted)
        return self.current_settings()

    async def transcribe(self, pcm16: bytes) -> Transcript | None:
        """Trascrive audio grezzo dal microfono (PCM 16 bit a 16 kHz, mono).

        Il frontend manda PCM invece di webm/opus perche' cosi' non serve alcun
        decoder audio lato server. Restituisce ``None`` se il riconoscimento
        vocale non e' attivo.
        """
        if self.stt is None or not pcm16:
            return None
        samples = from_pcm16(pcm16)
        # Come per la sintesi: l'inferenza e' bloccante, sta fuori dall'event loop.
        return await asyncio.to_thread(self.stt.transcribe, samples, STT_SAMPLE_RATE)

    def current_settings(self) -> dict[str, Any]:
        return {
            "voice": self.voice,
            "ttsEngine": self.settings.selected("tts"),
            "replyLanguage": self.reply_language,
            "replyLanguageResolved": self._reply_language(),
            "voiceLanguage": self.tts.language_of(self.voice),
            "canClone": self.tts.can_clone,
            "muted": self.muted,
        }

    @property
    def voice_language(self) -> str:
        """Lingua della voce in uso; per una voce multilingua, quella del sistema."""
        return short_language(self.tts.language_of(self.voice)) or self.settings.system_language

    def _reply_language(self) -> str | None:
        return reply_language(self.reply_language, self.voice_language)

    def cancel(self) -> None:
        """Interrompe il turno in corso, anche mentre l'agente sta ancora pensando."""
        self._cancel.set()

    async def reset(self) -> None:
        """Dimentica la conversazione, qui e nel backend che la tiene."""
        self.history.clear()
        await self.llm.reset()

    async def close(self) -> None:
        await self.llm.close()
        self.tts.close()
        if self.stt is not None:
            self.stt.close()

    # ------------------------------------------------------------------
    # Interni
    # ------------------------------------------------------------------
    def _build_messages(self, prompt: str, attachments: list[Attachment] | None = None) -> list[Message]:
        # L'ULTIMO messaggio di sistema sono i vincoli del parlato (lingua,
        # testo semplice): gli agenti, che hanno una personalita' propria,
        # ricevono solo quello e non il nostro system prompt.
        directive = speech_directive(self._reply_language())
        if self.memory is not None:
            directive = f"{directive} {self.memory.directive(agent=self.llm.stateful)}"
        if self.reminders is not None:
            directive = f"{directive} {action_directive()}"
        messages = [
            Message("system", self.settings.system_prompt),
            Message("system", directive),
        ]
        if not self.llm.stateful:
            # Un agente ricorda da se': rimandargli la cronologia sprecherebbe
            # contesto (e soldi, se e' a consumo).
            messages.extend(self.history)
        if not attachments:
            messages.append(Message("user", prompt))
            return messages
        # Un agente apre i file da se' (gli servono i percorsi e il permesso di
        # leggerli); a un modello si manda il testo e le immagini nel messaggio.
        content = with_paths(prompt, attachments) if self.llm.stateful else with_contents(prompt, attachments)
        images = tuple(str(item.path) for item in attachments if item.kind == "image")
        folders = tuple(sorted({str(item.path.parent) for item in attachments}))
        messages.append(Message("user", content, images=images, folders=folders))
        return messages

    async def _local_reply(self, prompt: str) -> str | None:
        """Timer, promemoria, "ricordati che...": senza cervello."""
        if self.reminders is None:
            return await self._memory_reply(prompt)
        now = datetime.now()
        command = command_reply(prompt, self.reminders, now)
        if command is not None:
            reply, changed = command
            if changed:
                await self._reminders_changed()
            return reply
        request = parse_request(prompt, now)
        if request is None:
            return await self._memory_reply(prompt)
        reminder = self.reminders.add(request.to_reminder())
        logger.info("Promemoria (%s) per %s: %r", reminder.kind, datetime.fromtimestamp(reminder.due), reminder.text)
        await self._reminders_changed()
        return confirmation(reminder, now)

    async def _memory_reply(self, prompt: str) -> str | None:
        """ "Ricordati che...", "dimentica che...", "cosa ricordi di me?"."""
        if self.memory is None:
            return None
        before = len(self.memory.facts())
        reply = memory_command(prompt, self.memory, self.voice_language)
        if reply is not None and len(self.memory.facts()) != before:
            await self._memory_changed()
        return reply

    async def _memory_changed(self) -> None:
        if self.on_memory_changed is not None:
            await self.on_memory_changed()

    async def _finish_local(self, prompt: str, reply: str, emit: Emit, turn: int, started: float) -> str:
        spoken = 0
        for sentence in split_sentences(reply, self.settings.max_sentence_chars):
            spoken += await self._speak(sentence, emit, turn, spoken)
        self.history.append(Message("user", prompt))
        self.history.append(Message("assistant", reply))
        self._trim_history()
        await emit(
            {
                "type": "reply",
                "text": reply,
                "turn": turn,
                "sentences": spoken,
                "elapsed": round(time.perf_counter() - started, 3),
                "cancelled": False,
                "failed": False,
                "local": True,
            }
        )
        await emit({"type": "state", "value": "idle", "turn": turn})
        return reply

    async def _schedule_from_tags(self, tags: list[str]) -> None:
        """Le etichette [[remind ...]] del cervello diventano promemoria veri."""
        if not tags:
            return
        # I ricordi annotati dal cervello ([[remember: ...]]).
        remembered = [fact for fact in map(fact_from_tag, tags) if fact]
        if remembered and self.memory is not None:
            if any(self.memory.add(fact, source="brain") for fact in remembered):
                await self._memory_changed()
        tags = [tag for tag in tags if fact_from_tag(tag) is None]
        if not tags or self.reminders is None:
            return
        added = 0
        for tag in tags:
            reminder = from_tag(tag, datetime.now(), self.voice_language)
            if reminder is None:
                logger.info("Etichetta del cervello non valida: %s", tag[:200])
                continue
            self.reminders.add(reminder)
            added += 1
            logger.info("Promemoria dal cervello (%s) per %s: %r", reminder.kind, datetime.fromtimestamp(reminder.due), reminder.text)
        if added:
            await self._reminders_changed()

    async def _reminders_changed(self) -> None:
        if self.on_reminders_changed is not None:
            await self.on_reminders_changed()

    def _trim_history(self) -> None:
        limit = max(2, self.settings.history_turns * 2)
        if len(self.history) > limit:
            del self.history[: len(self.history) - limit]

    def _llm_hint(self) -> str:
        spec = LLM_REGISTRY.get(self.settings.selected("llm"))
        if spec and spec.category == "agent":
            return f"Controlla che {spec.label} sia acceso e configurato, oppure scegli un altro cervello in Motori."
        if spec and spec.category == "cloud":
            return "Controlla la chiave API e la connessione nella scheda Motori."
        return "Controlla che il server sia acceso, oppure scegli un altro cervello in Motori."

    async def _cancellable(self, source: AsyncIterator[str]) -> AsyncIterator[str]:
        """Itera ``source`` fermandosi *subito* quando arriva un cancel.

        Prima il cancel veniva controllato solo all'arrivo del frammento
        successivo: con un agente che ragiona per un minuto, "Interrompi" non
        interrompeva niente. Qui il generatore gira in un task suo (le risorse
        che apre - stream HTTP, processi - restano nello stesso task) e viene
        cancellato appena serve, chiudendo connessioni e processi figli.
        """
        queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

        async def produce() -> None:
            try:
                async for piece in source:
                    await queue.put(("piece", piece))
                await queue.put(("end", None))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await queue.put(("error", exc))

        producer = asyncio.create_task(produce())
        cancelled = asyncio.create_task(self._cancel.wait())
        try:
            while True:
                getter = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait({getter, cancelled}, return_when=asyncio.FIRST_COMPLETED)
                if getter not in done:
                    getter.cancel()
                    return
                kind, value = getter.result()
                if kind == "piece":
                    yield value
                elif kind == "end":
                    return
                else:
                    raise value
        finally:
            cancelled.cancel()
            if not producer.done():
                producer.cancel()
                with contextlib.suppress(BaseException):
                    await producer

    async def _stream_with_fallback(self, messages: list[Message], emit: Emit) -> AsyncIterator[str]:
        """Prova il cervello configurato; se cade subito e il ripiego e' attivo, passa al mock."""
        produced = False
        try:
            async for piece in self.llm.stream(messages):
                produced = True
                yield piece
            return
        except Exception as exc:
            if produced or self._fallback_llm is None:
                raise
            logger.warning("LLM '%s' non disponibile (%s): uso il mock", self.llm.name, exc)
            await emit(
                {
                    "type": "notice",
                    "source": "llm",
                    "message": (
                        f"{self.llm_label} non risponde ({describe_error(exc)}): "
                        "rispondo con frasi preconfezionate."
                    ),
                }
            )

        async for piece in self._fallback_llm.stream(messages):
            yield piece

    async def _pump_activities(
        self, queue: asyncio.Queue[Activity], steps: list[dict[str, str]], emit: Emit, turn: int
    ) -> None:
        while True:
            await self._emit_activity(await queue.get(), steps, emit, turn)

    async def _emit_activity(self, activity: Activity, steps: list[dict[str, str]], emit: Emit, turn: int) -> None:
        # Tre letture di fila dello stesso file non sono tre passi diversi.
        if steps and steps[-1]["label"] == activity.label:
            return
        steps.append(activity.as_dict())
        await emit({"type": "working", "turn": turn, "step": len(steps), **activity.as_dict()})

    async def _working_cues(self, emit: Emit, turn: int) -> None:
        """Dice "un attimo, ci sto lavorando" se il turno e' ancora muto."""
        started = time.perf_counter()
        for delay, event in WORKING_CUES:
            await asyncio.sleep(max(0.0, started + delay - time.perf_counter()))
            if self._turn_voiced or self.muted or self._tts_failed or self._cancel.is_set():
                return
            try:
                payload = await self._vocal_payload(event)
            except Exception as exc:  # una voce guasta la segnala gia' il turno
                logger.info("Versetto '%s' non sintetizzato: %s", event, describe_error(exc))
                return
            if self._turn_voiced or self._cancel.is_set():
                return
            self._recent_speech.append((time.monotonic(), str(payload.get("text") or "")))
            await emit({**payload, "turn": turn, "index": -1, "vocal": event})

    def is_echo(self, text: str) -> bool:
        """La trascrizione e' la sua stessa voce tornata dal microfono?

        Serve a lasciarla ascoltare mentre parla (per farsi interrompere)
        senza che si risponda da sola: se quasi tutte le parole sentite le
        ha appena dette lei, non e' una domanda.
        """
        words = _words(text)
        if len(words) < 2:
            return False
        now = time.monotonic()
        said = {word for at, sentence in self._recent_speech if now - at <= ECHO_WINDOW_S for word in _words(sentence)}
        if not said:
            return False
        return sum(word in said for word in words) / len(words) >= ECHO_OVERLAP

    async def _speak(
        self,
        sentence: str,
        emit: Emit,
        turn: int,
        index: int,
        voice: str | None = None,
        force: bool = False,
    ) -> int:
        """Pronuncia una frase; restituisce 1 se e' arrivata al frontend.

        Se la voce fallisce il testo continua ad arrivare (chat e bolla): un
        errore della sintesi non deve troncare la risposta del cervello.
        """
        # Una "frase" fatta solo di emoji non ha niente da pronunciare.
        text = strip_emoji(sentence)
        if not text or self._cancel.is_set():
            return 0
        caption = {"type": "caption", "text": text, "mood": detect_mood(sentence), "turn": turn, "index": index}
        self._turn_voiced = True
        self._recent_speech.append((time.monotonic(), text))
        if (self.muted and not force) or self._tts_failed:
            await emit(caption)
            return 1
        try:
            payload = await self._build_speech(sentence, turn, index, voice, None)
        except Exception as exc:
            self._tts_failed = True
            detail = describe_error(exc)
            self.last_errors["tts"] = detail
            logger.warning("Sintesi fallita: %s", detail)
            await emit(
                {
                    "type": "error",
                    "source": "tts",
                    "message": f"La voce non funziona: {detail}",
                    "hint": "Il testo continua ad arrivare in chat. Controlla la voce nella scheda Motori.",
                    "action": "engines",
                    "turn": turn,
                }
            )
            await emit(caption)
            return 1
        self.last_errors.pop("tts", None)
        if payload["duration"] <= 0.0:
            return 0
        if index == 0:
            await emit({"type": "state", "value": "speaking", "turn": turn})
        if self._first_voice_at is None:
            self._first_voice_at = time.perf_counter()
        await emit(payload)
        return 1

    async def _build_speech(
        self,
        sentence: str,
        turn: int,
        index: int,
        voice: str | None,
        speed: float | None,
    ) -> dict[str, Any]:
        """Sintesi + timeline visemi. La parte pesante gira in un thread."""
        started = time.perf_counter()
        # Le emoji danno l'umore della frase, ma al motore TTS non devono arrivare.
        mood = detect_mood(sentence)
        spoken = strip_emoji(sentence)
        # asyncio.to_thread evita di bloccare l'event loop durante l'inferenza.
        async with self._tts_lock:
            speech = await asyncio.to_thread(self.tts.synthesize, spoken, voice or self.voice, speed)

        # Con i timing esatti il G2P non serve: lo calcoliamo solo come riserva.
        phones = [] if speech.timings else phones_for(speech.text, speech.phonemes)
        visemes = await asyncio.to_thread(
            build_timeline,
            speech.samples,
            speech.sample_rate,
            phones,
            timings=speech.timings,
            gain=self.settings.viseme_gain,
            silence_threshold=self.settings.viseme_silence_threshold,
            hop_s=self.settings.viseme_hop,
        )

        elapsed = round(time.perf_counter() - started, 3)
        logger.info(
            "TTS frase %s (%.2fs audio) in %.2fs - %d visemi [%s]",
            index,
            speech.duration,
            elapsed,
            len(visemes),
            "timing esatti" if speech.timings else "allineamento su energia",
        )

        return {
            "type": "speech",
            "turn": turn,
            "index": index,
            "text": speech.text,
            "format": "wav",
            "sampleRate": speech.sample_rate,
            "duration": round(speech.duration, 4),
            "audio": encode_wav_base64(speech.samples, speech.sample_rate),
            "visemes": visemes,
            "mood": mood,
            "engine": speech.meta.get("engine", self.tts.name),
            "voice": speech.meta.get("voice"),
            "synthMs": int(elapsed * 1000),
        }
