"""The weather where you are, to comment on it ("what a sunny day!").

It uses Open-Meteo: free, no key, no account. The position is the city
written in the panel (Open-Meteo's geocoding) or, if it's empty, the
approximate one of the IP address (get.geojs.io). The result stays in memory
for half an hour: the companion doesn't query the service more often than
that.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
IP_LOCATION_URL = "https://get.geojs.io/v1/ip/geo.json"
CACHE_SECONDS = 30 * 60


@dataclass(frozen=True)
class Weather:
    temperature: float
    #: Apparent temperature: it's what makes you say "so hot" or "so cold".
    apparent: float
    #: WMO code (0 clear, 61 rain, 95 thunderstorm...).
    code: int
    is_day: bool
    city: str = ""
    fetched_at: float = 0.0
    #: The next days (today included), for the dashboard: date, min, max, code, rain %.
    days: tuple[tuple[str, float, float, int, int], ...] = ()

    @property
    def condition(self) -> str:
        """clear, cloudy, fog, rain, snow, storm."""
        return condition_of(self.code)

    @property
    def feel(self) -> str:
        """hot, cold or mild, on the apparent temperature."""
        if self.apparent >= 30:
            return "hot"
        if self.apparent <= 5:
            return "cold"
        return "mild"

    def as_dict(self) -> dict[str, Any]:
        return {
            "temperature": round(self.temperature),
            "apparent": round(self.apparent),
            "condition": self.condition,
            "feel": self.feel,
            "isDay": self.is_day,
            "city": self.city,
            "days": [
                {"date": day, "min": round(low), "max": round(high), "condition": condition_of(code), "rain": rain}
                for day, low, high, code, rain in self.days
            ],
        }


def condition_of(code: int) -> str:
    """WMO weather codes -> one word."""
    if code in (0, 1):
        return "clear"
    if code in (2, 3):
        return "cloudy"
    if code in (45, 48):
        return "fog"
    if 51 <= code <= 67 or 80 <= code <= 82:
        return "rain"
    if 71 <= code <= 77 or code in (85, 86):
        return "snow"
    if code >= 95:
        return "storm"
    return "cloudy"


class WeatherService:
    """Weather with a cache; ``get`` never raises (``None`` if it isn't known)."""

    def __init__(self, client_factory=None) -> None:
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=8.0))
        self._cached: Weather | None = None
        self._cached_for = ""
        self._location: tuple[float, float, str] | None = None
        self._location_for: str | None = None

    async def get(self, city: str = "", language: str = "it") -> Weather | None:
        key = city.strip().lower()
        if self._cached and self._cached_for == key and time.time() - self._cached.fetched_at < CACHE_SECONDS:
            return self._cached
        try:
            async with self._client_factory() as client:
                location = await self._locate(client, city, language)
                if location is None:
                    return None
                weather = await self._fetch(client, *location)
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            logger.info("Weather unavailable: %s", exc)
            return self._cached
        self._cached, self._cached_for = weather, key
        return weather

    async def _locate(self, client: httpx.AsyncClient, city: str, language: str) -> tuple[float, float, str] | None:
        if self._location is not None and self._location_for == city:
            return self._location
        if city.strip():
            response = await client.get(GEOCODING_URL, params={"name": city.strip(), "count": 1, "language": language, "format": "json"})
            response.raise_for_status()
            results = response.json().get("results") or []
            if not results:
                logger.info("City not found for the weather: %r", city)
                return None
            place = results[0]
            location = (float(place["latitude"]), float(place["longitude"]), str(place.get("name") or city))
        else:
            response = await client.get(IP_LOCATION_URL)
            response.raise_for_status()
            data = response.json()
            location = (float(data["latitude"]), float(data["longitude"]), str(data.get("city") or ""))
        self._location, self._location_for = location, city
        return location

    async def _fetch(self, client: httpx.AsyncClient, latitude: float, longitude: float, city: str) -> Weather:
        response = await client.get(
            FORECAST_URL,
            params={
                "latitude": latitude,
                "longitude": longitude,
                "current": "temperature_2m,apparent_temperature,weather_code,is_day",
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                "forecast_days": 5,
                "timezone": "auto",
            },
        )
        response.raise_for_status()
        data = response.json()
        current = data["current"]
        return Weather(
            temperature=float(current["temperature_2m"]),
            apparent=float(current.get("apparent_temperature", current["temperature_2m"])),
            code=int(current.get("weather_code", 0)),
            is_day=bool(current.get("is_day", 1)),
            city=city,
            fetched_at=time.time(),
            days=forecast_days(data.get("daily") or {}),
        )


def forecast_days(daily: dict[str, Any]) -> tuple[tuple[str, float, float, int, int], ...]:
    """Open-Meteo's ``daily`` columns -> one row per day (incomplete rows are skipped)."""
    columns = [daily.get(key) or [] for key in ("time", "temperature_2m_min", "temperature_2m_max", "weather_code", "precipitation_probability_max")]
    days = []
    for day, low, high, code, rain in zip(*columns):
        if day is None or low is None or high is None:
            continue
        days.append((str(day), float(low), float(high), int(code or 0), int(rain or 0)))
    return tuple(days)
