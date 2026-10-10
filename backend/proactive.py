"""Spontaneous comments: the companion speaks on her own, at the right moment.

She looks at the time, at what you're doing (``context.py``), the battery,
the weather, and now and then says something:

* **Late hour** - it's 1 a.m. and you're still coding: "It's 1:12! Go to
  sleep, you've coded enough for today." (and she yawns).
* **Breaks** - two hours straight at the PC: "take a break, stretch".
* **Weather** - good morning with the weather, the heat (she fans herself),
  the cold (she shivers), the rain starting.
* **Battery** - at 20, 10 and 5%, until you plug it in.
* **Agent limits** - Claude Code or Codex at 80 and 95% of a plan limit, and
  when the limit resets (``usage.py``).
* **YouTube** - a comment on the video you're watching or on its creator.
* **Chatter** - a news item of the day, a fun fact, a film to watch.

The fixed phrases (time, breaks, weather, battery) are ready in Italian and
English: they arrive right away and cost nothing. Comments on videos, news
and fun facts are written by the brain, with a "hidden" message that doesn't
show up in the chat as if you had written it. In the panel they can be
given to a separate brain (a cheap or free model, cloud or local): so a
pay-per-use agent like Claude Code doesn't spend a turn on every news item,
and if that brain doesn't answer she stays quiet instead of falling back on
the agent.

Never when it's a bother: nothing in full screen, in a meeting or in a game,
nothing if you're not at the PC, nothing while she's already speaking, and
at least 8 minutes pass between one comment and the next. In the panel you
choose how much she chats (off, a little, normal, a lot) and about what.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from .context import PCContext
from .llm import LLMClient, create_chatter_llm, describe_error
from .news import NewsService
from .preferences import Preferences
from .reminders import speak_duration
from .system import Battery, battery
from .usage import when_words, window_words
from .weather import WeatherService

if TYPE_CHECKING:  # pragma: no cover
    from .pipeline import Companion

logger = logging.getLogger(__name__)

Broadcast = Callable[[dict[str, Any]], Awaitable[None]]

#: Between any two comments (an almost flat battery is the exception).
MIN_GAP = 8 * 60
#: How often, on average, some chatter (news, fun fact, film).
CHATTER_GAPS = {"rare": 90 * 60, "normal": 45 * 60, "chatty": 20 * 60}
#: Between two comments on YouTube videos.
YOUTUBE_GAPS = {"rare": 45 * 60, "normal": 15 * 60, "chatty": 6 * 60}
#: The video must be watched at least this long before commenting (not while you scroll).
YOUTUBE_WATCHED = 45
#: At night: before dawn it's "late".
NIGHT_UNTIL_HOUR = 5
NIGHT_REPEAT = 45 * 60
NIGHT_YAWN_EVERY = 12 * 60
#: Breaks: the first after two hours straight, then every hour.
BREAK_AFTER_MINUTES = 120
BREAK_REPEAT_MINUTES = 60
BATTERY_LEVELS = (20, 10, 5)
#: Thresholds of the agents' limits (percentage used), and below what it has reset.
USAGE_LEVELS = (80, 95)
USAGE_RESET_BELOW = 30
#: Activities a chat would interrupt (it waits for you to be idle).
FOCUSED = {"coding", "office", "meeting", "game", "video", "youtube", "tsukumo", "chat"}

FACT_TOPICS = (
    "space", "animals", "the ocean", "history", "food", "the human body", "language", "music",
    "video games", "computers", "mathematics", "plants", "the weather", "inventions", "Japan", "Italy",
)
FILM_KINDS = ("animated", "science fiction", "comedy", "fantasy", "classic", "adventure", "mystery", "feel-good", "Studio Ghibli")

#: What you did too much, for "go to sleep, you've ___ enough".
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
        "usage_80": [
            "{agent} ha già usato {the_p} per cento del limite {window}. Si azzera {when}.",
            "Occhio: {agent} è {at_p} per cento del limite {window}. Riparte {when}.",
        ],
        "usage_95": ["{agent} è quasi al limite {window}: {p} per cento! Si azzera {when}."],
        "usage_reset": ["Buone notizie: il limite {window} di {agent} si è azzerato, puoi ripartire."],
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
        "usage_80": ["{agent} has already used {p} percent of its {window} limit. It resets {when}."],
        "usage_95": ["{agent} is almost at its {window} limit: {p} percent! It resets {when}."],
        "usage_reset": ["Good news: {agent}'s {window} limit has reset, you're good to go."],
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

#: The gesture that goes with each phrase (actions of body/actions.js).
GESTURES = {
    "night": "yawn",
    "night_did": "yawn",
    "break": "stretch",
    "battery_20": "headTilt",
    "battery_10": "flinch",
    "battery_5": "flinch",
    "usage_80": "headTilt",
    "usage_95": "flinch",
    "usage_reset": "stretch",
    "clear": "stretch",
    "rain": "lookAround",
    "storm": "flinch",
    "snow": "shiver",
    "hot": "fanSelf",
    "cold": "shiver",
    "youtube": "headTilt",
}


def italian_percent(p: int) -> tuple[str, str]:
    """("l'80", "all'80") / ("il 90", "al 90"): the Italian article follows the number's sound."""
    vowel = str(p).startswith("8") or p in (1, 11)
    return (f"l'{p}", f"all'{p}") if vowel else (f"il {p}", f"al {p}")


def spoken_clock(now: datetime, lang: str) -> tuple[str, str]:
    """The time to say: ("È l'una e 12", "l'una e 12") / ("It's 1:12", "1:12")."""
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
    """Decides whether and what to say, one round every ``interval`` seconds."""

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
        usage: Callable[[], dict[str, Any] | None] | None = None,
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
        #: The last reading of the agents' usage (usage.py), without touching the files.
        self.usage = usage
        #: For every limit ("codex:primary") the threshold already said and for which reset.
        self.usage_warned: dict[str, tuple[float | None, int]] = {}
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
        #: The chatter brain, and the choice it was born from (see _chatter_brain).
        self._brain: LLMClient | None = None
        self._brain_key: tuple[Any, ...] | None = None
        self.brain_error: str | None = None
        self._closing: set[asyncio.Task] = set()

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
        if self._brain is not None:
            await self._brain.close()
            self._brain, self._brain_key = None, None

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - it must never die
                logger.exception("Spontaneous comments")

    # ------------------------------------------------------------------
    async def tick(self, now: datetime | None = None) -> str | None:
        """One round of checks; returns what it said (for the tests and the log)."""
        now = now or datetime.now()
        ts = now.timestamp()
        companion = self._companion()
        if companion is None or companion._turn_lock.locked() or not self.context.fresh:
            return None

        said = await self._battery(companion, ts)
        if said:
            return said
        said = await self._usage(companion, now)
        if said:
            return said
        prefs = self.preferences
        context = self.context
        if prefs.chatter == "off" or not context.present or context.activity.dnd:
            return None

        # At night now and then she yawns, even without saying anything.
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
                logger.info("Spontaneous comment: %s", said)
                return said
        return None

    # ------------------------------------------------------------------ rules
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
        # The higher thresholds are noted too: at 9% you don't say "20%" after "10%".
        self.battery_warned.update(value for value in BATTERY_LEVELS if value >= level)
        critical = level == BATTERY_LEVELS[-1]
        if not critical and (not self.context.present or ts - self.last_any < MIN_GAP / 4):
            return None
        await self._say(companion, f"battery_{level}", event=f"Battery at {reading.percent}%", p=reading.percent)
        self.last_any = ts
        return f"battery:{reading.percent}"

    async def _usage(self, companion: "Companion", now: datetime) -> str | None:
        """An agent near a plan limit (80, 95%), or the limit just reset.

        Like the battery it doesn't depend on how much she chats: it's a work
        notice. But it waits for you to be at the PC and not in a meeting, and
        every threshold is said once per window.
        """
        if not self.preferences.topic("usage") or self.usage is None:
            return None
        ts = now.timestamp()
        context = self.context
        if not context.present or context.activity.dnd or ts - self.last_any < MIN_GAP / 4:
            return None
        for agent in (self.usage() or {}).get("agents", []):
            for limit in agent.get("limits", []):
                key = f"{agent['id']}:{limit['id']}"
                used = float(limit.get("used") or 0)
                resets = limit.get("resetsAt")
                warned = self.usage_warned.get(key)
                level = next((value for value in reversed(USAGE_LEVELS) if used >= value), None)
                if level is None:
                    if warned and used < USAGE_RESET_BELOW:
                        del self.usage_warned[key]
                        await self._say_usage(companion, "usage_reset", agent, limit, now)
                        return f"usage_reset:{key}"
                    continue
                if warned and warned[0] == resets and warned[1] >= level:
                    continue
                self.usage_warned[key] = (resets, level)
                await self._say_usage(companion, f"usage_{level}", agent, limit, now)
                return f"usage:{key}:{round(used)}"
        return None

    async def _say_usage(self, companion: "Companion", key: str, agent: dict[str, Any], limit: dict[str, Any], now: datetime) -> None:
        lang = self._lang(companion)
        p = round(float(limit.get("used") or 0))
        the_p, at_p = italian_percent(p)
        await self._say(
            companion,
            key,
            event=f"{agent['label']} at {p}% of the limit ({limit['id']})",
            agent=agent["label"],
            p=p,
            the_p=the_p,
            at_p=at_p,
            window=window_words(limit.get("windowMinutes"), lang),
            when=when_words(limit.get("resetsAt"), now.timestamp(), lang),
        )
        self.last_any = now.timestamp()

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
            event=f"It's {now:%H:%M} and the user is still at the PC ({self.context.activity.kind})",
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
        await self._say(companion, "break", event=f"The user has been at the PC for {round(minutes)} minutes", hours=hours, Hours=hours[:1].upper() + hours[1:])
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
        # 1. Good morning with the weather, once a day.
        if 6 <= now.hour < 12 and self.said_on.get("morning") != today:
            self.said_on["morning"] = today
            key = weather.feel if weather.feel != "mild" else weather.condition
            await self._say(companion, key, event=event, prefix="morning", t=t)
            return f"weather:morning-{key}"
        # 2. Strong heat or cold, once a day each.
        if weather.feel != "mild" and self.said_on.get(weather.feel) != today:
            self.said_on[weather.feel] = today
            await self._say(companion, weather.feel, event=event, t=round(weather.apparent))
            return f"weather:{weather.feel}"
        # 3. It starts raining, snowing, thundering.
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
        # Not while you work, watch or chat: it waits for you to stop for a moment.
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

    # ------------------------------------------------------------------ voice
    def _lang(self, companion: "Companion") -> str:
        return companion.voice_language or "en"

    def _brain_ready(self, companion: "Companion") -> bool:
        """There's someone to write the comments: the chatter brain, or the main one if it's well."""
        if self.preferences.brain:
            return self._chatter_brain(companion) is not None
        return companion.settings.selected("llm") not in ("mock", "offline") and "llm" not in companion.last_errors

    def _chatter_brain(self, companion: "Companion") -> LLMClient | None:
        """The brain chosen for the chatter; rebuilt when the choice or the key changes.

        None if there's no choice (the main brain writes) or if it doesn't start
        (missing key, unknown engine): then she stays quiet.
        """
        engine = self.preferences.brain
        if not engine:
            return None
        options = companion.settings.provider_config("llm", engine)
        key = (engine, self.preferences.brain_models, tuple(sorted(options.items())))
        if key == self._brain_key:
            return self._brain
        if self._brain is not None:
            task = asyncio.get_running_loop().create_task(self._brain.close())
            self._closing.add(task)
            task.add_done_callback(self._closing.discard)
        self._brain_key = key
        try:
            self._brain = create_chatter_llm(companion.settings, engine, self.preferences.brain_models)
            self.brain_error = None
            logger.info("Chatter written by %s (%s)", engine, self.preferences.brain_models or "saved model")
        except Exception as exc:
            self._brain = None
            self.brain_error = describe_error(exc)
            logger.warning("The chatter brain (%s) doesn't start: %s", engine, self.brain_error)
        return self._brain

    async def _say(self, companion: "Companion", key: str, *, event: str, prefix: str | None = None, **values: Any) -> None:
        """A ready phrase, with its gesture. For languages without ready phrases the brain rewrites it."""
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
                brain=self._chatter_brain(companion),
            )
            return
        text = self._render(table or TEMPLATES["en"], key, prefix, values)
        await companion.announce(text, self.broadcast, event=event)

    def _render(self, table: dict[str, list[str]], key: str, prefix: str | None, values: dict[str, Any]) -> str:
        text = self.rng.choice(table[key]).format(**values)
        return (self.rng.choice(table[prefix]) + text) if prefix else text

    async def _ask(self, companion: "Companion", prompt: str, gesture: str | None = None) -> None:
        """A comment written by the brain, with the message asking for it hidden."""
        if gesture:
            await self.broadcast({"type": "gesture", "name": gesture})
        await companion.chat(prompt, self.broadcast, hidden=True, brain=self._chatter_brain(companion))

    def status(self) -> dict[str, Any]:
        companion = self._companion()
        error = self.brain_error or (companion.last_errors.get("chatter") if companion else None)
        return {
            "lastAny": self.last_any,
            "last": dict(self.last),
            "nextChatterAt": self.next_chatter_at,
            "weather": self.last_condition,
            "brain": self.preferences.brain,
            "brainError": error if self.preferences.brain else None,
        }

