"""In-process event bus: job/scene progress flows scheduler → API WS → UI."""

from __future__ import annotations

import asyncio
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_to_running_loop(self) -> None:
        """asyncio queues are not thread-safe: publishers running in worker
        threads must hop onto this loop to dispatch."""
        self._loop = asyncio.get_running_loop()

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(q)

    def publish(self, event_type: str, **data: Any) -> None:
        event = {"type": event_type, **data}
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if self._loop is not None and running is not self._loop:
            self._loop.call_soon_threadsafe(self._dispatch, event)
        else:
            self._dispatch(event)

    def _dispatch(self, event: dict[str, Any]) -> None:
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
