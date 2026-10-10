""".vrma clips: the folder is listed with the URL to load them from."""

from backend import server


def test_animations_are_listed(client, monkeypatch, tmp_path):
    (tmp_path / "idle_stretch.vrma").write_bytes(b"{}")
    (tmp_path / "note.txt").write_text("x")
    monkeypatch.setattr(server.SETTINGS, "animations_dir", tmp_path)
    data = client.get("/api/animations").json()
    assert data["animations"] == [{"name": "idle_stretch.vrma", "url": "/animations/idle_stretch.vrma"}]
