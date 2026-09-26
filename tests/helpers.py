"""Aiuti condivisi dai test."""

from backend.llm.base import LLMClient


class Scripted(LLMClient):
    """Un cervello finto che risponde sempre con gli stessi pezzi (e ricorda cosa ha ricevuto)."""

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
