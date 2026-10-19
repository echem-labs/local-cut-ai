"""What LocalCut knows about Ollama in particular: how to tell it answers,
the address its own copy may take, where that copy keeps its models, and
pulling a model through it.

LocalCut's copy keeps its models in <models_dir>/ollama, beside the other
weights the engine downloads, and not in the program's folder: an update
replaces that folder whole, and removing the program should not throw away
gigabytes of models a reinstall would download again. Settings > Storage
counts them with the rest of the models.
"""

from __future__ import annotations

import ipaddress
import json
import re
import shutil
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from ..config import EngineConfig
from ..hardware.probe import GPU
from ..manifest.loader import load_manifest
from ..manifest.recommend import server_tag
from .server import Identity

#: How long a question to a server waits.
ASK_TIMEOUT_S = 2.0
# The pull's stream can go quiet for a long time while Ollama verifies a
# large layer; it is the stream that stalls, not the connection.
_PULL_READ_TIMEOUT_S = 600.0
# Left free on the disk when a pull is checked against it, so a pull that
# fits to the byte does not leave a disk the engine can no longer write to.
_PULL_MARGIN = 256 << 20

#: Set for every `ollama serve` LocalCut starts, over whatever the engine's
#: own environment says, so that it calls nothing on the network by itself.
#: With its cloud features on, Ollama 0.40.4 asks ollama.com for model
#: recommendations as it starts and again every few hours. As it starts it
#: also asks for the list of Ollama's cloud models and their details.
#: OLLAMA_NO_CLOUD turns all of that off, along with running a model on
#: Ollama's servers. A pull still reaches Ollama's registry, because someone
#: asked for that model.
OFFLINE = {"OLLAMA_NO_CLOUD": "1"}

#: What `ollama pull` accepts: an optional registry host and namespace, the
#: model, and an optional tag. Checked with fullmatch.
MODEL_NAME = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}"
    r"(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?"
)
MODEL_NAME_MAX = 300


class PullFailed(Exception):
    """Ollama would not pull the model, or the pull stopped partway."""


class PullNoSpace(Exception):
    """The model would not fit on the disk LocalCut's copy keeps models on."""


def root_of(llm_url: str) -> str:
    """The server's own root for an OpenAI-style address: Ollama's native
    API lives beside /v1, not under it."""
    return llm_url.rstrip("/").removesuffix("/v1")


def local_address(llm_url: str) -> tuple[str, int] | None:
    """The address LocalCut's copy would listen on to serve `llm_url`, as
    (host, port), or None when no copy on this machine can: an address on
    another machine, or one that is not plain HTTP. `localhost` is taken as
    127.0.0.1, which is where Ollama would bind for it."""
    try:
        parts = urlsplit(llm_url)
        port = parts.port or 80
    except ValueError:
        return None
    host = parts.hostname or ""
    if parts.scheme != "http" or not host:
        return None
    if host == "localhost":
        return "127.0.0.1", port
    try:
        if not ipaddress.ip_address(host).is_loopback:
            return None
    except ValueError:
        return None
    return host, port


def model_store(config: EngineConfig) -> Path:
    """Where LocalCut's copy keeps the models it pulls (OLLAMA_MODELS)."""
    return config.resolved_models_dir / "ollama"


# Which NVIDIA cards the CUDA libraries in Ollama 0.40.4's builds run, from
# its discover/cuda_compat.go and the architectures llama/server's presets
# compile for. cuda_v12 is CUDA 12.8, built for compute 5.0 and up; cuda_v13
# needs a newer driver than either floor here and a newer card, so it adds
# none. Ollama drops every CUDA device under a driver older than 550. Under
# one older than 570 it drops the cards older than compute 7.0 as well. A
# new pin has to be read for these again.
_CUDA_DRIVER = 550
_CUDA_DRIVER_OLD_CARDS = 570
_CUDA_OLDEST_CARD = (5, 0)
_CUDA_OLD_CARDS_BELOW = (7, 0)


def cuda_runs(gpu: GPU) -> bool:
    """Whether Ollama's CUDA libraries run `gpu`, by the driver and compute
    capability nvidia-smi reported. A figure the probe could not read is not
    taken as met: counting on CUDA for a card it does not run leaves that
    card unused, where not counting on it costs a few seconds of start."""
    if gpu.vendor != "nvidia":
        return False
    try:
        driver = int((gpu.driver_version or "").split(".")[0])
        major, _, minor = (gpu.compute_capability or "").partition(".")
        compute = (int(major), int(minor or 0))
    except ValueError:
        return False
    if compute < _CUDA_OLDEST_CARD or driver < _CUDA_DRIVER:
        return False
    return compute >= _CUDA_OLD_CARDS_BELOW or driver >= _CUDA_DRIVER_OLD_CARDS


def gpu_environment(gpus: list[GPU]) -> dict[str, str]:
    """What LocalCut's copy is started with for this machine's cards.

    Ollama looks for GPUs through Vulkan at every start, beside CUDA, before
    it serves anything. Where CUDA runs the NVIDIA card, that pass finds the
    same card again, which Ollama drops as a duplicate. It also finds any
    integrated graphics, which Ollama drops too. So there Vulkan is turned
    off. Anywhere else it is left as Ollama has it: Vulkan
    is how Ollama's standard build gets the GPU of an AMD or Intel card, or
    of an NVIDIA card CUDA does not run."""
    if any(cuda_runs(gpu) for gpu in gpus):
        return {"OLLAMA_VULKAN": "0"}
    return {}


async def identify(url: str) -> Identity:
    """Who answers at `url`: "self" for an Ollama, which reports its version
    at /api/version, "other" for anything else that answers HTTP, None when
    nothing does."""
    try:
        async with httpx.AsyncClient(timeout=ASK_TIMEOUT_S) as client:
            response = await client.get(f"{root_of(url)}/api/version")
    except httpx.HTTPError:
        return None
    try:
        body = response.json()
    except ValueError:
        return "other"
    if response.status_code == 200 and isinstance(body, dict) and body.get("version"):
        return "self"
    return "other"


async def listed_models(url: str) -> list[str] | None:
    """The models the Ollama at `url` has, or None when it cannot say."""
    try:
        async with httpx.AsyncClient(timeout=ASK_TIMEOUT_S) as client:
            response = await client.get(f"{root_of(url)}/api/tags")
        models = response.json().get("models") if response.status_code == 200 else None
    except (httpx.HTTPError, ValueError, AttributeError):
        return None
    if not isinstance(models, list):
        return None
    return [str(entry["name"]) for entry in models if isinstance(entry, dict) and entry.get("name")]


def lists_model(names: list[str], model: str) -> bool:
    """Whether `names` holds `model`, where `llama3.2` is `llama3.2:latest`."""
    wanted = model.removesuffix(":latest")
    return any(name.removesuffix(":latest") == wanted for name in names)


def model_on_disk(store: Path, model: str) -> bool:
    """Whether LocalCut's copy has pulled `model`, read from its store
    without asking a server: Ollama writes one manifest per model, at
    manifests/<registry>/<namespace>/<model>/<tag>."""
    name, _, tag = model.partition(":")
    parts = name.split("/")
    if len(parts) == 1:
        parts = ["registry.ollama.ai", "library", *parts]
    elif len(parts) == 2:
        parts = ["registry.ollama.ai", *parts]
    try:
        return (store / "manifests").joinpath(*parts, tag or "latest").is_file()
    except (OSError, ValueError):
        return False


def model_bytes(config: EngineConfig, model: str) -> int | None:
    """About how much disk `model` takes once pulled: the catalog's figure
    for the entry Ollama knows by that name. None for a model the catalog
    does not hold. Ollama gives exact sizes only once a pull has begun."""
    try:
        entries = load_manifest(config).models
    except (OSError, ValueError):
        return None
    wanted = model.removesuffix(":latest")
    for entry in entries:
        tag = server_tag(entry)
        if entry.task == "text.llm" and tag and tag.removesuffix(":latest") == wanted:
            return int(entry.requirements.disk_gb * 2**30)
    return None


async def pull(
    url: str,
    model: str,
    progress: Callable[[int, int], None],
    *,
    store: Path | None = None,
) -> None:
    """Pull `model` through the Ollama at `url`, reporting bytes as they
    arrive: (done, total) summed over every layer Ollama has named so far,
    so the total grows as the pull finds its layers.

    With `store` (LocalCut's own copy), every new layer is held against the
    free space on the disk that holds it, and the pull stops with
    PullNoSpace rather than fill the disk. A server of the user's own keeps
    its models somewhere LocalCut cannot see, so it is left to say so itself.

    Raises PullFailed when Ollama answers with an error or the stream ends
    without `success`. Cancelling closes the request, which stops the pull
    on Ollama's side; what it fetched stays in its store, and the next pull
    picks up from there."""
    totals: dict[str, int] = {}
    done: dict[str, int] = {}
    timeout = httpx.Timeout(ASK_TIMEOUT_S * 5, read=_PULL_READ_TIMEOUT_S)
    async with (
        httpx.AsyncClient(timeout=timeout) as client,
        client.stream("POST", f"{root_of(url)}/api/pull", json={"model": model}) as response,
    ):
        if response.status_code != 200:
            body = (await response.aread()).decode("utf-8", "replace")
            raise PullFailed(_error_of(body) or f"Ollama answered {response.status_code}")
        async for line in response.aiter_lines():
            if not line.strip():
                continue
            try:
                update = json.loads(line)
            except ValueError:
                continue
            if not isinstance(update, dict):
                continue
            if update.get("error"):
                raise PullFailed(str(update["error"]))
            if update.get("status") == "success":
                return
            digest = update.get("digest")
            total = update.get("total")
            if isinstance(digest, str) and isinstance(total, int) and total > 0:
                new = digest not in totals
                totals[digest] = total
                completed = update.get("completed")
                if isinstance(completed, int):
                    done[digest] = min(completed, total)
                if new and store is not None:
                    _check_space(store, totals, done)
                progress(sum(done.values()), sum(totals.values()))
    raise PullFailed(f"Ollama stopped answering before {model} was pulled")


def _check_space(store: Path, totals: dict[str, int], done: dict[str, int]) -> None:
    store.mkdir(parents=True, exist_ok=True)
    left = sum(total - done.get(digest, 0) for digest, total in totals.items())
    free = shutil.disk_usage(store).free
    if left + _PULL_MARGIN > free:
        raise PullNoSpace(
            f"the model needs {left} more bytes in {store}, and {free} are free there"
        )


def _error_of(body: str) -> str | None:
    try:
        parsed = json.loads(body)
    except ValueError:
        return body.strip()[:500] or None
    return str(parsed.get("error")) if isinstance(parsed, dict) and parsed.get("error") else None
