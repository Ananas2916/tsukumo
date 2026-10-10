"""Helpers shared by the tests."""

from backend.llm.base import LLMClient


class Scripted(LLMClient):
    """A fake brain that always answers with the same pieces (and remembers what it got)."""

    name = "scripted"

    def __init__(self, pieces):
        self.pieces = pieces
        self.messages = None

    async def stream(self, messages):
        self.messages = messages
        for piece in self.pieces:
            yield piece

    async def health(self):
        return {"ok": True}
