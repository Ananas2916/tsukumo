"""Attached files and screenshots: paths for agents, content for models."""

import base64
from pathlib import Path

import pytest

from backend import server
from backend.attachments import (
    anthropic_content,
    default_prompt,
    gemini_parts,
    ollama_images,
    openai_content,
    prepare,
    store_upload,
    with_contents,
    with_paths,
)
from backend.llm.cli_agents import ClaudeCodeClient, CodexClient
from backend.pipeline import wants_screen
from helpers import Scripted

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class Agent(Scripted):
    stateful = True


@pytest.fixture
def files(tmp_path):
    note = tmp_path / "appunti.md"
    note.write_text("# Lista\n- comprare il latte\n", encoding="utf-8")
    image = tmp_path / "foto.png"
    image.write_bytes(PNG)
    blob = tmp_path / "archivio.zip"
    blob.write_bytes(b"PK\x03\x04")
    return note, image, blob


def test_prepare_keeps_only_real_files(files, tmp_path):
    note, image, blob = files
    found = prepare([str(note), str(image), str(blob), str(tmp_path / "missing.txt"), "", 42])
    assert [(item.name, item.kind) for item in found] == [("appunti.md", "text"), ("foto.png", "image"), ("archivio.zip", "other")]
    assert found[1].mime == "image/png"


def test_prompts_for_agents_and_models(files):
    attachments = prepare([str(path) for path in files])
    for_agent = with_paths("Cosa c'è qui?", attachments)
    assert str(files[0]) in for_agent and str(files[1]) in for_agent
    for_model = with_contents("Cosa c'è qui?", attachments)
    assert "comprare il latte" in for_model and "archivio.zip" in for_model and "foto.png" not in for_model
    assert default_prompt(attachments[:1], "it").startswith("Dai un'occhiata")
    assert "screen" in default_prompt([], "en", screen=True)


def test_image_formats_for_every_service(files):
    image = (str(files[1]),)
    parts = openai_content("guarda", image)
    assert parts[0] == {"type": "text", "text": "guarda"} and parts[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert openai_content("solo testo", ()) == "solo testo"
    blocks = anthropic_content("guarda", image)
    assert blocks[0]["source"]["media_type"] == "image/png" and blocks[-1] == {"type": "text", "text": "guarda"}
    assert gemini_parts("guarda", image)[0]["inline_data"]["mime_type"] == "image/png"
    assert ollama_images(image) == [base64.b64encode(PNG).decode()]


def test_agents_get_permission_to_read_the_files(tmp_path):
    claude = ClaudeCodeClient(command="claude", cwd=str(tmp_path))
    claude.executable = "claude"
    argv = claude.build_argv("Reply in Italian.", (str(tmp_path),))
    assert argv[argv.index("--add-dir") + 1] == str(tmp_path)
    codex = CodexClient(command="codex", cwd=str(tmp_path))
    codex.executable = "codex"
    argv = codex.build_argv(("a.png", "b.png"))
    # -i takes several values: right after the images another option must follow.
    assert argv[argv.index("-i") : argv.index("-i") + 4] == ["-i", "a.png", "-i", "b.png"]
    assert argv[argv.index("b.png") + 1].startswith("-") and argv[-1] == "-"


def test_an_agent_receives_paths_and_folders(client, files, monkeypatch):
    instance = server.app.state.companion
    brain = Agent(["Vedo una lista della spesa."])
    monkeypatch.setattr(instance, "llm", brain)
    monkeypatch.setattr(instance, "history", [])
    sent = []

    async def record(message):
        sent.append(message)

    client.portal.call(lambda: instance.chat("", record, files=[str(files[0]), str(files[1])]))
    last = brain.messages[-1]
    assert str(files[0]) in last.content and last.folders == (str(files[0].parent.resolve()),)
    assert last.images == (str(files[1].resolve()),)
    [user] = [m for m in sent if m["type"] == "user"]
    assert user["text"].startswith("Dai un'occhiata") or user["text"].startswith("Take a look")
    assert [item["name"] for item in user["files"]] == ["appunti.md", "foto.png"]
    assert "[allegati: appunti.md, foto.png]" in instance.history[-2].content


def test_a_model_receives_contents_and_images(client, files, monkeypatch):
    instance = server.app.state.companion
    brain = Scripted(["Ok."])
    monkeypatch.setattr(instance, "llm", brain)
    monkeypatch.setattr(instance, "history", [])

    async def ignore(message):
        pass

    client.portal.call(lambda: instance.chat("riassumi", ignore, files=[str(files[0]), str(files[1])]))
    last = brain.messages[-1]
    assert "comprare il latte" in last.content and last.images == (str(files[1].resolve()),)


def test_look_at_the_screen_asks_the_shell_for_a_screenshot(client, monkeypatch):
    brain = Scripted(["non dovrei essere chiamato"])
    monkeypatch.setattr(server.app.state.companion, "llm", brain)
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_json({"type": "capabilities", "screen": True})
        ws.send_json({"type": "chat", "text": "guarda il mio schermo, cosa vedi?"})
        while True:
            message = ws.receive_json()
            if message["type"] == "capture":
                break
        assert message["text"] == "guarda il mio schermo, cosa vedi?"
    assert brain.messages is None
    assert not server.SCREEN_CLIENTS
    assert wants_screen("look at my screen") and not wants_screen("guarda questo film")


def test_upload_for_the_browser(client):
    reply = client.post("/api/attachments?name=../../evil name.txt", content=b"ciao").json()
    path = Path(reply["path"])
    assert path.read_bytes() == b"ciao" and path.name == "evil name.txt"
    assert "uploads" in path.parts


def test_store_upload_refuses_huge_files(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.attachments.MAX_UPLOAD_BYTES", 3)
    with pytest.raises(ValueError):
        store_upload(tmp_path, "a.bin", b"1234")
