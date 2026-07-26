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
from ..graph.model import EDL_VERSION, GRAPH_VERSION, StoryGraph

logger = logging.getLogger(__name__)


class ProjectTooNew(RuntimeError):
    """A project.json written by a newer engine than this one. Opening it
    would silently drop the fields this build doesn't know and then persist
    the loss, so the read is refused instead (maps to HTTP 409)."""


_PROJECT_ID_LEN = 10

# The API's path-param validation is built from this — the id generator and
# the route pattern must agree or every route 404s new projects.
PROJECT_ID_PATTERN = rf"^[a-f0-9]{{{_PROJECT_ID_LEN}}}$"


def _write_atomic(path: Path, text: str, attempts: int = 6) -> None:
    """Truncating writes brick the project on a crash mid-write; write to a
    sibling temp file and rename over.

    The rename retries on PermissionError — the write-side twin of
    `_read_text_retry`. Windows refuses `MoveFileEx(REPLACE_EXISTING)` while
    ANY handle to the destination is open, and meta/graph reads run
    concurrently with these rewrites (the API reads them on worker threads,
    and job completions rewrite them constantly). A reader holding meta.json
    open for a few microseconds is enough to fail the write, which surfaces
    as a project update lost for no reason the user could ever explain.
    `os.replace` is atomic, so a failed attempt did not happen at all and
    retrying is safe.
    """
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        # encoding="utf-8": model_dump_json emits raw non-ASCII, and the
        # platform default on Windows is cp1252 — a CJK/Cyrillic/emoji title
        # would otherwise raise UnicodeEncodeError and abort create/rename.
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            # Without the fsync the rename can be journalled while the data
            # blocks are not: a power loss then leaves project.json present
            # but EMPTY. The project still lists (that reads meta.json) and
            # is permanently unopenable — there is no server copy to restore.
            os.fsync(handle.fileno())
        for attempt in range(attempts):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == attempts - 1:
                    raise
                time.sleep(0.01 * (attempt + 1))
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

    def project_dir(self, project_id: str) -> Path:
        return self._dir(project_id)

    def delete(self, project_id: str) -> bool:
        """Remove a project outright. Only safe when nothing can still be
        writing into it — ProjectService.delete uses the reserve/purge pair
        instead, which tolerates a render that has not stopped yet."""
        project_dir = self._dir(project_id)
        if not project_dir.exists():
            return False
        shutil.rmtree(project_dir)
        return True

    def reserve_for_deletion(self, project_id: str) -> Path:
        """Rename a project dir to a `.deleting-*` name and return the new
        path. The rename is atomic and takes the project out of `list()`'s
        glob immediately, so the project is gone from the user's point of
        view the instant this returns — even if a backend is still writing
        into the directory under its old path."""
        source = self._dir(project_id)
        doomed = self.root / f".deleting-{project_id}-{uuid.uuid4().hex[:8]}"
        try:
            source.rename(doomed)
        except OSError:
            # Windows refuses to rename a directory with an open handle in
            # it. Fall back to deleting in place; purge's retry loop is what
            # makes that survivable.
            return source
        return doomed

    def purge(self, doomed: Path, attempts: int = 5) -> bool:
        """Remove a reserved directory, retrying while a backend still holds
        a file open (Windows) or re-creates one (any platform: a render's
        next output_path() call does mkdir(parents=True)). Leftovers are
        reclaimed by sweep_pending_deletions on the next start, so a failure
        here leaks nothing permanently."""
        for attempt in range(attempts):
            shutil.rmtree(doomed, ignore_errors=True)
            if not doomed.exists():
                return True
            time.sleep(0.1 * (attempt + 1))
        logger.warning("could not fully remove %s; will retry on next start", doomed)
        return False

    def purge_recreated(self, project_id: str) -> bool:
        """Remove a project dir a still-running render re-created after the
        real one was reserved away (`output_path()` does mkdir(parents=True)).

        Identified by the absence of meta.json: without it the directory never
        appears in `list()`, so nothing else would ever reclaim it, and the
        artifacts inside it are disk the user can neither see nor free — the
        exact orphan the reserve/purge pair exists to avoid."""
        leftover = self._dir(project_id)
        if not leftover.is_dir() or (leftover / "meta.json").exists():
            return False
        return self.purge(leftover, attempts=3)

    def sweep_pending_deletions(self) -> int:
        """Reclaim directories left behind by an interrupted delete:
        `.deleting-*` reservations, and `*.lcut` skeletons a render re-created
        under the original name. Nothing can be writing into either now — the
        process that was is gone, and a project dir with no meta.json is not a
        project this build could ever open."""
        reclaimed = 0
        for path in self.root.glob("*.lcut"):
            if path.is_dir() and not (path / "meta.json").exists() and self.purge(path, attempts=2):
                logger.info("reclaimed orphaned project directory %s", path)
                reclaimed += 1
        for path in self.root.glob(".deleting-*"):
            if path.is_dir() and self.purge(path, attempts=2):
                reclaimed += 1
        return reclaimed

    def duplicate(self, project_id: str) -> Project | None:
        """Copy a project under a fresh id. generated/ travels — artifacts
        are content-addressed with no project id in the hash payload, so
        copies stay valid; cache/ is regenerable and stays behind."""
        source = self.get(project_id)
        if source is None:
            return None
        new_id = uuid.uuid4().hex[:_PROJECT_ID_LEN]
        dst = self._dir(new_id)
        # Skip in-flight temps as well as cache/. Backends build artifacts
        # under a leading-dot name and rename into place, so a copy that
        # races a live render would try to read a `.partial-*` file the
        # rename has already moved — copytree then fails the whole
        # duplication with "cannot find the file specified". They are not
        # artifacts either way (cached_hashes ignores them for the same
        # reason), so there is nothing to preserve.
        shutil.copytree(
            self._dir(project_id),
            dst,
            ignore=shutil.ignore_patterns("cache", ".partial-*", "*.part"),
        )
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
        # Always stamp the CURRENT version: a graph this build wrote is a
        # graph in this build's format, whatever version it was loaded from.
        graph.version = GRAPH_VERSION
        _write_atomic(self._dir(project_id) / "project.json", graph.model_dump_json(indent=2))

    def load_graph(self, project_id: str) -> StoryGraph:
        raw = json.loads(_read_text_retry(self._dir(project_id) / "project.json"))
        # Refuse a project from the future BEFORE validating it into a model.
        #
        # Every model here uses pydantic's default extra="ignore", so parsing
        # a newer project silently drops the fields this build doesn't know —
        # and the next save writes the reduced object back over the user's
        # work, with no error and nothing to detect it against. That is the
        # one failure this check exists to prevent, so it must come first.
        version = raw.get("version", 1) if isinstance(raw, dict) else 1
        if not isinstance(version, int) or version > GRAPH_VERSION:
            raise ProjectTooNew(
                f"this project was created by a newer version of LocalCut AI "
                f"(project format v{version}, this engine reads up to v{GRAPH_VERSION}) — "
                "update the engine to open it. It has not been modified."
            )
        graph = StoryGraph.model_validate(raw)
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

    def resolve_job_artifact(self, project_id: str, artifact: str | None) -> Path | None:
        """A `Job.artifact` record as a usable path, or None when the file is
        gone. Records are relative to the project's generated/ dir; absolute
        ones (written by builds before that was enforced) are honoured when
        they still resolve, and otherwise fall back to matching the basename
        under this project — which is what makes an old record survive a
        moved data dir or a restore onto another machine."""
        if not artifact:
            return None
        path = Path(artifact)
        if not path.is_absolute():
            candidate = self.generated_dir(project_id) / path
            return candidate if candidate.exists() else None
        if path.exists():
            return path
        legacy = self.generated_dir(project_id) / path.name
        return legacy if legacy.exists() else None

    def cached_hashes(self, project_id: str) -> set[str]:
        generated = self.generated_dir(project_id)
        if not generated.is_dir():
            return set()
        # Skip in-progress temp files/dirs (backends build artifacts under a
        # leading-dot name and atomically rename into place): they are not
        # artifacts, and their leading dot would otherwise split to an
        # empty-string "hash" and pollute the cache set.
        return {p.name.split(".")[0] for p in generated.iterdir() if not p.name.startswith(".")}

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
