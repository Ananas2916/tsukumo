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
