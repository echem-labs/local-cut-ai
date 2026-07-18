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
        projects.append({"id": project.id, "title": project.title, "bytes": total - cache})
    projects.sort(key=lambda row: row["bytes"], reverse=True)
    usage = shutil.disk_usage(config.data_dir)
    return {
        "projects": projects,
        "models_bytes": _dir_size(config.resolved_models_dir),
        "cache_bytes": cache_bytes,
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
