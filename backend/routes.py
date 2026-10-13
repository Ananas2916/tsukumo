"""How long it takes to get somewhere: for "you should leave in 15 minutes".

Free and without keys, on OpenStreetMap: Nominatim finds the address
(politely: one request at a time, results kept in ``state/places.json``)
and the FOSSGIS OSRM servers give the travel time by car, bike or on foot.
Public transport isn't there: for it a fixed margin is used instead.

Only addresses from the user's own calendar and their home are looked up.
Nothing here ever runs in /api/health or at startup.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx

from .notebook import fold

logger = logging.getLogger(__name__)

GEOCODER = "https://nominatim.openstreetmap.org/search"
ROUTER = "https://routing.openstreetmap.de/routed-{profile}/route/v1/driving/{a};{b}"
PROFILES = {"car": "car", "bike": "bike", "foot": "foot"}
#: Without a route (transit, server down): this long, roughly.
FALLBACK_MINUTES = {"transit": 40, "car": 30, "bike": 30, "foot": 30}
ROUTE_CACHE = 30 * 60
USER_AGENT = "Tsukumo-desktop-companion/3 (https://github.com/Ananas2916/tsukumo)"


class Routes:
    def __init__(self, path: Path | None, client: httpx.AsyncClient | None = None) -> None:
        self.path = path
        self._client = client
        self._places: dict[str, list[float] | None] = {}
        self._routes: dict[tuple[str, str, str], tuple[float, float]] = {}
        self._lock = asyncio.Lock()
        self._last_geocode = 0.0
        if path and path.is_file():
            try:
                self._places = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self._places = {}

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self._places, ensure_ascii=False), encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError:
            pass

    async def _get(self, url: str, params: dict[str, Any] | None = None) -> Any:
        client = self._client or httpx.AsyncClient(timeout=15, headers={"User-Agent": USER_AGENT})
        try:
            response = await client.get(url, params=params)
            response.raise_for_status()
            return response.json()
        finally:
            if self._client is None:
                await client.aclose()

    async def place(self, address: str) -> tuple[float, float] | None:
        """(lat, lon) of an address, or None if it can't be found (also remembered)."""
        key = fold(address)
        if not key:
            return None
        if key in self._places:
            found = self._places[key]
            return (found[0], found[1]) if found else None
        async with self._lock:
            # Nominatim's policy: at most one request a second.
            wait = 1.1 - (time.monotonic() - self._last_geocode)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_geocode = time.monotonic()
            try:
                rows = await self._get(GEOCODER, {"q": address, "format": "json", "limit": 1})
            except Exception as exc:
                logger.info("Address not looked up (%s)", type(exc).__name__)
                return None  # not remembered: maybe the network comes back
        found = [float(rows[0]["lat"]), float(rows[0]["lon"])] if rows else None
        self._places[key] = found
        self._save()
        return (found[0], found[1]) if found else None

    async def minutes(self, origin: str, destination: str, mode: str = "car") -> tuple[float, bool] | None:
        """Travel minutes and whether it's a real route (False = the rough margin); None if no place is known."""
        mode = mode if mode in FALLBACK_MINUTES else "car"
        start = await self.place(origin)
        end = await self.place(destination)
        if start is None or end is None:
            return None
        if mode not in PROFILES:
            return float(FALLBACK_MINUTES[mode]), False
        key = (f"{start[0]:.4f},{start[1]:.4f}", f"{end[0]:.4f},{end[1]:.4f}", mode)
        cached = self._routes.get(key)
        if cached and time.time() - cached[1] < ROUTE_CACHE:
            return cached[0], True
        url = ROUTER.format(profile=PROFILES[mode], a=f"{start[1]},{start[0]}", b=f"{end[1]},{end[0]}")
        try:
            data = await self._get(url, {"overview": "false"})
            seconds = float(data["routes"][0]["duration"])
        except Exception as exc:
            logger.info("Route not computed (%s)", type(exc).__name__)
            return float(FALLBACK_MINUTES[mode]), False
        minutes = seconds / 60
        self._routes[key] = (minutes, time.time())
        return minutes, True
