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
import shutil
import time
import uuid
from pathlib import Path

from pydantic import BaseModel

from .. import __version__
from ..graph.model import StoryGraph


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
        project = Project(id=uuid.uuid4().hex[:10], title=title[:120], created_at=time.time())
        project_dir = self._dir(project.id)
        for sub in ("assets", "generated", "cache"):
            (project_dir / sub).mkdir(parents=True, exist_ok=True)
        (project_dir / "meta.json").write_text(project.model_dump_json(indent=2))
        (project_dir / "manifest.json").write_text(
            json.dumps({"app_version": __version__, "models": {}}, indent=2)
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
            projects.append(Project.model_validate_json(meta.read_text()))
        return sorted(projects, key=lambda p: p.created_at, reverse=True)

    def delete(self, project_id: str) -> bool:
        project_dir = self._dir(project_id)
        if not project_dir.exists():
            return False
        shutil.rmtree(project_dir)
        return True

    def save_graph(self, project_id: str, graph: StoryGraph) -> None:
        (self._dir(project_id) / "project.json").write_text(
            graph.model_dump_json(indent=2)
        )

    def load_graph(self, project_id: str) -> StoryGraph:
        return StoryGraph.model_validate_json(
            (self._dir(project_id) / "project.json").read_text()
        )

    # -- artifact index: generated/ files are named {output_hash}{suffix} --

    def resolve_artifact(self, project_id: str, output_hash: str) -> Path | None:
        # Literal prefix match, deliberately not glob: hashes come from the
        # API surface and must never act as wildcards.
        generated = self.generated_dir(project_id)
        if not output_hash or not generated.is_dir():
            return None
        for p in generated.iterdir():
            if p.name.startswith(f"{output_hash}.") and not p.name.endswith(".concat.txt"):
                return p
        return None

    def cached_hashes(self, project_id: str) -> set[str]:
        generated = self.generated_dir(project_id)
        if not generated.is_dir():
            return set()
        return {
            p.name.split(".")[0]
            for p in generated.iterdir()
            if not p.name.endswith(".concat.txt")
        }
