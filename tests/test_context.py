"""The PC's context: foreground window -> activity, do not disturb, session."""

import pytest

from backend import server
from backend.context import PCContext, classify, page_title
from backend.system import battery


def app(title, exe, fullscreen=False):
    return {"title": title, "exe": exe, "fullscreen": fullscreen, "own": False}


@pytest.mark.parametrize(
    ("title", "exe", "kind", "label", "detail"),
    [
        ("(318) Attraversare il paese con 0€ - YouTube - Google Chrome", "chrome.exe", "youtube", "YouTube", "Attraversare il paese con 0€"),
        ("Lo-fi beats - YouTube Music - Google Chrome", "chrome.exe", "music", "YouTube Music", "Lo-fi beats"),
        ("Never Gonna Give You Up - YouTube e altre 2 pagine - Personale - Microsoft​ Edge", "msedge.exe", "youtube", "YouTube", "Never Gonna Give You Up"),
        ("YouTube — Mozilla Firefox", "firefox.exe", "browsing", "Firefox", "YouTube"),
        ("Stranger Things | Netflix - Google Chrome", "chrome.exe", "video", "Netflix", "Stranger Things | Netflix"),
        ("filippo/tsukumo: companion - GitHub - Google Chrome", "chrome.exe", "coding", "Chrome", "filippo/tsukumo: companion - GitHub"),
        ("Meet - abc-defg-hij - Google Chrome", "chrome.exe", "meeting", "Google Meet", "Meet - abc-defg-hij"),
        ("server.py - desk-companion - Visual Studio Code", "Code.exe", "coding", "VS Code", "server.py - desk-companion - Visual Studio Code"),
        ("Chat | Microsoft Teams", "ms-teams.exe", "chat", "Teams", "Chat | Microsoft Teams"),
        ("Riunione con Marco | Microsoft Teams", "ms-teams.exe", "meeting", "Teams", "Riunione con Marco | Microsoft Teams"),
        ("Spotify Premium", "Spotify.exe", "music", "Spotify", "Spotify Premium"),
        ("", "explorer.exe", "desktop", "the desktop", ""),
    ],
)
def test_foreground_window_becomes_an_activity(title, exe, kind, label, detail):
    activity = classify(app(title, exe))
    assert (activity.kind, activity.label, activity.detail) == (kind, label, detail)


def test_fullscreen_means_do_not_disturb():
    game = classify(app("Elden Ring", "eldenring.exe", fullscreen=True))
    assert game.kind == "game" and game.dnd and game.watching
    video = classify(app("Film - YouTube - Google Chrome", "chrome.exe", fullscreen=True))
    assert video.kind == "youtube" and video.dnd
    assert not classify(app("main.py - VS Code", "Code.exe")).dnd
    assert classify({"own": True}).kind == "tsukumo"
    assert classify(None).kind == "unknown"


def test_page_title_strips_the_browser():
    assert page_title("Ciao - Google Chrome") == "Ciao"
    assert page_title("Ciao — Mozilla Firefox") == "Ciao"


def test_session_survives_short_pauses_and_ends_after_a_break():
    pc = PCContext()
    coding = app("x - VS Code", "Code.exe")
    assert pc.update(2, False, coding, now=1000) is True
    assert pc.session_start == 1000
    pc.update(400, False, coding, now=1600)  # away for 6 minutes: the session is still open
    assert pc.session_start == 1000 and not pc.present_at()
    pc.update(700, False, coding, now=1900)  # a real break
    assert pc.session_start is None
    pc.update(1, False, coding, now=2000)
    assert pc.session_minutes(now=2600) == pytest.approx(10)


def test_watching_a_video_without_touching_anything_is_still_present():
    pc = PCContext()
    pc.update(900, False, app("Documentario - YouTube - Google Chrome", "chrome.exe"), now=10)
    assert pc.present_at() is True
    pc.update(900, True, None, now=20)
    assert pc.activity.kind == "locked" and pc.present_at() is False


def test_same_activity_is_not_a_change():
    pc = PCContext()
    assert pc.update(1, False, app("a - VS Code", "Code.exe"), now=1) is True
    assert pc.update(3, False, app("a - VS Code", "Code.exe"), now=6) is False
    assert pc.activity_seconds(now=16) == 15


def test_context_endpoint_broadcasts_only_changes(client, monkeypatch):
    sent = []

    async def record(message):
        sent.append(message)

    monkeypatch.setattr(server, "PC", PCContext())
    monkeypatch.setattr(server.hub, "broadcast", record)
    body = {"idle": 1, "locked": False, "app": app("Video - YouTube - Google Chrome", "chrome.exe")}
    reply = client.post("/api/context", json=body).json()
    assert reply["activity"]["kind"] == "youtube" and reply["activity"]["watching"] is True
    client.post("/api/context", json=body)
    assert len(sent) == 1 and sent[0]["type"] == "context"
    assert client.get("/api/context").json()["activity"]["detail"] == "Video"


def test_battery_reading_never_raises():
    reading = battery()
    assert reading is None or 0 <= reading.percent <= 100


def test_phantom_input_does_not_keep_her_company():
    """Windows says "someone's here" all night (idle 0): the cursor and the window say otherwise."""
    pc = PCContext()
    files = app("Documenti", "explorer.exe")
    pc.update(0, False, files, now=0, still=0)
    assert pc.present_at() and pc.session_start == 0
    pc.update(0, False, files, now=10 * 60, still=10 * 60)  # typing without the mouse: still there
    assert pc.present_at()
    pc.update(0, False, files, now=21 * 60, still=21 * 60)
    assert not pc.present_at()
    pc.update(0, False, files, now=26 * 60, still=26 * 60)
    assert pc.session_start is None
    pc.update(0, False, files, now=27 * 60, still=0)  # the mouse moves: back, a new session
    assert pc.present_at() and pc.session_start == 27 * 60


def test_a_stopped_heartbeat_is_a_break():
    """No updates for longer than a break: the PC slept or the shell was closed."""
    pc = PCContext()
    coding = app("x - VS Code", "Code.exe")
    pc.update(1, False, coding, now=1000, still=1)
    pc.update(1, False, coding, now=1005, still=1)
    assert pc.session_start == 1000
    pc.update(1, False, coding, now=1005 + 3 * 3600, still=1)
    assert pc.session_start == 1005 + 3 * 3600


def test_watching_counts_as_presence_but_not_forever():
    pc = PCContext()
    video = app("Documentario - YouTube - Google Chrome", "chrome.exe")
    pc.update(5000, False, video, now=10, still=2 * 3600)
    assert pc.present_at()
    pc.update(9000, False, video, now=20, still=4 * 3600)
    assert not pc.present_at()


def test_saying_you_are_away_holds_until_a_sign_of_life():
    pc = PCContext()
    coding = app("x - VS Code", "Code.exe")
    pc.update(0, False, coding, now=100, still=5)
    pc.mark_away(now=100)
    assert not pc.present_at() and pc.session_start is None
    pc.update(0, False, coding, now=130, still=0)  # the last click on the way out
    assert not pc.present_at()
    pc.update(0, False, coding, now=600, still=470)  # phantom input, nothing moved since then
    assert not pc.present_at() and pc.session_start is None
    pc.update(0, False, coding, now=900, still=0)  # back at the mouse
    assert pc.present_at() and pc.session_start == 900


def test_context_endpoint_takes_the_heartbeat(client, monkeypatch):
    async def record(message):
        pass

    monkeypatch.setattr(server, "PC", PCContext())
    monkeypatch.setattr(server.hub, "broadcast", record)
    body = {"idle": 0, "still": 1800, "locked": False, "app": {**app("Documenti", "explorer.exe"), "handle": 42}}
    client.post("/api/context", json=body)
    state = client.get("/api/context").json()
    assert state["still"] == 1800 and state["present"] is False
    assert client.post("/api/context", json={**body, "still": -1}).status_code == 422
