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
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class Project(BaseModel):
    id: str
    title: str
    created_at: float
    mode: str = "prompt"  # prompt | beginner | advanced | flowchart


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _dir(self, project_id: str) -> Path:
        return self.root / f"{project_id}.lcut"

    def generated_dir(self, project_id: str) -> Path:
        return self._dir(project_id) / "generated"

    def create(self, title: str, graph: StoryGraph, mode: str = "prompt") -> Project:
        project = Project(
            id=uuid.uuid4().hex[:_PROJECT_ID_LEN],
            title=title[:120],
            created_at=time.time(),
            mode=mode,
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
        return Project.model_validate_json(meta.read_text())

    def list(self) -> list[Project]:
        projects = []
        for meta in self.root.glob("*.lcut/meta.json"):
            try:
                projects.append(Project.model_validate_json(meta.read_text()))
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

    def save_graph(self, project_id: str, graph: StoryGraph) -> None:
        _write_atomic(
            self._dir(project_id) / "project.json", graph.model_dump_json(indent=2)
        )

    def load_graph(self, project_id: str) -> StoryGraph:
        graph = StoryGraph.model_validate_json(
            (self._dir(project_id) / "project.json").read_text()
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
        return {p.name.split(".")[0] for p in generated.iterdir()}

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
