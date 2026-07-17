"""Download manager service — the API face of weight downloads.

The CLI calls `downloads.download_model` directly; the app needs the same
work as background tasks with progress events on the bus (the first-run
screen shows per-model progress bars over /ws). One task per model id;
cancel keeps the `.part` file so a later start resumes instead of restarting.
"""

from __future__ import annotations

import asyncio
import time

from ..config import EngineConfig
from ..events import EventBus
from .downloads import download_model, is_downloaded
from .loader import load_manifest
from .model import ModelEntry

_PROGRESS_INTERVAL_S = 0.5  # event-bus throttle; chunks arrive far faster


class DownloadManager:
    def __init__(self, config: EngineConfig, events: EventBus) -> None:
        self.config = config
        self.events = events
        self._tasks: dict[str, asyncio.Task] = {}
        self._progress: dict[str, dict] = {}  # model id -> {done, total} bytes

    def _entry(self, model_id: str) -> ModelEntry | None:
        return next((m for m in load_manifest(self.config).models if m.id == model_id), None)

    def status(self) -> list[dict]:
        """Manifest entries with live install state — one list the model
        library and first-run screens can render directly."""
        models_dir = self.config.resolved_models_dir
        rows = []
        for entry in load_manifest(self.config).models:
            task = self._tasks.get(entry.id)
            downloading = task is not None and not task.done()
            row = entry.model_dump()
            row["size_bytes"] = sum(f.size for f in entry.files)
            row["downloaded"] = is_downloaded(entry, models_dir)
            row["downloading"] = downloading
            row["progress"] = self._progress.get(entry.id) if downloading else None
            rows.append(row)
        return rows

    def start(self, model_id: str) -> str:
        """Begin (or resume) a model download. Returns the resulting state:
        'started' | 'downloading' (already running) | 'downloaded'."""
        entry = self._entry(model_id)
        if entry is None:
            raise KeyError(model_id)
        if not entry.files:
            raise ValueError(f"model {model_id} has no downloadable files in the manifest")
        models_dir = self.config.resolved_models_dir
        if is_downloaded(entry, models_dir):
            return "downloaded"
        task = self._tasks.get(model_id)
        if task is not None and not task.done():
            return "downloading"
        self._tasks[model_id] = asyncio.get_running_loop().create_task(self._run(entry, models_dir))
        return "started"

    def cancel(self, model_id: str) -> bool:
        task = self._tasks.get(model_id)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    async def shutdown(self) -> None:
        for task in self._tasks.values():
            task.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    async def _run(self, entry: ModelEntry, models_dir) -> None:
        # Files already in place are skipped by the downloader without a
        # single progress callback — pre-seed them so the bar starts honest.
        done_by_file = {f.dest: f.size for f in entry.files if (models_dir / f.dest).exists()}
        state = {
            "done": sum(done_by_file.values()),
            "total": sum(f.size for f in entry.files),
        }
        self._progress[entry.id] = state
        known_sizes = {f.dest: f.size for f in entry.files}
        last_emit = 0.0

        async def progress(dest: str, done: int, total: int) -> None:
            nonlocal last_emit
            if not known_sizes.get(dest) and total:
                # Manifest had no size; adopt the server's content-length so
                # the overall total stays meaningful.
                known_sizes[dest] = total
                state["total"] += total
            done_by_file[dest] = done
            state["done"] = sum(done_by_file.values())
            now = time.monotonic()
            if now - last_emit >= _PROGRESS_INTERVAL_S:
                last_emit = now
                self.events.publish(
                    "model.download.progress",
                    model=entry.id,
                    file=dest,
                    done=state["done"],
                    total=state["total"],
                )

        try:
            await download_model(entry, models_dir, progress)
        except asyncio.CancelledError:
            self.events.publish("model.download.cancelled", model=entry.id)
            raise
        except Exception as exc:  # DownloadError, network, disk — all UI-facing
            self.events.publish("model.download.failed", model=entry.id, error=str(exc))
        else:
            self.events.publish("model.download.done", model=entry.id)
