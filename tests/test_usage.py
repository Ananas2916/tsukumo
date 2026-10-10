"""Agents' usage: Claude Code and Codex logs, status line, notifications, spoken."""

import base64
import json
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

import pytest

from backend import notify, server, usage
from backend.context import PCContext
from backend.pipeline import Companion
from backend.preferences import Preferences
from backend.proactive import Proactive, italian_percent
from backend.usage import UsageService, describe, tightest, wants_usage, when_words, window_words

NOW = datetime.now().astimezone()


def stamp(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def claude_line(message_id, tokens, moment=NOW, request="req"):
    return {
        "type": "assistant",
        "requestId": request,
        "timestamp": stamp(moment),
        "message": {
            "id": message_id,
            "model": "claude-opus-5-5",
            "usage": {"input_tokens": tokens, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 999999, "output_tokens": 0},
        },
    }


def codex_line(total, last, moment=NOW, limits=None):
    payload = {
        "type": "token_count",
        "info": {
            "total_token_usage": {"total_tokens": total},
            "last_token_usage": {"input_tokens": last + 100, "cached_input_tokens": 100, "output_tokens": 0},
        },
    }
    if limits is not None:
        payload["rate_limits"] = limits
    return {"timestamp": stamp(moment), "type": "event_msg", "payload": payload}


def write_jsonl(path, entries, tail=""):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries) + tail, encoding="utf-8")


@pytest.fixture
def home(tmp_path):
    (tmp_path / "home" / ".claude" / "projects").mkdir(parents=True)
    (tmp_path / "home" / ".codex" / "sessions").mkdir(parents=True)
    (tmp_path / "state").mkdir()
    return tmp_path


def service(home, clock=time.time, linked=False):
    return UsageService(home / "state", home=home / "home", clock=clock, linked=lambda: linked)


def by_id(snapshot):
    return {agent["id"]: agent for agent in snapshot["agents"]}


def test_claude_tokens_of_today_counted_once_and_incrementally(home):
    log = home / "home" / ".claude" / "projects" / "p" / "s.jsonl"
    yesterday = NOW - timedelta(days=1, hours=1)
    write_jsonl(
        log,
        [
            claude_line("old", 500, yesterday),
            claude_line("m1", 100),
            claude_line("m1", 100),  # same message, another block: not counted twice
            {"type": "user", "timestamp": stamp(NOW), "message": {"content": "usage"}},
        ],
        tail=json.dumps(claude_line("m2", 7))[:40],  # half-written line: wait for it to finish
    )
    reader = service(home)
    claude = by_id(reader.snapshot(force=True))["claude_code"]
    assert claude["today"] == {"tokens": 100, "messages": 1}
    assert claude["limits"] == [] and "status line" in claude["note"]

    # Claude finishes writing the line and adds another: only those are read.
    with log.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(claude_line("m2", 7))[40:] + "\n" + json.dumps(claude_line("m3", 3)) + "\n")
    claude = by_id(reader.snapshot(force=True))["claude_code"]
    assert claude["today"] == {"tokens": 110, "messages": 3}


def test_claude_limits_from_the_status_line_file(home):
    now = time.time()
    (home / "state" / usage.CLAUDE_LIMITS_FILE).write_text(
        json.dumps(
            {
                "at": now - 30,
                "rate_limits": {
                    "seven_day": {"used_percentage": 18, "resets_at": now + 3 * 86400},
                    "five_hour": {"used_percentage": 42.4, "resets_at": now + 3600},
                },
            }
        ),
        encoding="utf-8",
    )
    claude = by_id(service(home, linked=True).snapshot(force=True))["claude_code"]
    assert [(item["id"], item["used"], item["windowMinutes"]) for item in claude["limits"]] == [("five_hour", 42.4, 300), ("seven_day", 18.0, 10080)]
    assert claude["linked"] is True and claude["note"] is None


def test_a_window_past_its_reset_counts_as_empty(home):
    now = time.time()
    (home / "state" / usage.CLAUDE_LIMITS_FILE).write_text(
        json.dumps({"at": now - 20000, "rate_limits": {"five_hour": {"used_percentage": 97, "resets_at": now - 60}}}), encoding="utf-8"
    )
    [limit] = by_id(service(home).snapshot(force=True))["claude_code"]["limits"]
    assert limit["used"] == 0 and limit["resetsAt"] is None


def test_codex_limits_come_from_the_newest_session_and_tokens_from_today(home):
    sessions = home / "home" / ".codex" / "sessions"
    reset = time.time() + 2 * 86400
    old = sessions / "2026" / "09" / "01" / "rollout-old.jsonl"
    write_jsonl(old, [codex_line(10, 10, NOW - timedelta(days=3), {"primary": {"used_percent": 90, "window_minutes": 300, "resets_at": reset}})])
    os.utime(old, (time.time() - 3 * 86400, time.time() - 3 * 86400))
    new = sessions / "2026" / "09" / "30" / "rollout-new.jsonl"
    limits = {
        "primary": {"used_percent": 11.0, "window_minutes": 43200, "resets_at": reset},
        "secondary": None,
        "plan_type": "free",
    }
    write_jsonl(new, [codex_line(200, 200), codex_line(200, 200), codex_line(250, 50, limits=limits)])
    codex = by_id(service(home).snapshot(force=True))["codex"]
    assert codex["plan"] == "free"
    assert [(item["id"], item["used"], item["windowMinutes"]) for item in codex["limits"]] == [("primary", 11.0, 43200)]
    # Two identical events (same total) are one; the one from three days ago isn't today's.
    assert codex["today"] == {"tokens": 250, "messages": 2}


def test_old_codex_logs_say_how_many_seconds_to_the_reset(home):
    moment = NOW - timedelta(minutes=10)
    entry = codex_line(1, 1, moment, {"primary": {"used_percent": 50, "window_minutes": 300, "resets_in_seconds": 3600}})
    [limit], plan = usage.codex_rate_limits(entry, time.time())
    assert plan is None and abs(limit["resetsAt"] - (moment.timestamp() + 3600)) < 2


def test_agents_that_are_not_installed_are_left_out(tmp_path):
    (tmp_path / "state").mkdir()
    (tmp_path / "home").mkdir()
    assert service(tmp_path).snapshot(force=True)["agents"] == []


def test_antigravity_only_says_when_it_was_used(home):
    root = home / "home" / ".gemini" / "antigravity"
    root.mkdir(parents=True)
    (root / "cli.log").write_text("x", encoding="utf-8")
    agy = by_id(service(home).snapshot(force=True))["antigravity"]
    assert agy["limits"] == [] and agy["lastUsed"] and "app" in agy["note"]


def test_tightest_prefers_the_active_brain():
    snapshot = {
        "agents": [
            {"id": "codex", "label": "Codex", "limits": [{"id": "primary", "used": 70}]},
            {"id": "claude_code", "label": "Claude Code", "limits": [{"id": "five_hour", "used": 20}, {"id": "seven_day", "used": 35}]},
        ]
    }
    assert tightest(snapshot)["agent"] == "codex"
    best = tightest(snapshot, prefer="claude_code")
    assert best["agent"] == "claude_code" and best["limit"]["id"] == "seven_day"
    assert tightest({"agents": []}) is None


def test_words():
    now = datetime(2026, 9, 30, 12, 0).timestamp()
    assert when_words(datetime(2026, 9, 30, 18, 40).timestamp(), now, "it") == "alle 18:40"
    assert when_words(datetime(2026, 10, 1, 9, 5).timestamp(), now, "it") == "domani alle 9:05"
    assert when_words(datetime(2026, 10, 5, 9, 5).timestamp(), now, "it") == "tra 5 giorni"
    assert when_words(datetime(2026, 9, 30, 18, 40).timestamp(), now, "en") == "at 6:40 pm"
    assert window_words(300, "it") == "delle cinque ore" and window_words(10080, "en") == "weekly"
    assert window_words(120, "it") == "delle 2 ore"
    assert usage.tokens_words(265_507, "it") == "266 mila token"
    assert usage.tokens_words(1_200_000, "it") == "1,2 milioni di token"
    assert italian_percent(80) == ("l'80", "all'80") and italian_percent(95) == ("il 95", "al 95")


def test_which_questions_are_about_usage():
    assert wants_usage("Quanto mi resta di Claude?") == ["claude_code"]
    assert wants_usage("a che punto sono codex e antigravity") == ["codex", "antigravity"]
    assert wants_usage("limiti degli agenti") == []
    assert wants_usage("how much Codex usage is left?") == ["codex"]
    assert wants_usage("scrivimi una poesia su Claude") is None
    assert wants_usage("quanto costa una pizza?") is None


def test_describe_speaks_limits_resets_and_tokens():
    now = datetime(2026, 9, 30, 12, 0).timestamp()
    snapshot = {
        "agents": [
            {
                "id": "codex",
                "label": "Codex",
                "limits": [{"id": "primary", "used": 11.0, "resetsAt": datetime(2026, 9, 30, 18, 40).timestamp(), "windowMinutes": 300}],
                "today": {"tokens": 1500, "messages": 3},
            },
            {"id": "claude_code", "label": "Claude Code", "limits": [], "linked": False, "today": {"tokens": 0}},
            {"id": "antigravity", "label": "Antigravity", "limits": []},
        ]
    }
    text = describe(snapshot, "it", now=now)
    assert "Codex: 11 per cento del limite delle cinque ore, che si azzera alle 18:40." in text
    assert "Oggi Codex ha lavorato 2 mila token." in text
    assert "barra di stato" in text and "Antigravity non scrive" in text
    assert describe(snapshot, "it", only=["codex"], now=now).startswith("Codex:")
    assert "Non trovo" in describe({"agents": []}, "it", only=["codex"])


# ---------------------------------------------------------------------------
# Claude Code's status line
# ---------------------------------------------------------------------------
def test_statusline_install_wraps_the_previous_one_and_uninstall_restores_it(tmp_path):
    path = tmp_path / "settings.json"
    previous = {"type": "command", "command": "bash ~/.claude/line.sh", "padding": 1}
    path.write_text(json.dumps({"model": "opus", "statusLine": previous}), encoding="utf-8")
    assert notify.install_statusline(path) == "connected"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["model"] == "opus" and data["statusLine"]["padding"] == 1
    assert notify.STATUSLINE_MARK in data["statusLine"]["command"] and "--then" in data["statusLine"]["command"]
    assert notify.statusline_installed(path)
    assert notify.install_statusline(path) == "already connected"
    assert notify.uninstall_statusline(path) == "disconnected"
    assert json.loads(path.read_text(encoding="utf-8")) == {"model": "opus", "statusLine": previous}

    fresh = tmp_path / "fresh.json"
    notify.install_statusline(fresh)
    assert "--then" not in json.loads(fresh.read_text(encoding="utf-8"))["statusLine"]["command"]
    notify.uninstall_statusline(fresh)
    assert json.loads(fresh.read_text(encoding="utf-8")) == {}


def run_statusline(state_dir, payload, *extra):
    env = {**os.environ, "DC_STATE_DIR": str(state_dir)}
    return subprocess.run(
        [sys.executable, str(notify.STATUSLINE_SCRIPT), *extra],
        input=json.dumps(payload).encode("utf-8"),
        env=env,
        capture_output=True,
        timeout=15,
    )


def test_statusline_script_saves_the_limits_and_prints_a_line(tmp_path):
    payload = {
        "model": {"display_name": "Opus 5.5"},
        "context_window": {"used_percentage": 12.4},
        "rate_limits": {"five_hour": {"used_percentage": 42, "resets_at": 1893456000}, "seven_day": {"used_percentage": 18, "resets_at": 1893456000}},
    }
    done = run_statusline(tmp_path, payload)
    assert done.returncode == 0
    assert done.stdout.decode("utf-8") == "Opus 5.5 · ctx 12% · 5h 42% · 7d 18%"
    saved = json.loads((tmp_path / usage.CLAUDE_LIMITS_FILE).read_text(encoding="utf-8"))
    assert saved["rate_limits"] == payload["rate_limits"] and saved["model"] == "Opus 5.5"


def test_statusline_script_runs_the_previous_line(tmp_path):
    previous = {"type": "command", "command": f'"{sys.executable}" -c "print(42)"'}
    encoded = base64.urlsafe_b64encode(json.dumps(previous).encode()).decode()
    done = run_statusline(tmp_path, {"model": {"display_name": "Opus"}}, "--then", encoded)
    assert done.returncode == 0 and done.stdout.decode("utf-8").strip() == "42"
    # No limits (plan without a subscription): no file.
    assert not (tmp_path / usage.CLAUDE_LIMITS_FILE).exists()


def test_statusline_script_never_breaks_on_garbage(tmp_path):
    env = {**os.environ, "DC_STATE_DIR": str(tmp_path)}
    done = subprocess.run([sys.executable, str(notify.STATUSLINE_SCRIPT)], input=b"not json", env=env, capture_output=True, timeout=15)
    assert done.returncode == 0 and done.stdout == b""


# ---------------------------------------------------------------------------
# Server: endpoints, spoken question, notifications
# ---------------------------------------------------------------------------
def test_usage_endpoint_and_spoken_answer(client, monkeypatch, home):
    sessions = home / "home" / ".codex" / "sessions"
    limits = {"primary": {"used_percent": 30, "window_minutes": 10080, "resets_at": time.time() + 86400 * 3}}
    write_jsonl(sessions / "rollout-a.jsonl", [codex_line(5, 5, limits=limits)])
    monkeypatch.setattr(server, "USAGE", service(home))
    data = client.get("/api/usage").json()
    assert by_id(data)["codex"]["limits"][0]["used"] == 30

    instance = server.app.state.companion
    monkeypatch.setattr(instance, "history", [])
    monkeypatch.setattr(Companion, "voice_language", property(lambda self: "it"))
    reply = client.post("/api/chat", json={"text": "Quanto mi resta di Codex?"}).json()
    assert reply["reply"].startswith("Codex: 30 per cento del limite settimanale")


def test_setup_status_reports_what_is_ready(client):
    data = client.get("/api/setup?wait=1").json()
    assert data["detecting"] is False
    assert data["listening"]["selected"] == "none" and data["listening"]["on"] is False
    assert "claude_usage" in data["integrations"]


@pytest.fixture
def alerts(client, monkeypatch):
    instance = server.app.state.companion
    sent = []

    async def record(message):
        sent.append(message)

    monkeypatch.setattr(server.hub, "broadcast", record)
    monkeypatch.setattr(instance, "history", [])
    monkeypatch.setattr(Companion, "voice_language", property(lambda self: "it"))
    context = PCContext()
    context.update(3, False, {"title": "x - VS Code", "exe": "Code.exe", "fullscreen": False, "own": False})
    reading = {"value": None}
    engine = Proactive(
        companion=lambda: instance,
        context=context,
        preferences=Preferences(None),
        broadcast=record,
        battery_reader=lambda: None,
        usage=lambda: reading["value"],
        rng=random.Random(1),
    )
    engine.next_break_minutes = 10**9
    engine.reading = reading
    engine.sent = sent
    return engine


def snapshot_with(used, resets_at):
    return {"agents": [{"id": "claude_code", "label": "Claude Code", "limits": [{"id": "five_hour", "used": used, "resetsAt": resets_at, "windowMinutes": 300}]}]}


def test_usage_alerts_once_per_level_then_when_it_resets(client, alerts):
    base = datetime.now().replace(hour=15, minute=0, second=0, microsecond=0)
    resets = (base + timedelta(hours=2)).timestamp()
    tick = lambda minutes: client.portal.call(alerts.tick, base + timedelta(minutes=minutes))  # noqa: E731
    spoken = lambda: [m["text"] for m in alerts.sent if m["type"] == "reply"]  # noqa: E731
    # The break counts from the real clock: at 15:00 + 1 h it would speak up before noon.
    alerts.preferences.update({"topics": {"breaks": False}}, save=False)

    alerts.reading["value"] = snapshot_with(50, resets)
    assert tick(0) is None
    alerts.reading["value"] = snapshot_with(83, resets)
    assert tick(1) == "usage:claude_code:five_hour:83"
    assert "Claude Code" in spoken()[-1] and "83" in spoken()[-1] and "cinque ore" in spoken()[-1]
    assert tick(10) is None  # same threshold, same window: once only
    alerts.reading["value"] = snapshot_with(96, resets)
    assert tick(20) == "usage:claude_code:five_hour:96"
    assert "quasi al limite" in spoken()[-1]
    alerts.reading["value"] = snapshot_with(4, None)
    assert tick(40) == "usage_reset:claude_code:five_hour"
    assert "si è azzerato" in spoken()[-1]
    assert tick(60) is None


def test_usage_alerts_wait_for_you_and_respect_the_switch(client, alerts):
    alerts.reading["value"] = snapshot_with(90, time.time() + 3600)
    alerts.context.update(2, False, {"title": "Riunione | Microsoft Teams", "exe": "ms-teams.exe", "fullscreen": False, "own": False})
    assert client.portal.call(alerts.tick, datetime.now().replace(hour=15)) is None
    alerts.context.update(2, False, {"title": "x - VS Code", "exe": "Code.exe", "fullscreen": False, "own": False})
    alerts.preferences.update({"topics": {"usage": False}}, save=False)
    assert client.portal.call(alerts.tick, datetime.now().replace(hour=15)) is None
    alerts.preferences.update({"topics": {"usage": True}, "chatter": "off"}, save=False)
    # With the chatter off the notification arrives anyway: it's work, like the battery.
    assert client.portal.call(alerts.tick, datetime.now().replace(hour=15)).startswith("usage:")
