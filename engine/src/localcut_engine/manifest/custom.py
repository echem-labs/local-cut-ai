"""User-added model entries — review 4's "Add custom model".

Entries live in <data_dir>/custom-models.json and are merged into the
effective manifest by the loader; the curated catalog (bundled or CDN
override) is never rewritten. Sources: a direct download URL (goes through
the normal download manager) or a local weight file (copied into the
models dir, so the standard exists()/delete machinery applies unchanged).
License is always recorded as unverified — the UI's self-acknowledgment is
the doc-04 "install manually, their responsibility" notice.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse

from ..config import EngineConfig
from ..project.store import _write_atomic
from .loader import load_manifest
from .model import LicenseInfo, ModelEntry, ModelFile, ModelManifest, Requirements

# Where each task's weights land, following ComfyUI's dir layout for the
# tasks ComfyUI serves; the rest get their backend's expected folder.
TASK_DESTS: dict[str, str] = {
    "video.i2v": "checkpoints",
    "video.t2v": "checkpoints",
    "image.gen": "checkpoints",
    "music.gen": "checkpoints",
    "speech.tts": "tts",
    "transcribe": "whisper",
    "text.llm": "llm",
}

_ID_OK = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_SLUG_STRIP = re.compile(r"[^a-z0-9._-]+")


def _custom_path(config: EngineConfig) -> Path:
    return config.data_dir / "custom-models.json"


def _load_custom(config: EngineConfig) -> ModelManifest:
    path = _custom_path(config)
    if not path.exists():
        return ModelManifest()
    return ModelManifest.load(path)


def _save_custom(config: EngineConfig, manifest: ModelManifest) -> None:
    # Atomic + utf-8: this file is merged into EVERY manifest read, so a
    # torn/partial write would break loading the whole model catalog.
    _write_atomic(_custom_path(config), json.dumps(manifest.model_dump(), indent=2))


def _slug(name: str, taken: set[str]) -> str:
    base = _SLUG_STRIP.sub("-", name.strip().lower()).strip("-._") or "custom-model"
    if not _ID_OK.match(base):
        base = f"custom-{base}"[:64].strip("-._") or "custom-model"
    slug, n = base, 2
    while slug in taken:
        slug = f"{base}-{n}"
        n += 1
    return slug


def add_custom_model(
    config: EngineConfig,
    *,
    name: str,
    task: str,
    source: str,
    ref: str,
    vram_gb: float = 8.0,
    workflow_template: str = "",
) -> ModelEntry:
    """Register a user model. Raises ValueError on bad input and
    FileNotFoundError when a local-file source doesn't exist."""
    if task not in TASK_DESTS:
        raise ValueError(f"unknown task {task!r} — one of: {', '.join(sorted(TASK_DESTS))}")
    if workflow_template and Path(workflow_template).name != workflow_template:
        raise ValueError("workflow template must be a bare filename, not a path")
    dest_dir = TASK_DESTS[task]
    # Compute the unique id up front so the on-disk weight filename can be
    # namespaced by it — otherwise two custom models sharing a basename
    # (…/model.safetensors) collide on one path: the second copy is skipped,
    # its entry silently points at the first's weights, and deleting either
    # breaks the other.
    custom = _load_custom(config)
    taken = {m.id for m in load_manifest(config).models} | {m.id for m in custom.models}
    slug = _slug(name, taken)
    size = 0
    if source == "url":
        parsed = urlparse(ref)
        if parsed.scheme not in ("http", "https"):
            raise ValueError("source url must be http(s)")
        filename = Path(parsed.path).name
        if not filename or "." not in filename:
            raise ValueError("the url must point at a weight file (…/model.safetensors)")
        files = [ModelFile(url=ref, dest=f"{dest_dir}/{slug}-{filename}")]
    elif source == "file":
        src = Path(ref)
        if not src.is_file():
            raise FileNotFoundError(f"no such file: {ref}")
        dest_name = f"{slug}-{src.name}"
        dest = config.resolved_models_dir / dest_dir / dest_name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(src, dest)
        size = dest.stat().st_size
        files = [ModelFile(url="", dest=f"{dest_dir}/{dest_name}", size=size)]
    else:
        raise ValueError("source must be 'url' or 'file'")

    entry = ModelEntry(
        id=slug,
        task=task,
        family=name.strip(),
        requirements=Requirements(
            vram_gb=vram_gb, disk_gb=max(round(size / 2**30, 1), 0.1)
        ),
        license=LicenseInfo(
            id="unknown",
            commercial=False,
            verdict="conditions",
            notes="Added by you — license unverified; outputs are your responsibility.",
        ),
        sources=[{source: ref}],
        files=files,
        comfy_graph_template=workflow_template,
        custom=True,
    )
    custom.models.append(entry)
    _save_custom(config, custom)
    return entry


def remove_custom_model(config: EngineConfig, model_id: str) -> ModelEntry:
    """Drop a custom entry from the register. Raises KeyError when the id
    isn't a custom entry. File cleanup is the caller's job (the download
    manager already knows how to delete an entry's files)."""
    custom = _load_custom(config)
    entry = next((m for m in custom.models if m.id == model_id), None)
    if entry is None:
        raise KeyError(model_id)
    custom.models = [m for m in custom.models if m.id != model_id]
    _save_custom(config, custom)
    return entry
