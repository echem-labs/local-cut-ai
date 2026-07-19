"""Project store — a project is a directory, zippable as.lcut:

    MyVideo.lcut/
      project.json   # story graph
      manifest.json  # app + model versions for reproducibility
      assets/        # user-imported, content-addressed
      generated/     # outputs keyed by node-output hash
      cache/         # regenerable, excluded from zip

Projects live with the engine (matters for the remote topology); the
frontend only ever sees them through the API.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from pydantic import BaseModel, ValidationError

from .. import __version__
from ..graph.model import EDL_VERSION, StoryGraph

logger = logging.getLogger(__name__)

_PROJECT_ID_LEN = 10

# The API's path-param validation is built from this — the id generator and
# the route pattern must agree or every route 404s new projects.
PROJECT_ID_PATTERN = rf"^[a-f0-9]{{{_PROJECT_ID_LEN}}}$"


def _write_atomic(path: Path, text: str) -> None:
    """Truncating writes brick the project on a crash mid-write; write to a
    sibling temp file and rename over."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        # encoding="utf-8": model_dump_json emits raw non-ASCII, and the
        # platform default on Windows is cp1252 — a CJK/Cyrillic/emoji title
        # would otherwise raise UnicodeEncodeError and abort create/rename.
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _read_text_retry(path: Path, attempts: int = 6) -> str:
    """Windows can transiently deny an open() that races os.replace() on the
    same file (meta/graph rewrites are frequent now that job completions
    refresh the read model). Retry briefly — the replace itself is atomic,
    so a later read always sees a complete file."""
    for attempt in range(attempts):
        try:
            return path.read_text(encoding="utf-8")
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.01 * (attempt + 1))
    raise AssertionError("unreachable")


class Project(BaseModel):
    id: str
    title: str
    created_at: float
    # Denormalized read model for the Home grid (review 4): kept in
    # meta.json so listing stays one glob, never a per-project board build.
    # All optional — metas written by older builds validate unchanged.
    updated_at: float | None = None
    mode: str = "prompt"  # prompt | beginner | advanced | flowchart | tool:<name>
    approvals: list[str] = []  # beginner checkpoints passed: script, storyboard
    thumb_hash: str | None = None  # first rendered keyframe, for tiles
    aspect: str | None = None
    duration_s: float | None = None  # current cut length


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _dir(self, project_id: str) -> Path:
        return self.root / f"{project_id}.lcut"

    def generated_dir(self, project_id: str) -> Path:
        return self._dir(project_id) / "generated"

    def create(
        self,
        title: str,
        graph: StoryGraph,
        mode: str = "prompt",
        aspect: str | None = None,
        duration_s: float | None = None,
    ) -> Project:
        now = time.time()
        project = Project(
            id=uuid.uuid4().hex[:_PROJECT_ID_LEN],
            title=title[:120],
            created_at=now,
            updated_at=now,
            mode=mode,
            aspect=aspect,
            duration_s=duration_s,
        )
        project_dir = self._dir(project.id)
        for sub in ("assets", "generated", "cache"):
            (project_dir / sub).mkdir(parents=True, exist_ok=True)
        _write_atomic(project_dir / "meta.json", project.model_dump_json(indent=2))
        _write_atomic(
            project_dir / "manifest.json",
            json.dumps({"app_version": __version__, "models": {}}, indent=2),
        )
        self.save_graph(project.id, graph)
        return project

    def get(self, project_id: str) -> Project | None:
        meta = self._dir(project_id) / "meta.json"
        if not meta.exists():
            return None
        return Project.model_validate_json(_read_text_retry(meta))

    def save_meta(self, project: Project) -> None:
        _write_atomic(self._dir(project.id) / "meta.json", project.model_dump_json(indent=2))

    def list(self) -> list[Project]:
        projects = []
        for meta in self.root.glob("*.lcut/meta.json"):
            try:
                projects.append(Project.model_validate_json(_read_text_retry(meta)))
            except (ValidationError, OSError):
                # One damaged project must not take the listing down with it.
                logger.warning("skipping unreadable project meta: %s", meta)
        return sorted(projects, key=lambda p: p.created_at, reverse=True)

    def delete(self, project_id: str) -> bool:
        project_dir = self._dir(project_id)
        if not project_dir.exists():
            return False
        shutil.rmtree(project_dir)
        return True

    def duplicate(self, project_id: str) -> Project | None:
        """Copy a project under a fresh id. generated/ travels — artifacts
        are content-addressed with no project id in the hash payload, so
        copies stay valid; cache/ is regenerable and stays behind."""
        source = self.get(project_id)
        if source is None:
            return None
        new_id = uuid.uuid4().hex[:_PROJECT_ID_LEN]
        dst = self._dir(new_id)
        shutil.copytree(self._dir(project_id), dst, ignore=shutil.ignore_patterns("cache"))
        (dst / "cache").mkdir(exist_ok=True)
        now = time.time()
        copy = source.model_copy(
            update={
                "id": new_id,
                "title": f"{source.title} copy"[:120],
                "created_at": now,
                "updated_at": now,
            }
        )
        _write_atomic(dst / "meta.json", copy.model_dump_json(indent=2))
        return copy

    def save_graph(self, project_id: str, graph: StoryGraph) -> None:
        _write_atomic(self._dir(project_id) / "project.json", graph.model_dump_json(indent=2))

    def load_graph(self, project_id: str) -> StoryGraph:
        graph = StoryGraph.model_validate_json(
            _read_text_retry(self._dir(project_id) / "project.json")
        )
        # EDL schema migration: stamping the current version changes the
        # timeline's hash, which is exactly what invalidates cached EDLs
        # written by older builds (absent or stale edl_version).
        timeline = graph.nodes.get("timeline")
        if timeline is not None and timeline.params.get("edl_version") != EDL_VERSION:
            timeline.params["edl_version"] = EDL_VERSION
        return graph

    # -- artifact index: generated/ files are named {output_hash}{suffix} --

    def resolve_artifact(self, project_id: str, output_hash: str) -> Path | None:
        # Literal prefix match, deliberately not glob: hashes come from the
        # API surface and must never act as wildcards.
        generated = self.generated_dir(project_id)
        if not output_hash or not generated.is_dir():
            return None
        for p in generated.iterdir():
            if p.name.startswith(f"{output_hash}."):
                return p
        return None

    def cached_hashes(self, project_id: str) -> set[str]:
        generated = self.generated_dir(project_id)
        if not generated.is_dir():
            return set()
        # Skip in-progress temp files/dirs (backends build artifacts under a
        # leading-dot name and atomically rename into place): they are not
        # artifacts, and their leading dot would otherwise split to an
        # empty-string "hash" and pollute the cache set.
        return {
            p.name.split(".")[0] for p in generated.iterdir() if not p.name.startswith(".")
        }

    def delete_artifacts(self, project_id: str, output_hash: str) -> int:
        """Drop every artifact stored under a hash (stale outputs that must
        re-render). Returns the number of files removed."""
        generated = self.generated_dir(project_id)
        if not output_hash or not generated.is_dir():
            return 0
        removed = 0
        for p in generated.iterdir():
            if p.name.startswith(f"{output_hash}."):
                p.unlink(missing_ok=True)
                removed += 1
        return removed
