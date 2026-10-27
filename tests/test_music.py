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
from backend.spotify_app import (
    AppError,
    AppState,
    LibraryItem,
    Row,
    parse_title,
    pick_library,
    pick_row,
    same_track,
    split_item,
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


class FakeApp:
    """Spotify's desktop app: what it plays, what it can't find."""

    def __init__(self, available=False, state=None):
        self.available = available
        self.now = state or AppState()
        self.played = []
        self.missing = set()
        self.items = []

    async def state(self):
        return self.now

    async def library(self, max_age=600.0):
        return self.items

    async def play_playlist(self, wanted):
        item = pick_library(self.items, wanted)
        if item is None:
            raise AppError("I didn't find that playlist in your Spotify library.", "NO_PLAYLIST")
        self.played.append(f"playlist {item.name}")
        return self.now

    async def play(self, item):
        self.played.append(item)
        if item in self.missing:
            raise AppError("I didn't find that song in Spotify's app.", "APP_NOT_FOUND")
        artist, title = split_item(item)
        self.now = AppState(open=True, playing=True, artist=artist, title=title)
        return self.now


def _service(tmp_path, now=None, connected=True, app=None):
    service = MusicService(tmp_path, "http://127.0.0.1:8770/api/music/spotify/callback", app=app or FakeApp())
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


# ---------------------------------------------------------------------------
# The desktop app, without the API (Free, or nothing connected)
# ---------------------------------------------------------------------------
def _row(name, links=(), buttons=()):
    return Row(name, tuple(links), tuple(buttons))


# Recorded from Spotify's app (Italian, Free) searching "Hajnal Venetian Snares",
# plus a few made up to cover remixes, covers and playlists.
_ROWS = [
    _row("Hajnal", ["Hajnal", "Venetian Snares"], ["Altre opzioni per Hajnal", "Aggiungi a Brani che ti piacciono", "Play"]),
    _row("Hajnal2", ["Hajnal2", "Venetian Snares"], ["Riproduci Hajnal2", "Altre opzioni per Hajnal2", "Aggiungi a Brani che ti piacciono"]),
    _row("Venetian Snares", ["Venetian Snares"], ["Riproduci Venetian Snares", "Altre opzioni per Venetian Snares", "Segui Venetian Snares"]),
    _row("Szamár Madár", ["Szamár Madár", "Venetian Snares"], ["Riproduci Szamár Madár", "Altre opzioni per Szamár Madár"]),
    _row("Venetian Snares Mix", ["Venetian Snares Mix", "Spotify"], ["Riproduci Venetian Snares Mix", "Altre opzioni per Venetian Snares Mix"]),
    _row("Kyoto (Live)", ["Kyoto (Live)", "Phoebe Bridgers"], ["Riproduci Kyoto (Live)"]),
    _row("Kyoto", ["Kyoto", "Phoebe Bridgers"], ["Riproduci Kyoto"]),
    _row("Motion Sickness", ["Motion Sickness", "Phoebe Bridgers"], ["Pausa Motion Sickness"]),
    _row("Perché Sì", ["Perché Sì", "Café Tacvba"], ["Play Perché Sì"]),
    _row("Gentleman", ["Gentleman", "Someone Else"], ["Riproduci Gentleman"]),
]


@pytest.mark.parametrize(
    ("artist", "title", "picked"),
    [
        ("Venetian Snares", "Hajnal", (0, "Play")),  # the top result, not "Hajnal2", not the player bar's Play
        ("", "Hajnal", (0, "Play")),
        ("Venetian Snares", "Hajnal - Remastered 2011", (0, "Play")),
        ("Venetian Snares", "Szamar Madar", (3, "Riproduci Szamár Madár")),  # accents and case don't matter
        ("Phoebe Bridgers", "Kyoto", (6, "Riproduci Kyoto")),  # the studio one, below the live one
        ("Phoebe Bridgers", "Motion Sickness", None),  # only its Pause button: it's already playing
        ("Mitski", "Hajnal", None),  # the title is there, by someone else
        ("Venetian Snares", "Gentleman", None),
        ("Venetian Snares", "Venetian Snares Mix", None),  # a playlist by Spotify
        ("Cafe Tacuba", "Perche Si", (8, "Play Perché Sì")),  # half the artist is enough
        ("Venetian Snares", "Sajtban", None),
    ],
)
def test_the_app_row_is_picked_by_title_and_artist(artist, title, picked):
    assert pick_row(_ROWS, artist, title) == picked


def test_app_rows_survive_powershell_json():
    # A list of one comes back as the item itself.
    assert Row.from_json({"name": "Hajnal", "links": "Hajnal", "buttons": ["Play"]}) == _row("Hajnal", ["Hajnal"], ["Play"])
    assert Row.from_json({"links": []}) is None


def test_the_app_window_title_says_what_is_playing():
    assert parse_title("Venetian Snares - Hajnal") == AppState(True, True, "Venetian Snares", "Hajnal")
    assert parse_title("Spotify Free") == AppState(open=True)
    assert parse_title("") == AppState()
    assert parse_title("Advertisement") == AppState(open=True)
    playing = parse_title("Phoebe Bridgers - Motion Sickness - Live")
    assert same_track(playing, "Phoebe Bridgers", "Motion Sickness")
    assert same_track(playing, "", "Motion Sickness (feat. Someone)")
    assert not same_track(playing, "Mitski", "Motion Sickness")
    assert not same_track(playing, "Phoebe Bridgers", "Kyoto")
    assert split_item("Venetian Snares - Hajnal") == ("Venetian Snares", "Hajnal")
    assert split_item("Hajnal") == ("", "Hajnal")


def test_without_spotify_connected_the_app_plays_one_song(tmp_path):
    app = FakeApp(available=True)
    app.missing = {"Nessuno - Mai"}
    service = _service(tmp_path, connected=False, app=app)
    tag = "[[music: play Nessuno - Mai; Venetian Snares - Hajnal; Mitski - Nobody]]"
    assert asyncio.run(service.run_tags([tag])) is None
    # The first wasn't there, the second plays, the third is never searched.
    assert app.played == ["Nessuno - Mai", "Venetian Snares - Hajnal"]
    assert "un brano alla volta" in asyncio.run(service.run_tags(["[[music: queue Mitski - Nobody]]"], "it"))
    app.missing = {"A - B", "C - D"}
    assert "Spotify's app" in asyncio.run(service.run_tags(["[[music: play A - B; C - D]]"]))


def test_with_a_free_account_the_app_plays_what_the_search_found(tmp_path):
    app = FakeApp(available=True)
    service = _service(tmp_path, app=app)
    service.spotify.catalog = {"Kyoto": _track("k", "Kyoto")}
    service.spotify.fail["play"] = SpotifyError("Premium required", "PREMIUM_REQUIRED", 403)
    assert asyncio.run(service.run_tags(["[[music: play Kyoto]]"])) is None
    assert app.played == ["Phoebe Bridgers - Kyoto"]  # Spotify's exact names, not the brain's


def test_without_spotify_connected_the_brain_learns_of_the_app(tmp_path):
    app = FakeApp(available=True, state=AppState(True, True, "Venetian Snares", "Hajnal"))
    service = _service(tmp_path, connected=False, app=app)
    note = asyncio.run(service.directive("che genere è questa canzone?"))
    assert '"Hajnal" by Venetian Snares' in note and "ONE real song" in note
    asyncio.run(service.run_tags(["[[music: like]]"]))
    assert service.taste.data["liked"] == ["Venetian Snares - Hajnal"]
    assert service.status()["app"] is True


# Recorded from the app's side bar ("La tua libreria").
_LIBRARY = [
    LibraryItem("🎐", "🎐 In evidenza Playlist • tsu𝓴i"),
    LibraryItem("Русский", "Русский Playlist • Sir_Muller"),
    LibraryItem("Brani che ti piacciono", "Brani che ti piacciono Playlist • Sir_Muller"),
    LibraryItem("tsu𝓴i + Sir_Muller", "tsu𝓴i + Sir_Muller Playlist • Solo per Sir_Muller"),
    LibraryItem("Applause", "Applause Singolo • Lady Gaga"),
    LibraryItem("Si", "Si Playlist • Sir_Muller"),
]


@pytest.mark.parametrize(
    ("wanted", "name"),
    [
        ("🎐", "🎐"),  # a name with no letters at all
        ("🎐 In evidenza", "🎐"),
        ("русский", "Русский"),
        ("Brani che ti piacciono", "Brani che ti piacciono"),
        ('"Si"', "Si"),  # not "tsu𝓴i + Sir_Muller", not "Brani che ti piacciono"
        ("Applause Lady Gaga", "Applause"),
        ("Discover Weekly", None),
    ],
)
def test_the_library_item_is_picked_by_name(wanted, name):
    item = pick_library(_LIBRARY, wanted)
    assert (item.name if item else None) == name


def test_a_playlist_of_the_library_is_played_and_offered_to_the_brain(tmp_path):
    app = FakeApp(available=True, state=AppState(open=True))
    app.items = _LIBRARY
    service = _service(tmp_path, connected=False, app=app)
    note = asyncio.run(service.directive("metti la playlist che ascolto di solito"))
    assert '"🎐 In evidenza Playlist • tsu𝓴i"' in note and "[[music: playlist" in note
    assert "Never drive Spotify yourself" in note
    assert music_tag("[[music: playlist 🎐]]") == ("playlist", ["🎐"])
    assert asyncio.run(service.run_tags(["[[music: playlist Русский]]"])) is None
    assert app.played == ["playlist Русский"]
    assert "Non ho trovato quella playlist" in asyncio.run(service.run_tags(["[[music: playlist Discover Weekly]]"], "it"))


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


def test_the_island_player_controls_spotify(client, monkeypatch):
    from backend import server

    actions = []

    async def control(action):
        actions.append(action)

    monkeypatch.setattr(server.MUSIC, "control", control)
    for action in ("pause", "resume", "next", "previous"):
        assert client.post("/api/music/control", json={"action": action}).json() == {"ok": True}
    assert actions == ["pause", "resume", "next", "previous"]
    # Anything else isn't a player button.
    assert client.post("/api/music/control", json={"action": "play spotify:track:x"}).status_code == 422


def test_the_island_player_explains_a_refusal(client, monkeypatch):
    from backend import server

    async def control(action):
        raise SpotifyError("I can't press the media keys here.", "NO_KEYS")

    monkeypatch.setattr(server.MUSIC, "control", control)
    response = client.post("/api/music/control", json={"action": "next"})
    assert response.status_code == 409
    assert "media keys" in response.json()["error"]
