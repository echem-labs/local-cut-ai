"""Persisted per-task default models — what the Settings → Models picker
writes (<data_dir>/model-defaults.json).

Only tasks whose backends resolve a model per job are accepted: the
ComfyUI kinds (a configured default jumps its task's installed queue in
capability.py, so it is what renders when a node names no model) and the
script LLM (resolve_model consults this before the engine-config
fallback). speech.tts and transcribe bind their model at backend
construction, so a stored default there would be a lie — the route
refuses it rather than storing a knob nothing reads.
"""

from __future__ import annotations

import json
import logging
import re

from ..config import EngineConfig
from ..project.store import _write_atomic
from .loader import load_manifest

logger = logging.getLogger(__name__)

DEFAULTS_VERSION = 1

DEFAULTABLE_TASKS = (
    "text.llm",
    # An LLM that can SEE — the same local server, a model with a vision
    # tower. Its own task rather than a flag on text.llm because the two are
    # different models on almost every machine, and because setting it is the
    # only honest signal that a local model can read a picture: nothing in an
    # OpenAI-compatible `/models` list says whether a name has eyes, and
    # guessing wrong means a confident description of an image nothing looked
    # at. No engine-config fallback for the same reason — unset means "this
    # machine cannot see", which is a true answer.
    "vision.llm",
    "image.gen",
    "video.i2v",
    "video.t2v",
    "music.gen",
)

# Tasks whose default names a model on the local LLM server rather than a
# manifest entry — Ollama-style ("llama3.2", "qwen3:14b", "qwen2.5vl").
_SERVER_TASKS = ("text.llm", "vision.llm")

# Checked with fullmatch: Python's `$` also matches before a trailing newline.
_LLM_NAME = re.compile(r"^[\w.:\-]{1,128}$")


class DefaultsTooNew(RuntimeError):
    """model-defaults.json written by a newer engine — refused, never
    silently reduced (maps to HTTP 409, like every versioned document)."""


def _path(config: EngineConfig):
    return config.data_dir / "model-defaults.json"


def load_defaults(config: EngineConfig) -> dict[str, str]:
    path = _path(config)
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("resetting unreadable model defaults: %s", path)
        return {}
    version = raw.get("version", 1) if isinstance(raw, dict) else 1
    if not isinstance(version, int) or version > DEFAULTS_VERSION:
        raise DefaultsTooNew(
            f"model defaults were written by a newer version of LocalCut AI "
            f"(format v{version}, this engine reads up to v{DEFAULTS_VERSION}) — "
            "update the engine. They have not been modified."
        )
    defaults = raw.get("defaults", {})
    if not isinstance(defaults, dict):
        return {}
    return {
        str(task): str(model)
        for task, model in defaults.items()
        if str(task) in DEFAULTABLE_TASKS and model
    }


def set_default(config: EngineConfig, task: str, model: str | None) -> dict[str, str]:
    """Set (or clear, with None/empty) the default model for a task.
    Raises ValueError for a task or value the engine would not honor and
    KeyError for a model id the manifest does not know."""
    if task not in DEFAULTABLE_TASKS:
        raise ValueError(
            f"task {task!r} does not take a default model "
            f"(accepted: {', '.join(DEFAULTABLE_TASKS)})"
        )
    defaults = load_defaults(config)
    if not model:
        defaults.pop(task, None)
    else:
        model = model.removeprefix("local:")
        if task in _SERVER_TASKS:
            if not _LLM_NAME.fullmatch(model):
                raise ValueError(f"{model!r} is not a valid model name")
        else:
            entry = next((m for m in load_manifest(config).models if m.id == model), None)
            if entry is None:
                raise KeyError(model)
            if entry.task != task:
                raise ValueError(f"{model} serves {entry.task}, not {task}")
        defaults[task] = model
    _write_atomic(
        _path(config),
        json.dumps({"version": DEFAULTS_VERSION, "defaults": defaults}, indent=2),
    )
    return defaults
