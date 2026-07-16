"""In-process event bus: job/scene progress flows scheduler → API WS → UI."""

from __future__ import annotations

import asyncio
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(q)

    def publish(self, event_type: str, **data: Any) -> None:
        event = {"type": event_type, **data}
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer: drop oldest to keep progress flowing.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except asyncio.QueueEmpty:
                    pass
