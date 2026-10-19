"""Disk accounting for Settings → Storage (review 4).

Everything is derived by walking real directories — no bookkeeping to
drift. compute_storage is called through a short app-level cache because a
walk over many multi-GB projects is not free.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from .config import EngineConfig
from .programs import comfyui as comfyui_program
from .project.store import ProjectStore


def _dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    total = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue  # a vanished/locked file must not fail the sum
        except OSError:
            continue
    return total


def compute_storage(config: EngineConfig, store: ProjectStore) -> dict:
    projects = []
    cache_bytes = 0
    for project in store.list():
        project_dir = store.root / f"{project.id}.lcut"
        total = _dir_size(project_dir)
        cache = _dir_size(project_dir / "cache")
        cache_bytes += cache
        # clamp at 0: total and cache are two independent walks, so a cache
        # file created between them can make total-cache go negative (shown in
        # the UI and used as a sort key) while renders write concurrently.
        projects.append({"id": project.id, "title": project.title, "bytes": max(0, total - cache)})
    projects.sort(key=lambda row: row["bytes"], reverse=True)
    usage = shutil.disk_usage(config.data_dir)
    return {
        # Resolved, not as configured: every byte below is measured from this
        # directory, and a relative path answers "used where?" only for
        # whoever knows the engine's working directory. On a remote engine
        # that is a different machine entirely.
        "data_dir": str(Path(config.data_dir).resolve()),
        "projects": projects,
        "models_bytes": _dir_size(config.resolved_models_dir),
        "cache_bytes": cache_bytes,
        "comfyui_bytes": comfyui_work_bytes(config),
        "disk_free_bytes": usage.free,
        "disk_total_bytes": usage.total,
    }


def clear_caches(store: ProjectStore) -> int:
    """Empty every project's cache/ dir. Safe by construction: cache holds
    only regenerable intermediates (excluded from .lcut zips for the same
    reason). Returns bytes freed."""
    freed = 0
    for cache_dir in store.root.glob("*.lcut/cache"):
        freed += _dir_size(cache_dir)
        shutil.rmtree(cache_dir, ignore_errors=True)
        cache_dir.mkdir(exist_ok=True)
    return freed


def comfyui_work_bytes(config: EngineConfig) -> int | None:
    """The disk what renders left in LocalCut's ComfyUI's working folder
    takes: what `clear_comfyui_work` would free. None when there is no
    working folder, because LocalCut's copy has never run on this engine."""
    work = comfyui_program.work_dir(config)
    if not work.is_dir():
        return None
    return sum(_dir_size(root) for root in comfyui_program.working_roots(work))


def clear_comfyui_work(config: EngineConfig) -> int:
    """Delete what renders left in LocalCut's ComfyUI's working folder: its
    folders of the output and input and the scratch folder. The engine has
    fetched every result it needs into the project, so none of it is read
    again. Returns bytes freed."""
    work = comfyui_program.work_dir(config)
    return comfyui_program.clear_working_folder(work) if work.is_dir() else 0
