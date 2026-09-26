"""Titoli di giornata, perche' il companion possa commentarli.

Legge il feed RSS di Google News nella lingua del sistema (niente chiave).
Si tiene solo titolo e testata; il commento lo scrive il cervello. I titoli
gia' commentati non tornano.
"""

from __future__ import annotations

import logging
import random
import time
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

FEED_URL = "https://news.google.com/rss"
CACHE_SECONDS = 60 * 60
#: Paese per lingua, per l'edizione giusta del feed.
_COUNTRY = {"it": "IT", "en": "US", "es": "ES", "fr": "FR", "de": "DE", "pt": "BR", "ja": "JP", "zh": "CN", "hi": "IN"}


@dataclass(frozen=True)
class Headline:
    title: str
    source: str = ""


def parse_feed(xml_text: str) -> list[Headline]:
    """RSS -> titoli. "Titolo - Testata" diventa titolo e testata separati."""
    headlines = []
    root = ElementTree.fromstring(xml_text)
    for item in root.iter("item"):
        raw = (item.findtext("title") or "").strip()
        source = (item.findtext("source") or "").strip()
        if not raw:
            continue
        title = raw
        if source and raw.endswith(f" - {source}"):
            title = raw[: -len(source) - 3].strip()
        elif " - " in raw and not source:
            title, source = raw.rsplit(" - ", 1)
        headlines.append(Headline(title=title, source=source))
    return headlines


class NewsService:
    def __init__(self, client_factory=None, rng: random.Random | None = None) -> None:
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=8.0, follow_redirects=True))
        self._rng = rng or random.Random()
        self._cache: list[Headline] = []
        self._cached_at = 0.0
        self._cached_for = ""
        self.used: set[str] = set()

    async def headlines(self, language: str = "it") -> list[Headline]:
        if self._cache and self._cached_for == language and time.time() - self._cached_at < CACHE_SECONDS:
            return self._cache
        country = _COUNTRY.get(language, "US")
        params = {"hl": language, "gl": country, "ceid": f"{country}:{language}"}
        try:
            async with self._client_factory() as client:
                response = await client.get(FEED_URL, params=params)
                response.raise_for_status()
            self._cache = parse_feed(response.text)
        except (httpx.HTTPError, ElementTree.ParseError) as exc:
            logger.info("Notizie non disponibili: %s", exc)
            return self._cache
        self._cached_at, self._cached_for = time.time(), language
        return self._cache

    async def pick(self, language: str = "it") -> Headline | None:
        """Un titolo fra i primi, mai uno gia' usato."""
        fresh = [item for item in (await self.headlines(language))[:15] if item.title not in self.used]
        if not fresh:
            return None
        chosen = self._rng.choice(fresh[:8])
        self.used.add(chosen.title)
        return chosen
