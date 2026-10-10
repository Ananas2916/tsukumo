"""Spontaneous comments: when she speaks, what she says, when she keeps quiet."""

import random
import time
from datetime import datetime

import httpx
import pytest

from backend import server
from backend.context import PCContext
from backend.news import Headline, NewsService, parse_feed
from backend.pipeline import Companion
from backend.preferences import Preferences
from backend.proactive import MIN_GAP, Proactive, spoken_clock
from backend.system import Battery
from backend.weather import Weather, WeatherService, condition_of

from helpers import Scripted

TODAY = datetime.now().date()


def at(hour, minute=0):
    return datetime.combine(TODAY, datetime.min.time()).replace(hour=hour, minute=minute)


def window(title, exe, fullscreen=False):
    return {"title": title, "exe": exe, "fullscreen": fullscreen, "own": False}


class FakeWeather:
    def __init__(self, weather):
        self.weather = weather

    async def get(self, city="", language="it"):
        return self.weather


class FakeNews:
    def __init__(self, title):
        self.title = title

    async def pick(self, language="it"):
        return Headline(self.title, "Il Post")


@pytest.fixture
def rig(client, monkeypatch):
    """A real Proactive on the server's companion, with a whole fake world around it."""
    instance = server.app.state.companion
    sent = []

    async def record(message):
        sent.append(message)

    monkeypatch.setattr(server.hub, "broadcast", record)
    monkeypatch.setattr(instance, "history", [])
    monkeypatch.setattr(Companion, "voice_language", property(lambda self: "it"))
    context = PCContext()
    context.update(3, False, window("server.py - VS Code", "Code.exe"))
    readings = {"value": None}
    engine = Proactive(
        companion=lambda: instance,
        context=context,
        preferences=Preferences(None),
        broadcast=record,
        battery_reader=lambda: readings["value"],
        rng=random.Random(3),
    )
    engine.readings = readings
    engine.sent = sent
    # The session starts at the real time, the tests use fake times: breaks are tested separately.
    engine.next_break_minutes = 10**9
    return engine


def spoken(engine):
    return [m["text"] for m in engine.sent if m["type"] == "reply"]


def gestures(engine):
    return [m["name"] for m in engine.sent if m["type"] == "gesture"]


def test_late_night_while_coding(client, rig):
    said = client.portal.call(rig.tick, at(1, 12))
    assert said == "night:coding"
    [text] = spoken(rig)
    assert "l'una e 12" in text.lower()
    assert "yawn" in gestures(rig)
    # Right after she keeps quiet: at least 8 minutes pass between two comments.
    assert client.portal.call(rig.tick, at(1, 13)) is None


def test_never_during_fullscreen_or_meetings_or_when_away(client, rig):
    rig.context.update(2, False, window("Elden Ring", "eldenring.exe", fullscreen=True))
    assert client.portal.call(rig.tick, at(1, 30)) is None
    rig.context.update(2, False, window("Riunione | Microsoft Teams", "ms-teams.exe"))
    assert client.portal.call(rig.tick, at(1, 30)) is None
    rig.context.update(900, False, window("x - VS Code", "Code.exe"))
    assert client.portal.call(rig.tick, at(1, 30)) is None
    rig.preferences.update({"chatter": "off"}, save=False)
    rig.context.update(2, False, window("x - VS Code", "Code.exe"))
    assert client.portal.call(rig.tick, at(1, 30)) is None
    assert spoken(rig) == []


def test_battery_warns_once_per_level_until_plugged(client, rig):
    rig.readings["value"] = Battery(percent=18, plugged=False)
    assert client.portal.call(rig.tick, at(15)) == "battery:18"
    assert "18 per cento" in spoken(rig)[-1]
    assert client.portal.call(rig.tick, at(15, 1)) is None
    rig.readings["value"] = Battery(percent=4, plugged=False)
    assert client.portal.call(rig.tick, at(15, 2)) == "battery:4"  # critical: even right after
    rig.readings["value"] = Battery(percent=40, plugged=True)
    client.portal.call(rig.tick, at(15, 3))
    assert rig.battery_warned == set()


def test_break_after_two_hours(client, rig):
    now = at(16)
    rig.context.session_start = now.timestamp() - 125 * 60
    rig.next_break_minutes = 120
    assert client.portal.call(rig.tick, now) == "break:125"
    assert "2 ore" in spoken(rig)[-1] and "stretch" in gestures(rig)


def test_weather_morning_heat_and_rain(client, rig):
    # The session starts at the real time: depending on when you run the tests, at the fake
    # 14:00 a break could already be due. Only the weather is tested here.
    rig.preferences.update({"topics": {"breaks": False}}, save=False)
    rig.weather = FakeWeather(Weather(temperature=24, apparent=25, code=0, is_day=True))
    assert client.portal.call(rig.tick, at(8)) == "weather:morning-clear"
    assert spoken(rig)[-1] == "Buongiorno! Che bella giornata di sole! Fuori ci sono 24 gradi."
    rig.last_any = 0
    rig.weather = FakeWeather(Weather(temperature=33, apparent=36, code=1, is_day=True))
    assert client.portal.call(rig.tick, at(14)) == "weather:hot"
    assert "fanSelf" in gestures(rig)
    rig.last_any = 0
    rig.weather = FakeWeather(Weather(temperature=18, apparent=18, code=63, is_day=True))
    assert client.portal.call(rig.tick, at(17)) == "weather:rain"
    assert "ombrello" in spoken(rig)[-1]


def test_youtube_comment_uses_the_brain_with_a_hidden_prompt(client, rig, monkeypatch):
    # The session starts at the real time: at the fake 21:30 a break could be due. Only YouTube here.
    rig.preferences.update({"topics": {"breaks": False}}, save=False)
    instance = server.app.state.companion
    brain = Scripted(["Che canale divertente!"])
    monkeypatch.setattr(instance, "llm", brain)
    monkeypatch.setattr(Proactive, "_brain_ready", lambda self, companion: True)
    now = at(21)
    rig.context.update(1, False, window("Attraversare il paese con 0€ - YouTube - Google Chrome", "chrome.exe"))
    rig.context.activity_since = now.timestamp() - 30
    assert client.portal.call(rig.tick, now) is None  # watched for too short a time
    rig.context.activity_since = now.timestamp() - 60
    assert client.portal.call(rig.tick, now) == "youtube:Attraversare il paese con 0€"
    assert "Attraversare il paese con 0€" in brain.messages[-1].content
    assert spoken(rig) == ["Che canale divertente!"]
    assert not [m for m in rig.sent if m["type"] == "user"]  # the request stays hidden
    rig.last_any = 0
    assert client.portal.call(rig.tick, at(21, 30)) is None  # the same video isn't commented again


def test_youtube_without_a_brain_uses_a_ready_line(client, rig):
    now = at(21)
    rig.context.update(1, False, window("Lo-fi mix - YouTube - Google Chrome", "chrome.exe"))
    rig.context.activity_since = now.timestamp() - 60
    assert client.portal.call(rig.tick, now) == "youtube:Lo-fi mix"
    assert spoken(rig) == ["Oh, stai guardando «Lo-fi mix»! Sembra interessante."]


def test_chatter_waits_for_a_pause_then_comments_the_news(client, rig, monkeypatch):
    instance = server.app.state.companion
    brain = Scripted(["Wow, che notizia!"])
    monkeypatch.setattr(instance, "llm", brain)
    monkeypatch.setattr(Proactive, "_brain_ready", lambda self, companion: True)
    rig.news = FakeNews("Scoperto un nuovo pianeta")
    rig.preferences.update({"topics": {"facts": False, "films": False}}, save=False)
    now = at(18)
    assert client.portal.call(rig.tick, now) is None  # the first time sets when
    rig.next_chatter_at = now.timestamp() - 1
    assert client.portal.call(rig.tick, now) is None  # she's programming: wait
    rig.context.update(2, False, window("Meteo - Google Chrome", "chrome.exe"))
    assert client.portal.call(rig.tick, now) == "news:Scoperto un nuovo pianeta"
    assert "Scoperto un nuovo pianeta" in brain.messages[-1].content and "Il Post" in brain.messages[-1].content


def test_languages_without_ready_lines_go_through_the_brain(client, rig, monkeypatch):
    instance = server.app.state.companion
    brain = Scripted(["¡Son la una y doce!"])
    monkeypatch.setattr(instance, "llm", brain)
    monkeypatch.setattr(Proactive, "_brain_ready", lambda self, companion: True)
    monkeypatch.setattr(Companion, "voice_language", property(lambda self: "es"))
    assert client.portal.call(rig.tick, at(1, 12)) == "night:coding"
    assert "Say this to them in your own words" in brain.messages[-1].content


def test_spoken_clock():
    assert spoken_clock(at(1, 12), "it") == ("È l'una e 12", "l'una e 12")
    assert spoken_clock(at(2), "it") == ("Sono le 2", "le 2")
    assert spoken_clock(at(0, 5), "it")[0] == "È mezzanotte e 5"
    assert spoken_clock(at(13, 30), "en") == ("It's 1:30 pm", "1:30 pm")


def test_min_gap_is_reasonable():
    assert MIN_GAP >= 5 * 60


# ---------------------------------------------------------------------------
# Services: weather, news, preferences
# ---------------------------------------------------------------------------
def test_weather_service_geocodes_the_city_and_caches(client):
    calls = []

    def handler(request):
        calls.append(request.url.host)
        if "geocoding" in request.url.host:
            return httpx.Response(200, json={"results": [{"latitude": 45.46, "longitude": 9.19, "name": "Milano"}]})
        return httpx.Response(200, json={"current": {"temperature_2m": 21.4, "apparent_temperature": 22.0, "weather_code": 61, "is_day": 1}})

    service = WeatherService(client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    weather = client.portal.call(service.get, "Milano", "it")
    assert (weather.city, round(weather.temperature), weather.condition, weather.feel) == ("Milano", 21, "rain", "mild")
    client.portal.call(service.get, "Milano", "it")
    assert len(calls) == 2  # the second time from the cache


def test_weather_service_never_raises(client):
    def broken(request):
        raise httpx.ConnectError("offline")

    service = WeatherService(client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(broken)))
    assert client.portal.call(service.get, "", "it") is None


def test_weather_codes():
    assert [condition_of(code) for code in (0, 2, 45, 61, 81, 73, 95)] == ["clear", "cloudy", "fog", "rain", "rain", "snow", "storm"]


RSS = """<?xml version="1.0"?><rss><channel>
<item><title>Scoperto un nuovo pianeta - Il Post</title><source url="x">Il Post</source></item>
<item><title>Piove su Milano - ANSA</title></item>
</channel></rss>"""


def test_news_feed_is_parsed_and_headlines_are_not_repeated(client):
    assert parse_feed(RSS) == [Headline("Scoperto un nuovo pianeta", "Il Post"), Headline("Piove su Milano", "ANSA")]
    service = NewsService(
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, text=RSS))),
        rng=random.Random(1),
    )
    first = client.portal.call(service.pick, "it")
    second = client.portal.call(service.pick, "it")
    assert {first.title, second.title} == {"Scoperto un nuovo pianeta", "Piove su Milano"}
    assert client.portal.call(service.pick, "it") is None


def test_preferences_validate_and_persist(tmp_path):
    path = tmp_path / "preferences.json"
    prefs = Preferences(path)
    prefs.update({"chatter": "chatty", "city": "  Torino ", "topics": {"news": False, "bogus": True}, "evil": 1})
    again = Preferences(path)
    assert again.chatter == "chatty" and again.city == "Torino"
    assert again.topic("news") is False and again.topic("facts") is True
    assert "bogus" not in again.as_dict()["topics"] and "evil" not in again.as_dict()
    prefs.update({"chatter": "loud"})
    assert Preferences(path).chatter == "chatty"


def test_preferences_endpoint(client, monkeypatch):
    monkeypatch.setattr(server, "PREFERENCES", Preferences(None))
    assert client.get("/api/preferences").json()["chatter"] == "normal"
    changed = client.post("/api/preferences", json={"chatter": "rare", "topics": {"youtube": False}}).json()
    assert changed["chatter"] == "rare" and changed["topics"]["youtube"] is False
    assert time.time() > 0
