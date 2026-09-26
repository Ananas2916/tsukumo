"""Commenti spontanei: il companion parla di sua iniziativa, al momento giusto.

Guarda l'ora, cosa stai facendo (``context.py``), la batteria, il meteo, e
ogni tanto dice qualcosa:

* **Ora tarda** - all'una e sei ancora li' a programmare: "Sono le 1 e 12!
  Vai a dormire, hai programmato abbastanza per oggi." (e sbadiglia).
* **Pause** - due ore di fila al PC: "fai una pausa, sgranchisciti".
* **Meteo** - il buongiorno col tempo che fa, il caldo (si fa aria con la
  mano), il freddo (trema), la pioggia che comincia.
* **Batteria** - al 20, 10 e 5%, finche' non la attacchi.
* **YouTube** - un commento sul video che stai guardando o sul suo creator.
* **Chiacchiere** - una notizia di oggi, una curiosita', un film da vedere.

Le frasi fisse (ora, pause, meteo, batteria) sono pronte in italiano e in
inglese: arrivano subito e costano zero. I commenti su video, notizie e
curiosita' li scrive il cervello, con un messaggio "nascosto" che non compare
in chat come se l'avessi scritto tu.

Mai quando dai fastidio: niente con lo schermo intero, in riunione o in un
gioco, niente se non sei al PC, niente mentre lei sta gia' parlando, e fra un
commento e l'altro passano almeno 8 minuti. Nel pannello si sceglie quanto
chiacchiera (spenta, poco, normale, tanto) e di cosa.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from .context import PCContext
from .news import NewsService
from .preferences import Preferences
from .reminders import speak_duration
from .system import Battery, battery
from .weather import WeatherService

if TYPE_CHECKING:  # pragma: no cover
    from .pipeline import Companion

logger = logging.getLogger(__name__)

Broadcast = Callable[[dict[str, Any]], Awaitable[None]]

#: Fra due commenti qualsiasi (la batteria quasi scarica fa eccezione).
MIN_GAP = 8 * 60
#: Ogni quanto, in media, una chiacchiera (notizia, curiosita', film).
CHATTER_GAPS = {"rare": 90 * 60, "normal": 45 * 60, "chatty": 20 * 60}
#: Fra due commenti su video di YouTube.
YOUTUBE_GAPS = {"rare": 45 * 60, "normal": 15 * 60, "chatty": 6 * 60}
#: Il video va guardato almeno tanto prima di commentarlo (non mentre scorri).
YOUTUBE_WATCHED = 45
#: Di notte: prima dell'alba e' "tardi".
NIGHT_UNTIL_HOUR = 5
NIGHT_REPEAT = 45 * 60
NIGHT_YAWN_EVERY = 12 * 60
#: Pause: la prima dopo due ore di fila, poi ogni ora.
BREAK_AFTER_MINUTES = 120
BREAK_REPEAT_MINUTES = 60
BATTERY_LEVELS = (20, 10, 5)
#: Attivita' in cui una chiacchiera interromperebbe (si aspetta che tu stia fermo).
FOCUSED = {"coding", "office", "meeting", "game", "video", "youtube", "tsukumo", "chat"}

FACT_TOPICS = (
    "space", "animals", "the ocean", "history", "food", "the human body", "language", "music",
    "video games", "computers", "mathematics", "plants", "the weather", "inventions", "Japan", "Italy",
)
FILM_KINDS = ("animated", "science fiction", "comedy", "fantasy", "classic", "adventure", "mystery", "feel-good", "Studio Ghibli")

#: Cosa hai fatto troppo, per "vai a dormire, hai ___ abbastanza".
_DID = {
    "coding": ("programmato", "coded"),
    "youtube": ("guardato video", "watched videos"),
    "video": ("guardato video", "watched videos"),
    "game": ("giocato", "played"),
    "browsing": ("navigato", "browsed the web"),
    "office": ("lavorato", "worked"),
    "chat": ("chattato", "chatted"),
    "music": ("ascoltato musica", "listened to music"),
    "tsukumo": ("chiacchierato con me", "chatted with me"),
}

TEMPLATES: dict[str, dict[str, list[str]]] = {
    "it": {
        "night": [
            "{Clock} e sei ancora qui? Dovresti andare a dormire.",
            "Uff, {clock}... io crollo dal sonno. Tu no?",
            "È tardissimo, {clock}! Domani te ne pentirai.",
        ],
        "night_did": [
            "{Clock}! Vai a dormire, hai {did} abbastanza per oggi.",
            "Ancora qui? {Clock}, hai {did} troppo. Fila a letto!",
        ],
        "break": [
            "Sei al PC da {hours} di fila: che ne dici di una pausa? Alzati e sgranchisciti un po'.",
            "{Hours} davanti allo schermo! Fai una pausa e bevi un po' d'acqua.",
        ],
        "battery_20": ["La batteria è al {p} per cento: meglio attaccare il caricabatterie."],
        "battery_10": ["Batteria al {p} per cento! Attacca il caricatore, per favore."],
        "battery_5": ["Aiuto, la batteria è al {p} per cento! Si sta per spegnere tutto!"],
        "morning": ["Buongiorno! "],
        "clear": ["Che bella giornata di sole! Fuori ci sono {t} gradi."],
        "clear_night": ["Stanotte il cielo è sereno, fuori ci sono {t} gradi."],
        "cloudy": ["Oggi è nuvoloso, fuori ci sono {t} gradi."],
        "fog": ["C'è nebbia fuori, {t} gradi. Se esci, vai piano!"],
        "rain": ["Sta piovendo fuori! Se esci, prendi l'ombrello."],
        "snow": ["Nevica! Fuori ci sono {t} gradi."],
        "storm": ["C'è un temporale fuori! Meglio restare al calduccio."],
        "hot": ["Che caldo! Fuori ci sono {t} gradi, ricordati di bere."],
        "cold": ["Brr, che freddo! Fuori ci sono solo {t} gradi."],
        "youtube": ["Oh, stai guardando «{title}»! Sembra interessante."],
    },
    "en": {
        "night": [
            "{Clock} and you're still here? You should get some sleep.",
            "Ugh, {clock}... I can barely keep my eyes open. Aren't you tired?",
            "It's so late, {clock}! You'll regret it tomorrow.",
        ],
        "night_did": [
            "{Clock}! Go to bed, you've {did} enough for today.",
            "Still here? {Clock}, you've {did} way too much. Off to bed!",
        ],
        "break": [
            "You've been at the PC for {hours} straight: how about a break? Get up and stretch a little.",
            "{Hours} in front of the screen! Take a break and drink some water.",
        ],
        "battery_20": ["The battery is at {p} percent: better plug in the charger."],
        "battery_10": ["Battery at {p} percent! Please plug in the charger."],
        "battery_5": ["Help, the battery is at {p} percent! Everything's about to shut down!"],
        "morning": ["Good morning! "],
        "clear": ["Such a sunny day! It's {t} degrees outside."],
        "clear_night": ["Clear skies tonight, {t} degrees outside."],
        "cloudy": ["It's cloudy today, {t} degrees outside."],
        "fog": ["It's foggy outside, {t} degrees. Drive carefully!"],
        "rain": ["Such a rainy day! Take an umbrella if you go out."],
        "snow": ["It's snowing! {t} degrees outside."],
        "storm": ["There's a storm outside! Better stay cozy indoors."],
        "hot": ["It's so hot! {t} degrees outside, remember to drink."],
        "cold": ["Brr, it's freezing! Only {t} degrees outside."],
        "youtube": ["Ooh, “{title}”! Looks interesting."],
    },
}

#: Il gesto che accompagna ogni frase (azioni di body/actions.js).
GESTURES = {
    "night": "yawn",
    "night_did": "yawn",
    "break": "stretch",
    "battery_20": "headTilt",
    "battery_10": "flinch",
    "battery_5": "flinch",
    "clear": "stretch",
    "rain": "lookAround",
    "storm": "flinch",
    "snow": "shiver",
    "hot": "fanSelf",
    "cold": "shiver",
    "youtube": "headTilt",
}


def spoken_clock(now: datetime, lang: str) -> tuple[str, str]:
    """L'ora da dire: ("È l'una e 12", "l'una e 12") / ("It's 1:12", "1:12")."""
    hour, minute = now.hour, now.minute
    if lang == "it":
        if hour in (1, 13):
            inner = "l'una"
            head = "È l'una"
        elif hour == 0:
            inner = head = "mezzanotte"
            head = "È mezzanotte"
        else:
            inner = f"le {hour}"
            head = f"Sono le {hour}"
        if minute:
            inner += f" e {minute}"
            head += f" e {minute}"
        return head, inner
    twelve = hour % 12 or 12
    suffix = "am" if hour < 12 else "pm"
    stamp = f"{twelve}:{minute:02d} {suffix}" if minute else f"{twelve} {suffix}"
    return f"It's {stamp}", stamp


class Proactive:
    """Decide se e cosa dire, un giro ogni ``interval`` secondi."""

    def __init__(
        self,
        *,
        companion: Callable[[], "Companion | None"],
        context: PCContext,
        preferences: Preferences,
        broadcast: Broadcast,
        weather: WeatherService | None = None,
        news: NewsService | None = None,
        battery_reader: Callable[[], Battery | None] = battery,
        rng: random.Random | None = None,
        interval: float = 20.0,
    ) -> None:
        self._companion = companion
        self.context = context
        self.preferences = preferences
        self.broadcast = broadcast
        self.weather = weather
        self.news = news
        self.battery_reader = battery_reader
        self.rng = rng or random.Random()
        self.interval = interval
        self._task: asyncio.Task | None = None
        self.last_any = 0.0
        self.last: dict[str, float] = {}
        self.said_on: dict[str, str] = {}
        self.battery_warned: set[int] = set()
        self.youtube_seen: set[str] = set()
        self.last_condition: str | None = None
        self.next_break_minutes = BREAK_AFTER_MINUTES
        self.next_chatter_at: float | None = None
        self.fact_topics: list[str] = []

    # ------------------------------------------------------------------
    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="proactive")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - non deve mai morire
                logger.exception("Commenti spontanei")

    # ------------------------------------------------------------------
    async def tick(self, now: datetime | None = None) -> str | None:
        """Un giro di controllo; restituisce cosa ha detto (per i test e il log)."""
        now = now or datetime.now()
        ts = now.timestamp()
        companion = self._companion()
        if companion is None or companion._turn_lock.locked() or not self.context.fresh:
            return None

        said = await self._battery(companion, ts)
        if said:
            return said
        prefs = self.preferences
        context = self.context
        if prefs.chatter == "off" or not context.present or context.activity.dnd:
            return None

        # Di notte ogni tanto sbadiglia, anche senza dire niente.
        if prefs.topic("night") and self._is_night(now) and ts - self.last.get("yawn", 0) >= NIGHT_YAWN_EVERY:
            self.last["yawn"] = ts
            await self.broadcast({"type": "gesture", "name": "yawn"})

        if ts - self.last_any < MIN_GAP:
            return None
        for rule in (self._night, self._breaks, self._weather, self._youtube, self._chatter):
            said = await rule(companion, now)
            if said:
                self.last_any = ts
                self.last[said.split(":")[0]] = ts
                logger.info("Commento spontaneo: %s", said)
                return said
        return None

    # ------------------------------------------------------------------ regole
    async def _battery(self, companion: "Companion", ts: float) -> str | None:
        if not self.preferences.topic("battery"):
            return None
        reading = self.battery_reader()
        if reading is None:
            return None
        if reading.plugged:
            self.battery_warned.clear()
            return None
        level = next((level for level in reversed(BATTERY_LEVELS) if reading.percent <= level), None)
        if level is None or level in self.battery_warned:
            return None
        # Si segnano anche le soglie piu' alte: al 9% non si dice "20%" dopo "10%".
        self.battery_warned.update(value for value in BATTERY_LEVELS if value >= level)
        critical = level == BATTERY_LEVELS[-1]
        if not critical and (not self.context.present or ts - self.last_any < MIN_GAP / 4):
            return None
        await self._say(companion, f"battery_{level}", event=f"Batteria al {reading.percent}%", p=reading.percent)
        self.last_any = ts
        return f"battery:{reading.percent}"

    def _is_night(self, now: datetime) -> bool:
        return now.hour < NIGHT_UNTIL_HOUR

    async def _night(self, companion: "Companion", now: datetime) -> str | None:
        if not self.preferences.topic("night") or not self._is_night(now):
            return None
        if self.context.idle > 120 and not self.context.activity.watching:
            return None
        if now.timestamp() - self.last.get("night", 0) < NIGHT_REPEAT:
            return None
        lang = self._lang(companion)
        head, inner = spoken_clock(now, lang)
        did = _DID.get(self.context.activity.kind)
        key = "night_did" if did and self.rng.random() < 0.7 else "night"
        await self._say(
            companion,
            key,
            event=f"Sono le {now:%H:%M} e l'utente è ancora al PC ({self.context.activity.kind})",
            Clock=head,
            clock=inner,
            did=did[0 if lang == "it" else 1] if did else "",
        )
        return f"night:{self.context.activity.kind}"

    async def _breaks(self, companion: "Companion", now: datetime) -> str | None:
        minutes = self.context.session_minutes(now.timestamp())
        if minutes < BREAK_AFTER_MINUTES:
            self.next_break_minutes = BREAK_AFTER_MINUTES
            return None
        if not self.preferences.topic("breaks") or self._is_night(now) or minutes < self.next_break_minutes:
            return None
        self.next_break_minutes = minutes + BREAK_REPEAT_MINUTES
        lang = self._lang(companion)
        hours = speak_duration(round(minutes / 30) * 30 * 60, lang)
        await self._say(companion, "break", event=f"L'utente è al PC da {round(minutes)} minuti", hours=hours, Hours=hours[:1].upper() + hours[1:])
        return f"break:{round(minutes)}"

    async def _weather(self, companion: "Companion", now: datetime) -> str | None:
        if not self.preferences.topic("weather") or self.weather is None:
            return None
        lang = self._lang(companion)
        weather = await self.weather.get(self.preferences.city, lang)
        if weather is None:
            return None
        today = now.date().isoformat()
        previous, self.last_condition = self.last_condition, weather.condition
        t = round(weather.temperature)
        event = f"Meteo: {weather.condition}, {t}°C"
        # 1. Il buongiorno col tempo che fa, una volta al giorno.
        if 6 <= now.hour < 12 and self.said_on.get("morning") != today:
            self.said_on["morning"] = today
            key = weather.feel if weather.feel != "mild" else weather.condition
            await self._say(companion, key, event=event, prefix="morning", t=t)
            return f"weather:morning-{key}"
        # 2. Caldo o freddo forti, una volta al giorno ciascuno.
        if weather.feel != "mild" and self.said_on.get(weather.feel) != today:
            self.said_on[weather.feel] = today
            await self._say(companion, weather.feel, event=event, t=round(weather.apparent))
            return f"weather:{weather.feel}"
        # 3. Comincia a piovere, nevicare, tuonare.
        wet = {"rain", "snow", "storm"}
        if weather.condition in wet and previous is not None and previous not in wet:
            if now.timestamp() - self.last.get("weather", 0) >= 3 * 3600:
                await self._say(companion, weather.condition, event=event, t=t)
                return f"weather:{weather.condition}"
        return None

    async def _youtube(self, companion: "Companion", now: datetime) -> str | None:
        activity = self.context.activity
        if not self.preferences.topic("youtube") or activity.kind != "youtube" or not activity.detail:
            return None
        title = activity.detail
        if title in self.youtube_seen or self.context.activity_seconds(now.timestamp()) < YOUTUBE_WATCHED:
            return None
        if now.timestamp() - self.last.get("youtube", 0) < YOUTUBE_GAPS.get(self.preferences.chatter, YOUTUBE_GAPS["normal"]):
            return None
        self.youtube_seen.add(title)
        if self._brain_ready(companion):
            await self._ask(
                companion,
                f'(Not from the user: they are watching the YouTube video titled "{title}". Make one short, '
                "spontaneous comment about it: the topic, or the creator if you recognise the channel. "
                "At most two short sentences, no questions.)",
                gesture="headTilt",
            )
        else:
            await self._say(companion, "youtube", event=f"L'utente guarda su YouTube: {title}", title=title)
        return f"youtube:{title[:60]}"

    async def _chatter(self, companion: "Companion", now: datetime) -> str | None:
        prefs = self.preferences
        topics = [topic for topic in ("news", "facts", "films") if prefs.topic(topic)]
        if not topics or not self._brain_ready(companion):
            return None
        ts = now.timestamp()
        gap = CHATTER_GAPS.get(prefs.chatter, CHATTER_GAPS["normal"])
        if self.next_chatter_at is None:
            self.next_chatter_at = ts + gap * self.rng.uniform(0.4, 0.8)
            return None
        if ts < self.next_chatter_at:
            return None
        # Non mentre lavori, guardi o chatti: aspetta che ti fermi un attimo.
        if self.context.activity.kind in FOCUSED and self.context.idle < 90:
            return None
        self.next_chatter_at = ts + gap * self.rng.uniform(0.7, 1.3)
        lang = self._lang(companion)
        self.rng.shuffle(topics)
        for topic in topics:
            if topic == "news" and self.news is not None:
                headline = await self.news.pick(companion.settings.system_language or lang)
                if headline is None:
                    continue
                source = f" ({headline.source})" if headline.source else ""
                await self._ask(
                    companion,
                    f'(Not from the user: a headline from today\'s news is "{headline.title}"{source}. Mention it and '
                    "comment on it like a friend would, in at most two short sentences.)",
                    gesture="lookAround",
                )
                return f"news:{headline.title[:60]}"
            if topic == "facts":
                if not self.fact_topics:
                    self.fact_topics = list(FACT_TOPICS)
                    self.rng.shuffle(self.fact_topics)
                subject = self.fact_topics.pop()
                await self._ask(
                    companion,
                    f"(Not from the user: share one short, surprising and true fun fact about {subject}, "
                    "as a spontaneous remark. At most two sentences.)",
                    gesture="headTilt",
                )
                return f"facts:{subject}"
            if topic == "films":
                kind = self.rng.choice(FILM_KINDS)
                await self._ask(
                    companion,
                    f"(Not from the user: suggest one well-known {kind} film to watch, with a one-line reason why. "
                    "At most two sentences.)",
                    gesture="hum",
                )
                return f"films:{kind}"
        return None

    # ------------------------------------------------------------------ voce
    def _lang(self, companion: "Companion") -> str:
        return companion.voice_language or "en"

    def _brain_ready(self, companion: "Companion") -> bool:
        """C'e' un cervello vero (non il risponditore offline) e sta bene."""
        return companion.settings.selected("llm") not in ("mock", "offline") and "llm" not in companion.last_errors

    async def _say(self, companion: "Companion", key: str, *, event: str, prefix: str | None = None, **values: Any) -> None:
        """Una frase pronta, con il suo gesto. Per le lingue senza frasi pronte la riscrive il cervello."""
        lang = self._lang(companion)
        gesture = GESTURES.get(key)
        if gesture:
            await self.broadcast({"type": "gesture", "name": gesture})
        table = TEMPLATES.get(lang)
        english = self._render(TEMPLATES["en"], key, prefix, values)
        if table is None and self._brain_ready(companion):
            await companion.chat(
                f"(Not from the user. Say this to them in your own words, in one short sentence: {english})",
                self.broadcast,
                hidden=True,
            )
            return
        text = self._render(table or TEMPLATES["en"], key, prefix, values)
        await companion.announce(text, self.broadcast, event=event)

    def _render(self, table: dict[str, list[str]], key: str, prefix: str | None, values: dict[str, Any]) -> str:
        text = self.rng.choice(table[key]).format(**values)
        return (self.rng.choice(table[prefix]) + text) if prefix else text

    async def _ask(self, companion: "Companion", prompt: str, gesture: str | None = None) -> None:
        """Un commento scritto dal cervello, col messaggio che lo chiede nascosto."""
        if gesture:
            await self.broadcast({"type": "gesture", "name": gesture})
        await companion.chat(prompt, self.broadcast, hidden=True)

    def status(self) -> dict[str, Any]:
        return {
            "lastAny": self.last_any,
            "last": dict(self.last),
            "nextChatterAt": self.next_chatter_at,
            "weather": self.last_condition,
        }

