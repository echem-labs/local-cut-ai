"""GET /programs: each program as this engine finds it, right now.

For FFmpeg that is the binary the engine would run (config.ffmpeg_lookup),
whether ffprobe is beside it, the version it reports, and whether it draws
text, asked through the same probe an export's refusal reads. For the LLM
server and ComfyUI it is whether anything answers at the configured address,
and what: the version each reports, and for the LLM server whether the model
scripts are written with is there.

Cheap enough to ask often. The binaries are run only the first time they are
seen (their answers are kept per binary, backends/ffmpeg.py), the servers
are asked over loopback or the LAN with a short timeout and the answer is
kept for a few seconds, and nothing here downloads anything.

Paths are the engine machine's own. A desktop paired with a remote engine
shows them as the remote box's paths, and reaches them only through these
routes.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
from pathlib import Path

import httpx

from .. import storage
from ..backends import ffmpeg as ffmpeg_backend
from ..backends.ffmpeg import FFmpegBackend, _ffprobe_beside
from ..config import EngineConfig
from ..readiness import _lists_model
from . import PROGRAM_IDS
from . import manifest as program_manifest
from .setup import INSTALLERS, ProgramSetup, is_current, pinned, read_record

# Servers are asked with this timeout, concurrently, and the answer is kept
# this long, so a screen asking every second does not ask the server every
# second, and an address that drops packets costs one timeout, not one per
# request.
_SERVER_TIMEOUT_S = 2.0
_SERVER_TTL_S = 3.0
_server_answers: dict[tuple[str, str], tuple[float, dict]] = {}

_DEFAULTS = EngineConfig.model_fields


def version_number(reported: str) -> str:
    """The release number in a version string, where it starts with one:
    "n8.1.3-9-g29e619e767-20260930" is 8.1.3 and "8.0.1-3ubuntu2" is 8.0.1.
    A build from a development branch has none ("N-125628-ga5e6c0175a") and
    is reported as it reports itself."""
    release = re.match(r"n?(\d+(?:\.\d+)+)", reported)
    return release.group(1) if release else reported


async def programs_report(
    config: EngineConfig,
    setup: ProgramSetup,
    text_probe: FFmpegBackend,
    script_model: str,
) -> dict:
    """The whole GET /programs document."""
    rows = await asyncio.gather(
        _ffmpeg(config, setup, text_probe),
        _llm_server(config, setup, script_model),
        _comfyui(config, setup),
    )
    totals = await asyncio.to_thread(_totals, config)
    return {
        "platform": program_manifest.platform_key(),
        **totals,
        "programs": sorted(rows, key=lambda row: PROGRAM_IDS.index(row["id"])),
    }


def _totals(config: EngineConfig) -> dict:
    root = config.programs_dir
    return {
        # Resolved, as /storage reports the data dir: "used where?" has no
        # answer in a relative path, least of all on a remote engine.
        "programs_dir": str(root.resolve()),
        "programs_bytes": storage._dir_size(root),
        "disk_free_bytes": shutil.disk_usage(root if root.is_dir() else config.data_dir).free,
    }


def _row(program_id: str, source: str, location: str, setting: str) -> dict:
    return {
        "id": program_id,
        "state": "missing",
        "problem": None,
        "source": source,
        "location": location,
        "setting": setting,
        "version": None,
        "checks": {},
    }


def _setup(config: EngineConfig, setup: ProgramSetup, program_id: str) -> dict:
    """What setting this program up would download and keep here, or why it
    cannot be, and the setup running or last ended."""
    pin, asset, unavailable = pinned(program_id)
    installer = INSTALLERS.get(program_id)
    return {
        "available": asset is not None,
        "unavailable_reason": unavailable,
        "takes_effect": asset is not None
        and installer is not None
        and installer.takes_effect(config),
        "version": pin.version if pin is not None and asset is not None else None,
        "url": asset.url if asset is not None else None,
        "download_bytes": asset.size if asset is not None else None,
        "install_bytes": asset.install_bytes if asset is not None else None,
        **setup.state(program_id),
    }


def _managed(config: EngineConfig, program_id: str) -> dict | None:
    """LocalCut's own copy, when there is one: where, how much disk it takes,
    which build, whether that is the build pinned now, and whether the engine
    is using it."""
    folder = config.programs_dir / program_id
    if not folder.is_dir():
        return None
    record = read_record(folder)
    _, asset, _ = pinned(program_id)
    installer = INSTALLERS.get(program_id)
    return {
        "location": str(folder.resolve()),
        "bytes": storage._dir_size(folder),
        "version": record.get("version") if record is not None else None,
        "current": is_current(folder, asset),
        "in_use": installer is not None and installer.in_use(config),
    }


async def _ffmpeg(config: EngineConfig, setup: ProgramSetup, text_probe: FFmpegBackend) -> dict:
    source, name = config.ffmpeg_lookup
    bare = not os.path.dirname(name)
    found = shutil.which(name) if bare else (name if Path(name).is_file() else None)
    row = _row("ffmpeg", source, found or name, "LOCALCUT_FFMPEG_BIN")
    row["checks"] = {"draws_text": None}
    if found is not None:
        # The ffprobe the engine would run with it: beside a path, or looked
        # up on PATH for a bare name, exactly as the backend derives it.
        probe = _ffprobe_beside(name)
        has_probe = shutil.which(probe) if bare else (probe if Path(probe).is_file() else None)
        reported = await ffmpeg_backend.probe_version(found)
        if reported is None:
            row.update(state="broken", problem="does_not_run")
        else:
            row["version"] = version_number(reported)
            if has_probe is None:
                row.update(state="broken", problem="ffprobe_missing")
            else:
                row.update(state="ready")
                row["checks"]["draws_text"] = await text_probe.supports_drawtext()
    else:
        row["problem"] = "not_found"
    row["managed"] = await asyncio.to_thread(_managed, config, "ffmpeg")
    row["setup"] = _setup(config, setup, "ffmpeg")
    return row


def _source_of(config: EngineConfig, field: str) -> str:
    return "default" if getattr(config, field) == _DEFAULTS[field].default else "configured"


async def _server_answer(kind: str, url: str, ask) -> dict:  # noqa: ANN001 - a coroutine function
    key = (kind, url)
    kept = _server_answers.get(key)
    if kept is not None and time.monotonic() - kept[0] < _SERVER_TTL_S:
        return kept[1]
    answer = await ask()
    _server_answers[key] = (time.monotonic(), answer)
    return answer


async def _get_json(client: httpx.AsyncClient, url: str) -> tuple[int, object]:
    """(status, body) for a GET, the body None when it is not JSON. Raises
    httpx.HTTPError when nothing answers."""
    response = await client.get(url)
    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, None


async def _llm_server(config: EngineConfig, setup: ProgramSetup, script_model: str) -> dict:
    url = config.llm_url
    base = url.rstrip("/")
    root = base.removesuffix("/v1")
    chat = base if base.endswith("/v1") else f"{base}/v1"

    async def ask() -> dict:
        async with httpx.AsyncClient(timeout=_SERVER_TIMEOUT_S) as client:
            version, models = await asyncio.gather(
                _get_json(client, f"{root}/api/version"),
                _get_json(client, f"{chat}/models"),
                return_exceptions=True,
            )
        return {"version": version, "models": models}

    answer = await _server_answer("llm", url, ask)
    row = _row("ollama", _source_of(config, "llm_url"), url, "LOCALCUT_LLM_URL")
    row["checks"] = {"server": None, "model": script_model, "model_present": None}
    version, models = answer["version"], answer["models"]
    if isinstance(models, BaseException) and isinstance(version, BaseException):
        row["problem"] = "unreachable"
    elif isinstance(models, tuple) and models[0] == 200 and isinstance(models[1], dict):
        row["state"] = "ready"
        if isinstance(version, tuple) and version[0] == 200 and isinstance(version[1], dict):
            row["version"] = str(version[1].get("version") or "") or None
        row["checks"]["server"] = "ollama" if row["version"] else "other"
        data = models[1].get("data")
        names = [
            str(entry["id"])
            for entry in (data if isinstance(data, list) else [])
            if isinstance(entry, dict) and entry.get("id")
        ]
        # An empty list is a server that does not list its models, which
        # says nothing about whether this one is there (readiness reads it
        # the same way).
        row["checks"]["model_present"] = _lists_model(names, script_model) if names else None
    else:
        row.update(state="broken", problem="unexpected_response")
    row["managed"] = await asyncio.to_thread(_managed, config, "ollama")
    row["setup"] = _setup(config, setup, "ollama")
    return row


async def _comfyui(config: EngineConfig, setup: ProgramSetup) -> dict:
    url = config.comfyui_url

    async def ask() -> dict:
        async with httpx.AsyncClient(timeout=_SERVER_TIMEOUT_S) as client:
            try:
                return {"stats": await _get_json(client, f"{url.rstrip('/')}/system_stats")}
            except Exception as exc:  # noqa: BLE001 - an address nothing answers at, however it fails
                return {"stats": exc}

    answer = await _server_answer("comfyui", url, ask)
    row = _row("comfyui", _source_of(config, "comfyui_url"), url, "LOCALCUT_COMFYUI_URL")
    stats = answer["stats"]
    system = (
        stats[1].get("system") if isinstance(stats, tuple) and isinstance(stats[1], dict) else None
    )
    if isinstance(stats, BaseException):
        row["problem"] = "unreachable"
    elif stats[0] == 200 and isinstance(system, dict):
        row["state"] = "ready"
        row["version"] = str(system.get("comfyui_version") or "") or None
    else:
        row.update(state="broken", problem="unexpected_response")
    row["managed"] = await asyncio.to_thread(_managed, config, "comfyui")
    row["setup"] = _setup(config, setup, "comfyui")
    return row
