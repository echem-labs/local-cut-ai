"""What LocalCut knows about ComfyUI in particular: the official Windows
portable build it sets up, the file that points it at LocalCut's models, the
command line it is started with, how to tell it answers and how to tell its
PyTorch can use the graphics card.

The portable build is one folder: an embedded Python with PyTorch for one
GPU vendor (`python_embeded`), ComfyUI's source (`ComfyUI`) and the batch
files that start it. Those run

    .\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build

and LocalCut runs the same, bound to loopback on the configured port, with
its model paths file, its working folder and without the browser the
standalone build opens.

The weights stay where the engine downloads them, in its models folder,
laid out the way ComfyUI lays out its own `models` (checkpoints/,
diffusion_models/, ...). `extra_model_paths.yaml` tells ComfyUI to look
there too; it is written beside the copy each time the copy is started, so
it follows the models folder if that moves. Every node the workflow
templates use is in ComfyUI's core, so no custom node pack is installed.

What ComfyUI writes while it runs goes in a working folder of LocalCut's,
<data_dir>/work/comfyui, not in the copy's folder: every file a workflow
saves (output), every image sent to it (input), its scratch files (temp),
its settings and asset database (user) and the previews it makes (previews).
The copy's folder stays the pinned build at the pinned size. An update
replaces it without throwing anything away and a removal has only the build
to walk. The engine fetches each result into the project, so what a render
left in output and input is deleted once the render is done with it
(backends/comfyui.py). What an earlier engine's renders left there and in
temp is deleted when the next engine starts (`sweep_working_folder`).
Only LocalCut's own subfolder of output and input is ever touched there, only
regular files inside the working folder are deleted and a link is neither
followed nor removed.
"""

from __future__ import annotations

import contextlib
import ipaddress
import json
import logging
import os
import re
import stat
import time
from collections.abc import Iterable
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from ..config import EngineConfig
from ..project.store import _write_atomic

logger = logging.getLogger(__name__)

#: ComfyUI's model folders that the engine's manifest downloads into and
#: two more a user's own weights commonly go in. The desktop's steps for
#: doing it by hand write the same list (test_ui_contract.py).
MODEL_FOLDERS = ("checkpoints", "diffusion_models", "text_encoders", "vae", "clip", "loras")

#: The model paths file, in the copy's folder.
PATHS_FILE = "extra_model_paths.yaml"

#: How long a question to a server waits.
ASK_TIMEOUT_S = 2.0

#: The subfolder of any ComfyUI's output and input folders that LocalCut's
#: renders write their results and send their images under, in its own copy
#: and in a ComfyUI of the user's alike, so they sit apart from anyone
#: else's work there.
SUBFOLDER = "localcut"

#: The folders ComfyUI writes a render's files in, as it names them in a
#: reply (`type`).
FILE_TYPES = ("output", "input", "temp")

# How long a deletion keeps trying while Windows says the file is open: the
# server that just sent it can hold it a moment longer.
_REMOVE_BUDGET_S = 2.0
_REMOVE_PAUSE_S = 0.1


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


def work_dir(config: EngineConfig) -> Path:
    """LocalCut's copy's working folder, outside the copy's own folder."""
    return config.data_dir / "work" / "comfyui"


def make_working_folder(config: EngineConfig) -> Path:
    """Create the working folder with each folder in it and return it,
    resolved: ComfyUI refuses a --user-directory that is not there yet and
    lists its input folder before anything can be uploaded to it."""
    work = work_dir(config).resolve()
    for name in (*FILE_TYPES, "user", "previews"):
        (work / name).mkdir(parents=True, exist_ok=True)
    return work


def working_argv(work: Path) -> list[str]:
    """The flags that put everything ComfyUI writes while it runs in `work`,
    for every platform's command line. Named as ComfyUI 0.40.0 takes them:
    `--temp-directory` names the folder its `temp` goes in, not the temp
    folder itself."""
    return [
        "--output-directory",
        str(work / "output"),
        "--input-directory",
        str(work / "input"),
        "--temp-directory",
        str(work),
        "--user-directory",
        str(work / "user"),
        "--previews-directory",
        str(work / "previews"),
    ]


# -- what renders leave in the working folder --------------------------------------


def _plain_name(name: object) -> bool:
    """Whether `name` is one name in a folder: no separator, no `..`, no
    drive or alternate data stream, nothing a path could climb out with."""
    return (
        isinstance(name, str)
        and name not in ("", ".", "..")
        and not any(c in name for c in "/\\:\0")
    )


def _inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def written_file(work: Path, file_type: str, subfolder: str, filename: str) -> Path | None:
    """Where a file ComfyUI reports as `filename` in `subfolder` of its
    `file_type` folder is in the working folder, or None when the report
    does not name one there. The report is untrusted text: each part has to
    be a plain name. The folder it ends in has to be inside the `file_type`
    folder once it is resolved, which follows every link on the way and
    reads each name as the system does (on Windows `.. ` is `..`). Either
    separator may divide a subfolder, since ComfyUI on Windows reports
    `\\`."""
    if file_type not in FILE_TYPES or not isinstance(subfolder, str):
        return None
    parts = [part for part in re.split(r"[\\/]", subfolder) if part not in ("", ".")]
    if not _plain_name(filename) or not all(_plain_name(part) for part in parts):
        return None
    root = work / file_type
    candidate = root.joinpath(*parts, filename)
    try:
        real_root = root.resolve(strict=True)
        real_folder = candidate.parent.resolve(strict=True)
    except OSError:
        return None
    if not _inside(real_folder, real_root):
        return None
    return real_folder / filename


def _remove_file(path: Path) -> int:
    """Delete `path` if it is a regular file and return its size: 0 for a
    link, a folder or nothing. Windows refuses to delete a file another
    process has open, so that is tried again for a moment."""
    deadline = time.monotonic() + _REMOVE_BUDGET_S
    while True:
        try:
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode):
                return 0
            os.unlink(path)
            return info.st_size
        except FileNotFoundError:
            return 0
        except PermissionError:
            if os.name != "nt" or time.monotonic() >= deadline:
                raise
            time.sleep(_REMOVE_PAUSE_S)


def remove_written(work: Path, files: Iterable[dict]) -> int:
    """Delete the files a render wrote in the working folder, each as
    ComfyUI reported it: {"filename", "subfolder", "type"}. A report that
    does not name a regular file inside the working folder deletes nothing.
    Returns the bytes freed. A file that cannot be deleted now is logged and
    left for the next engine's sweep."""
    freed = 0
    for entry in files:
        target = written_file(
            work, entry.get("type", ""), entry.get("subfolder", ""), entry.get("filename", "")
        )
        if target is None:
            logger.warning("not deleting %r: it names no file in %s", entry, work)
            continue
        try:
            freed += _remove_file(target)
        except OSError as exc:
            logger.warning("could not delete %s: %s", target, exc)
    return freed


def working_roots(work: Path) -> list[Path]:
    """The folders of the working folder that hold only what renders
    wrote: temp and LocalCut's subfolder of output and of input. A root
    that is a link, or resolves outside the working folder, is none."""
    roots = []
    for root in (work / "output" / SUBFOLDER, work / "input" / SUBFOLDER, work / "temp"):
        try:
            if root.is_symlink() or not root.is_dir():
                continue
            if _inside(root.resolve(strict=True), work.resolve(strict=True)):
                roots.append(root)
        except OSError:
            continue
    return roots


def _sweep(root: Path, before: float | None) -> int:
    """Delete every regular file under `root` last written before `before`
    (all of them for None) and the folders that leaves empty below it.
    Never follows a link and never removes one. Returns the bytes freed."""
    freed = 0
    with contextlib.suppress(OSError), os.scandir(root) as entries:
        for entry in list(entries):
            try:
                if entry.is_dir(follow_symlinks=False):
                    freed += _sweep(Path(entry.path), before)
                    with contextlib.suppress(OSError):
                        os.rmdir(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    if before is None or entry.stat(follow_symlinks=False).st_mtime < before:
                        freed += _remove_file(Path(entry.path))
            except OSError as exc:
                logger.warning("could not delete %s: %s", entry.path, exc)
    return freed


def sweep_working_folder(work: Path, before: float) -> int:
    """At engine start: delete what renders an earlier engine started and
    never finished left in the working folder (a render cancelled, failed
    or cut off by that engine stopping), everything there last written
    before `before`. Returns the bytes freed; never raises."""
    try:
        return sum(_sweep(root, before) for root in working_roots(work))
    except Exception:  # noqa: BLE001 - housekeeping never stops a start
        logger.exception("could not clear what renders left in %s", work)
        return 0


def clear_working_folder(work: Path) -> int:
    """Delete everything renders wrote in the working folder, for Settings
    > Storage. Returns the bytes freed."""
    return sum(_sweep(root, None) for root in working_roots(work))


def server_argv(folder: Path, *, host: str, port: int, cpu: bool = False) -> list[str]:
    """The command line LocalCut starts its copy with: the portable build's
    own, with the address, the model paths file and no browser. The setup's
    launch adds `working_argv` to it, as to every platform's."""
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
