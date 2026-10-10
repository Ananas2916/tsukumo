"""Music: the brain's tags, quick commands, taste and the service (with a fake Spotify)."""

import asyncio
from urllib.parse import parse_qs, urlparse

import pytest

from backend import music
from backend.music import (
    MusicService,
    NowPlaying,
    SpotifyClient,
    SpotifyError,
    TasteProfile,
    Track,
    music_tag,
    parse_command,
)


def _track(id_="t1", title="Motion Sickness", artist="Phoebe Bridgers", duration=230.0):
    return Track(id=id_, uri=f"spotify:track:{id_}", title=title, artists=(artist,), artist_ids=(f"a-{artist}",), album="Stranger in the Alps", year="2017", duration=duration)


class FakeSpotify:
    """What MusicService uses of SpotifyClient, recording the calls."""

    def __init__(self, now=None, connected=True):
        self.connected = connected
        self.configured = connected
        self.user = "filip"
        self.now = now
        self.calls = []
        self.catalog = {}
        self.fail = {}

    async def _maybe_fail(self, name):
        if name in self.fail:
            error = self.fail[name]
            if isinstance(error, list):
                error = error.pop(0) if error else None
                if error is None:
                    return
            raise error

    async def now_playing(self):
        return self.now

    async def search(self, query):
        self.calls.append(("search", query))
        return self.catalog.get(query)

    async def play(self, uris, device_id=""):
        self.calls.append(("play", tuple(uris), device_id))
        await self._maybe_fail("play")

    async def queue(self, uri):
        self.calls.append(("queue", uri))

    async def control(self, action):
        self.calls.append(("control", action))
        await self._maybe_fail("control")

    async def devices(self):
        return [{"id": "phone", "type": "Smartphone"}, {"id": "pc", "type": "Computer"}]

    async def save(self, track):
        self.calls.append(("save", track.id))

    async def artist_genres(self, artist_id):
        return ["indie pop", "sad girl"]

    async def top_artists(self):
        return []

    async def close(self):
        pass


def _service(tmp_path, now=None, connected=True):
    service = MusicService(tmp_path, "http://127.0.0.1:8770/api/music/spotify/callback")
    service.spotify = FakeSpotify(now, connected)
    return service


# ---------------------------------------------------------------------------
# Tags and commands
# ---------------------------------------------------------------------------
def test_music_tags_are_parsed():
    assert music_tag("[[music: play Phoebe Bridgers - Kyoto; boygenius - Not Strong Enough]]") == (
        "play",
        ["Phoebe Bridgers - Kyoto", "boygenius - Not Strong Enough"],
    )
    assert music_tag('[[music: queue "Mitski - Nobody"]]') == ("queue", ["Mitski - Nobody"])
    assert music_tag("[[MUSIC: skip]]") == ("next", [])
    assert music_tag("[[music:love]]") == ("like", [])
    assert music_tag("[[music: dance]]") is None
    assert music_tag("[[remember: ama il jazz]]") is None


@pytest.mark.parametrize(
    ("text", "action"),
    [
        ("metti in pausa la musica", "pause"),
        ("Ehi Tsukumo, ferma la musica per favore", "pause"),
        ("pause the music", "pause"),
        ("riprendi la musica", "resume"),
        ("prossima canzone", "next"),
        ("salta questa canzone!", "next"),
        ("skip this song", "next"),
        ("canzone precedente", "previous"),
        ("fai una pausa", None),
        ("salta", None),
        ("che genere è questa canzone?", None),
        ("metti in pausa il timer", None),
    ],
)
def test_player_commands(text, action):
    assert parse_command(text) == action


# ---------------------------------------------------------------------------
# Taste
# ---------------------------------------------------------------------------
def test_taste_learns_from_listening_and_survives_a_restart(tmp_path):
    path = tmp_path / "music_taste.json"
    taste = TasteProfile(path)
    for _ in range(3):
        taste.observe(_track(), heard=True, skipped=False)
    taste.observe(_track("t2", "Song", "Nickelback"), heard=False, skipped=True)
    taste.dislike(_track("t2", "Song", "Nickelback"))
    taste.like(_track("t3", "Kyoto"))
    taste.set_top([("Mitski", ["indie pop", "art pop"]), ("Phoebe Bridgers", ["indie pop"])])

    again = TasteProfile(path)
    assert again.favourites()[0] == "Phoebe Bridgers"
    assert "Mitski" in again.favourites()
    assert again.avoided() == ["Nickelback"]
    summary = again.summary()
    assert "favourite artists: Phoebe Bridgers" in summary
    assert "favourite genres: indie pop, art pop" in summary
    assert "Phoebe Bridgers - Kyoto" in summary
    assert "Nickelback" in summary.split("they don't like:")[1]
    again.forget()
    assert TasteProfile(path).summary() == ""


def test_liking_after_disliking_moves_the_song(tmp_path):
    taste = TasteProfile(None)
    taste.dislike(_track())
    taste.like(_track())
    assert taste.data["liked"] == ["Phoebe Bridgers - Motion Sickness"] and taste.data["disliked"] == []


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------
def test_directive_only_when_talking_about_music(tmp_path):
    service = _service(tmp_path, NowPlaying(_track(), playing=True, progress=40))

    async def run():
        assert await service.directive("che tempo fa domani?") == ""
        note = await service.directive("di che genere è questa canzone?")
        # "vorrei sentirne di simili" doesn't name music, but it's the follow-up.
        follow = await service.directive("e dimmi, ne conosci altri così?")
        assert await service.directive("scrivimi una mail") != ""  # one more turn on topic
        assert await service.directive("e poi?") == ""
        return note, follow

    note, follow = asyncio.run(run())
    assert '"Motion Sickness" by Phoebe Bridgers (Stranger in the Alps, 2017)' in note
    assert "indie pop" in note and "[[music: play" in note
    assert "[[music: play" in follow


def test_directive_is_silent_without_spotify(tmp_path):
    service = _service(tmp_path, connected=False)
    assert asyncio.run(service.directive("metti un po' di musica")) == ""


def test_play_tag_searches_and_plays_on_the_computer_when_nothing_is_active(tmp_path):
    service = _service(tmp_path)
    kyoto, nobody = _track("k", "Kyoto"), _track("n", "Nobody", "Mitski")
    service.spotify.catalog = {"track:Kyoto artist:Phoebe Bridgers": kyoto, "Mitski Nobody": nobody}
    service.spotify.fail["play"] = [SpotifyError("No active device", "NO_ACTIVE_DEVICE", 404), None]

    problem = asyncio.run(service.run_tags(["[[music: play Phoebe Bridgers - Kyoto; Mitski - Nobody; Nessuno - Mai]]"]))
    assert problem is None
    plays = [call for call in service.spotify.calls if call[0] == "play"]
    assert plays == [("play", ("spotify:track:k", "spotify:track:n"), ""), ("play", ("spotify:track:k", "spotify:track:n"), "pc")]


def test_play_problems_are_explained(tmp_path):
    service = _service(tmp_path)
    service.spotify.catalog = {"Kyoto": _track("k", "Kyoto")}
    service.spotify.fail["play"] = SpotifyError("Premium required", "PREMIUM_REQUIRED", 403)
    assert "Premium" in asyncio.run(service.run_tags(["[[music: play Kyoto]]"]))
    assert "I didn't find" in asyncio.run(service.run_tags(["[[music: play Nessuno - Mai]]"]))
    # Said aloud in the voice's language.
    assert "Non ho trovato" in asyncio.run(service.run_tags(["[[music: play Nessuno - Mai]]"], "it"))


def test_controls_fall_back_to_media_keys_without_premium(tmp_path, monkeypatch):
    pressed = []
    monkeypatch.setattr(music, "press_media_key", lambda key: pressed.append(key) or True)
    service = _service(tmp_path)
    service.spotify.fail["control"] = SpotifyError("Premium required", "PREMIUM_REQUIRED", 403)
    service.now = NowPlaying(_track(), playing=True)

    assert asyncio.run(service.command("metti in pausa la musica", "it")) == "Musica in pausa."
    assert asyncio.run(service.command("riprendi la musica", "it")) == "Si riparte!"  # already playing: no key press
    assert asyncio.run(service.command("next song", "en")) == "Here's the next one."
    assert pressed == ["toggle", "next"]
    assert asyncio.run(service.command("che genere è?", "it")) is None


def test_like_tag_learns_and_saves(tmp_path):
    service = _service(tmp_path, NowPlaying(_track(), playing=True))
    service.now = service.spotify.now
    assert asyncio.run(service.run_tags(["[[music: like]]"])) is None
    assert service.taste.data["liked"] == ["Phoebe Bridgers - Motion Sickness"]
    assert ("save", "t1") in service.spotify.calls


def test_listening_and_skipping_are_observed(tmp_path):
    service = _service(tmp_path)
    service.now = NowPlaying(_track(), playing=True, progress=200)
    service._observe(NowPlaying(_track("t2", "Song", "Nickelback"), playing=True, progress=1))
    service.now = NowPlaying(_track("t2", "Song", "Nickelback"), playing=True, progress=12)
    service._observe(NowPlaying(_track("t3", "Kyoto"), playing=True, progress=1))
    artists = service.taste.data["artists"]
    assert artists["Phoebe Bridgers"]["plays"] == 1
    assert artists["Nickelback"]["skips"] == 1


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------
def test_authorize_url_uses_pkce_and_validates_the_client_id(tmp_path):
    client = SpotifyClient(tmp_path / "spotify.json")
    with pytest.raises(ValueError):
        client.set_client_id("non-un-id")
    client.set_client_id("0123456789abcdef0123456789abcdef")
    query = parse_qs(urlparse(client.authorize_url("http://127.0.0.1:8770/cb")).query)
    assert query["client_id"] == ["0123456789abcdef0123456789abcdef"]
    assert query["code_challenge_method"] == ["S256"] and len(query["code_challenge"][0]) == 43
    assert "user-modify-playback-state" in query["scope"][0]
    assert query["state"][0] in client._pending
    # The Client ID stays after a restart; without a token it isn't "connected".
    again = SpotifyClient(tmp_path / "spotify.json")
    assert again.configured and not again.connected


def test_music_tags_are_executed_and_not_scheduled_as_reminders(client):
    from backend import server

    instance = server.app.state.companion
    seen = []

    class Recorder:
        async def run_tags(self, tags, language="en"):
            seen.extend(tags)
            return None

    original = instance.music
    instance.music = Recorder()
    try:
        client.portal.call(instance._schedule_from_tags, ["[[music: pause]]"])
    finally:
        instance.music = original
    assert seen == ["[[music: pause]]"]
