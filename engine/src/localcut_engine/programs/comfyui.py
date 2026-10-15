"""What LocalCut knows about ComfyUI in particular: the official Windows
portable build it sets up, the file that points it at LocalCut's models, the
command line it is started with, how to tell it answers and how to tell its
PyTorch can use the graphics card.

The portable build is one folder: an embedded Python with PyTorch for one
GPU vendor (`python_embeded`), ComfyUI's source (`ComfyUI`) and the batch
files that start it. Those run

    .\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build

and LocalCut runs the same, bound to loopback on the configured port, with
its model paths file and without the browser the standalone build opens.

The weights stay where the engine downloads them, in its models folder,
laid out the way ComfyUI lays out its own `models` (checkpoints/,
diffusion_models/, ...). `extra_model_paths.yaml` tells ComfyUI to look
there too; it is written beside the copy each time the copy is started, so
it follows the models folder if that moves. Every node the workflow
templates use is in ComfyUI's core, so no custom node pack is installed.
"""

from __future__ import annotations

import ipaddress
import json
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from ..project.store import _write_atomic

#: ComfyUI's model folders that the engine's manifest downloads into and
#: two more a user's own weights commonly go in. The desktop's steps for
#: doing it by hand write the same list (test_ui_contract.py).
MODEL_FOLDERS = ("checkpoints", "diffusion_models", "text_encoders", "vae", "clip", "loras")

#: The model paths file, in the copy's folder.
PATHS_FILE = "extra_model_paths.yaml"

#: How long a question to a server waits.
ASK_TIMEOUT_S = 2.0


def model_paths_yaml(models_dir: Path) -> str:
    """The extra_model_paths.yaml that points ComfyUI at `models_dir`.

    The base path is written with forward slashes, which ComfyUI reads on
    Windows too and quoted the way JSON quotes a string, which YAML reads
    the same: a folder name with a `#` or a `: ` in it stays a folder name."""
    base = json.dumps(str(models_dir.resolve()).replace("\\", "/"))
    folders = "".join(f"  {name}: {name}\n" for name in MODEL_FOLDERS)
    return f"localcut:\n  base_path: {base}\n{folders}"


def write_model_paths(folder: Path, models_dir: Path) -> Path:
    """Write the model paths file into the copy's folder, if what is there
    says anything else and return its path."""
    target = folder / PATHS_FILE
    text = model_paths_yaml(models_dir)
    try:
        if target.read_text(encoding="utf-8") == text:
            return target
    except OSError:
        pass
    _write_atomic(target, text)
    return target


def python_of(folder: Path) -> Path:
    """The portable build's own Python."""
    return folder / "python_embeded" / "python.exe"


def server_argv(folder: Path, *, host: str, port: int, cpu: bool = False) -> list[str]:
    """The command line LocalCut starts its copy with: the portable build's
    own, with the address, the model paths file and no browser."""
    argv = [
        str(python_of(folder)),
        "-s",
        str(folder / "ComfyUI" / "main.py"),
        "--windows-standalone-build",
        "--disable-auto-launch",
        "--listen",
        host,
        "--port",
        str(port),
        "--extra-model-paths-config",
        str(folder / PATHS_FILE),
    ]
    if cpu:
        argv.append("--cpu")
    return argv


def local_address(url: str) -> tuple[str, int] | None:
    """The address LocalCut's copy would listen on to serve `url`, as
    (host, port), or None when no copy on this machine can: an address on
    another machine, or one that is not plain HTTP. `localhost` is taken as
    127.0.0.1, where the copy binds for it."""
    try:
        parts = urlsplit(url)
        port = parts.port or 80
    except ValueError:
        return None
    host = parts.hostname or ""
    if parts.scheme != "http" or not host or parts.path.strip("/"):
        return None
    if host == "localhost":
        return "127.0.0.1", port
    try:
        if not ipaddress.ip_address(host).is_loopback:
            return None
    except ValueError:
        return None
    return host, port


async def identify(url: str) -> str | None:
    """Who answers at `url`: "self" for a ComfyUI, which reports its version
    under `system` at /system_stats, "other" for anything else that answers
    HTTP, None when nothing does."""
    try:
        async with httpx.AsyncClient(timeout=ASK_TIMEOUT_S) as client:
            response = await client.get(f"{url.rstrip('/')}/system_stats")
    except httpx.HTTPError:
        return None
    try:
        body = response.json()
    except ValueError:
        return "other"
    system = body.get("system") if isinstance(body, dict) else None
    if response.status_code == 200 and isinstance(system, dict):
        return "self"
    return "other"


#: Run by the portable build's Python to find out whether its PyTorch can
#: use the card: one small sum on the device, which is what fails on a card
#: the build has no kernels for even where `is_available()` says yes. It
#: prints one line of JSON last.
DEVICE_CHECK = """
import json, sys
out = {"torch": None, "device": None, "error": None}
try:
    import torch
    out["torch"] = torch.__version__
    vendor = sys.argv[1]
    if vendor == "intel":
        api, kind = getattr(torch, "xpu", None), "xpu"
    else:
        api, kind = torch.cuda, "cuda"
    if api is None or not api.is_available():
        out["error"] = "PyTorch finds no " + kind + " device"
    else:
        value = (torch.ones(4, device=kind) * 2).sum().item()
        if value != 8:
            out["error"] = "the device computed 2 * 4 ones as " + repr(value)
        else:
            out["device"] = api.get_device_name(0)
except Exception as exc:
    out["error"] = type(exc).__name__ + ": " + str(exc)
print(json.dumps(out))
"""


def device_answer(stdout: str) -> dict | None:
    """The check's answer: its last line of output, as JSON."""
    for line in reversed(stdout.strip().splitlines()):
        try:
            answer = json.loads(line)
        except ValueError:
            continue
        if isinstance(answer, dict) and {"torch", "device", "error"} <= answer.keys():
            return answer
    return None
