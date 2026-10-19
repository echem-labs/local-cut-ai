"""What renders leave in ComfyUI's own folders.

ComfyUI keeps every file a workflow saves in its output folder and every
image sent to it in its input folder. The engine fetches each result into
the project over HTTP, so what ComfyUI kept is a second copy LocalCut never
reads again. LocalCut's own copy is started with those folders in a working
folder of LocalCut's (<data_dir>/work/comfyui), outside the copy's own
folder, and the engine deletes there what each render wrote once the render
is done with it. A ComfyUI of the user's own is never touched: what LocalCut
leaves there sits under `localcut/` in its folders, for the user to find.

ComfyUI is a stand-in server (fake_comfyui.py) that writes files where
ComfyUI would and answers from a cache the way ComfyUI does. What it reports
is untrusted: a reply naming a file outside the working folder, through a
link or a `..`, deletes nothing there.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from conftest import free_port, make_spec
from test_programs import TOKEN, _engine

from localcut_engine.automation import outstanding_jobs
from localcut_engine.backends import comfyui as comfyui_backend
from localcut_engine.backends.base import ExecutionContext
from localcut_engine.backends.comfyui import ComfyUIBackend
from localcut_engine.config import EngineConfig
from localcut_engine.graph.model import KEYFRAME_PORT, NodeKind
from localcut_engine.programs import comfyui
from localcut_engine.programs import setup as program_setup

FAKE = Path(__file__).with_name("fake_comfyui.py")
TOKEN_FIXED = "feedfacecafe"


def _files(folder: Path) -> list[str]:
    """Every file under `folder`, as paths relative to it."""
    if not folder.is_dir():
        return []
    return sorted(
        path.relative_to(folder).as_posix() for path in folder.rglob("*") if path.is_file()
    )


@contextlib.contextmanager
def _comfyui(port: int, *flags: str, behaviour: dict | None = None):
    """The stand-in, started the way the engine starts LocalCut's copy."""
    env = {**os.environ, "FAKE_COMFYUI": json.dumps(behaviour or {})}
    process = subprocess.Popen(
        [sys.executable, str(FAKE), "--port", str(port), *flags],
        env=env,
        stdout=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            assert process.poll() is None, "the stand-in ComfyUI exited"
            with contextlib.suppress(httpx.HTTPError):
                if httpx.get(f"http://127.0.0.1:{port}/system_stats", timeout=1).status_code:
                    break
            time.sleep(0.05)
        yield f"http://127.0.0.1:{port}"
    finally:
        process.terminate()
        process.wait(timeout=10)


def _working_flags(work: Path) -> list[str]:
    return [
        "--output-directory",
        str(work / "output"),
        "--input-directory",
        str(work / "input"),
        "--temp-directory",
        str(work),
    ]


async def _keyframe_then_clip(backend: ComfyUIBackend, project: Path) -> tuple[Path, Path]:
    """A keyframe, then a clip animated from it: one render that only writes
    and one that sends ComfyUI an image first."""
    keyframe = await backend.execute(
        make_spec(NodeKind.KEYFRAME, {"prompt": "a lighthouse"}, output_hash="k" * 64),
        ExecutionContext(output_dir=project),
    )
    clip = await backend.execute(
        make_spec(NodeKind.CLIP, {"prompt": "waves", "duration_s": 2}, output_hash="c" * 64),
        ExecutionContext(output_dir=project, input_artifacts={KEYFRAME_PORT: keyframe}),
    )
    return keyframe, clip


# -- where LocalCut's copy writes -------------------------------------------------


def test_its_own_comfyui_writes_into_a_working_folder_outside_the_copy(tmp_path):
    """Every folder ComfyUI writes while it runs is given on its command line,
    in LocalCut's working folder, so the copy's own folder stays the pinned
    build at the pinned size. Flag names are ComfyUI 0.40.0's: its
    --temp-directory is the folder `temp` goes in, and it refuses a
    --user-directory that is not there yet."""
    data_dir = tmp_path / "data"
    copy = data_dir / "programs" / "comfyui"
    (copy / "python_embeded").mkdir(parents=True)
    (copy / "python_embeded" / "python.exe").write_bytes(b"MZ")
    config = EngineConfig(data_dir=data_dir, token=TOKEN, comfyui_url="http://127.0.0.1:8190")

    launch = program_setup.INSTALLERS["comfyui"].launch(config)

    assert launch is not None
    flags = {
        flag: launch.argv[launch.argv.index(flag) + 1]
        for flag in (
            "--output-directory",
            "--input-directory",
            "--temp-directory",
            "--user-directory",
            "--previews-directory",
        )
        if flag in launch.argv
    }
    work = (data_dir / "work" / "comfyui").resolve()
    assert flags == {
        "--output-directory": str(work / "output"),
        "--input-directory": str(work / "input"),
        "--temp-directory": str(work),
        "--user-directory": str(work / "user"),
        "--previews-directory": str(work / "previews"),
    }
    assert all(copy.resolve() not in Path(value).parents for value in flags.values())
    assert (work / "user").is_dir() and (work / "input").is_dir()


# -- what a render leaves --------------------------------------------------------


async def test_its_own_comfyui_keeps_nothing_localcut_has_fetched(tmp_path):
    """Once a result is in the project, ComfyUI's copy of it is deleted, and
    the image a clip was animated from is deleted once the clip is done. A
    file of someone else's in the same folders (made in that ComfyUI's own
    page) stays."""
    work = tmp_path / "work"
    for kind in ("output", "input"):
        (work / kind).mkdir(parents=True)
        (work / kind / "mine.png").write_bytes(b"made by hand")
    project = tmp_path / "project"
    with _comfyui(free_port(), *_working_flags(work)) as url:
        backend = ComfyUIBackend(base_url=url, kinds="keyframe,clip", own_work=lambda: work)
        keyframe, clip = await _keyframe_then_clip(backend, project)

    assert keyframe.read_bytes() and clip.read_bytes()
    assert _files(work / "output") == ["mine.png"]
    assert _files(work / "input") == ["mine.png"]


async def test_a_render_comfyui_answers_from_its_cache_still_gets_its_file(tmp_path):
    """ComfyUI answers a prompt it has run before from its cache: the history
    names the file the first run wrote, and nothing new is written. Each
    render therefore names its files for itself, or the second of two equal
    renders would ask for the file the first one's cleanup deleted."""
    work = tmp_path / "work"
    spec = make_spec(NodeKind.KEYFRAME, {"prompt": "the same lighthouse"}, output_hash="k" * 64)
    with _comfyui(free_port(), *_working_flags(work)) as url:
        backend = ComfyUIBackend(base_url=url, kinds="keyframe", own_work=lambda: work)
        first = await backend.execute(spec, ExecutionContext(output_dir=tmp_path / "one"))
        second = await backend.execute(spec, ExecutionContext(output_dir=tmp_path / "two"))

    assert first.read_bytes() == second.read_bytes()
    assert _files(work / "output") == []


async def test_a_comfyui_of_the_users_own_keeps_what_localcut_wrote_under_localcut(tmp_path):
    """LocalCut deletes nothing in a ComfyUI that is not its own copy. What its
    renders write there, and the images it sends, sit in a `localcut` folder
    of their own, apart from the user's own work."""
    theirs = tmp_path / "their-comfyui"
    with _comfyui(free_port(), "--base-directory", str(theirs)) as url:
        backend = ComfyUIBackend(base_url=url, kinds="keyframe,clip")
        keyframe, _ = await _keyframe_then_clip(backend, tmp_path / "project")

    outputs = _files(theirs / "output")
    assert len(outputs) == 2 and all(name.startswith("localcut/") for name in outputs)
    assert _files(theirs / "input") == [f"localcut/{keyframe.name}"]


# -- what ComfyUI says is untrusted ----------------------------------------------


def _victims(tmp_path: Path, work: Path) -> list[Path]:
    """Files outside the working folder, named the way the render it is
    asked about names its own, and one inside it that LocalCut did not
    write."""
    outside = tmp_path / "outside"
    outside.mkdir()
    victims = [
        outside / f"keyframe_{TOKEN_FIXED}_00001_.png",
        tmp_path / f"keyframe_{TOKEN_FIXED}_00001_.png",
        work / f"keyframe_{TOKEN_FIXED}_00001_.png",
        work / "input" / "mine.png",
    ]
    for victim in victims:
        victim.parent.mkdir(parents=True, exist_ok=True)
        victim.write_bytes(b"not LocalCut's")
    return victims


async def test_a_reply_naming_files_outside_the_working_folder_deletes_none(tmp_path, monkeypatch):
    """The filename and subfolder ComfyUI reports, for an output and for an
    upload, are taken as the untrusted text they are: a `..`, either
    separator, an absolute path or a drive gets nothing deleted outside the
    folder the reply is about, and an upload reply that names a file the
    engine did not send gets nothing deleted at all."""
    monkeypatch.setattr(comfyui_backend, "_render_token", lambda: TOKEN_FIXED)
    work = tmp_path / "data" / "work"
    victims = _victims(tmp_path, work)
    name = f"keyframe_{TOKEN_FIXED}_00001_.png"
    outside = tmp_path / "outside"
    report = [
        {"filename": f"../../{name}", "subfolder": "localcut", "type": "output"},
        {"filename": name, "subfolder": "localcut/../..", "type": "output"},
        {"filename": name, "subfolder": "localcut\\..\\..\\..", "type": "output"},
        {"filename": name, "subfolder": "localcut/.. /.. /.. ", "type": "output"},
        {"filename": name, "subfolder": f"localcut/{outside}", "type": "output"},
        {"filename": name, "subfolder": str(outside), "type": "output"},
        {"filename": str(outside / name), "subfolder": "localcut", "type": "output"},
        {"filename": f"C:\\{name}", "subfolder": "localcut", "type": "output"},
        {"filename": name, "subfolder": "localcut", "type": "../.."},
        {"filename": "mine.png", "subfolder": "", "type": "input"},
        {"filename": f"{name}\u0000", "subfolder": "localcut", "type": "output"},
    ]
    upload = {"name": "mine.png", "subfolder": "", "type": "input"}
    behaviour = {"report": report, "upload": upload}
    with _comfyui(free_port(), *_working_flags(work), behaviour=behaviour) as url:
        backend = ComfyUIBackend(base_url=url, kinds="keyframe,clip", own_work=lambda: work)
        await _keyframe_then_clip(backend, tmp_path / "project")

    assert [victim.read_bytes() for victim in victims] == [b"not LocalCut's"] * len(victims)


def _symlink(link: Path, target: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(target, target_is_directory=target.is_dir())
    except OSError as exc:  # Windows without the right to make links
        pytest.skip(f"this machine cannot make symbolic links: {exc}")


async def test_a_link_in_the_working_folder_is_never_followed_or_removed(tmp_path, monkeypatch):
    """A link inside the working folder, to a folder or to a file outside it,
    is not something LocalCut wrote: a reply naming a file through one, or
    naming the link itself, leaves the link and what it points at alone."""
    monkeypatch.setattr(comfyui_backend, "_render_token", lambda: TOKEN_FIXED)
    work = tmp_path / "data" / "work"
    outside = tmp_path / "outside"
    outside.mkdir()
    name = f"keyframe_{TOKEN_FIXED}_00001_.png"
    through_folder = outside / name
    through_folder.write_bytes(b"not LocalCut's")
    pointed_at = outside / "pointed-at.png"
    pointed_at.write_bytes(b"not LocalCut's either")
    _symlink(work / "output" / "localcut" / "elsewhere", outside)
    _symlink(work / "output" / "localcut" / name, pointed_at)
    report = [
        {"filename": name, "subfolder": "localcut/elsewhere", "type": "output"},
        {"filename": name, "subfolder": "localcut", "type": "output"},
    ]
    with _comfyui(free_port(), *_working_flags(work), behaviour={"report": report}) as url:
        backend = ComfyUIBackend(base_url=url, kinds="keyframe", own_work=lambda: work)
        await backend.execute(
            make_spec(NodeKind.KEYFRAME, {"prompt": "x"}), ExecutionContext(output_dir=tmp_path)
        )

    assert through_folder.read_bytes() == b"not LocalCut's"
    assert pointed_at.read_bytes() == b"not LocalCut's either"
    assert (work / "output" / "localcut" / name).is_symlink()
    assert (work / "output" / "localcut" / "elsewhere").is_symlink()


# -- the engine -----------------------------------------------------------------


def _managed_copy(monkeypatch, data_dir: Path) -> None:
    """A copy of LocalCut's own, which the engine starts as the stand-in, on
    the command line launch() gives it."""
    folder = data_dir / "programs" / "comfyui"
    (folder / "python_embeded").mkdir(parents=True)
    (folder / "python_embeded" / "python.exe").write_bytes(b"MZ")

    def argv(folder: Path, *, host: str, port: int, cpu: bool = False) -> list[str]:
        return [sys.executable, str(FAKE), "--port", str(port), "--base-directory", str(folder)]

    monkeypatch.setattr(comfyui, "server_argv", argv)


async def _rendered(http: httpx.AsyncClient, project_id: str) -> list[dict]:
    async with asyncio.timeout(120):
        while True:
            jobs = (await http.get("/jobs", params={"project_id": project_id})).json()
            keyframes = [job for job in jobs if job["spec"]["kind"] == "keyframe"]
            if keyframes and not outstanding_jobs(jobs):
                return keyframes
            await asyncio.sleep(0.1)


async def test_a_render_through_its_own_comfyui_leaves_its_folders_empty(tmp_path, monkeypatch):
    """End to end: the engine starts its copy, renders a project's keyframes
    through it and keeps each one in the project. Nothing is left in the
    copy's folder or in the working folder, and Settings > Storage has
    nothing of ComfyUI's to clear."""
    data_dir = tmp_path / "data"
    _managed_copy(monkeypatch, data_dir)
    port = free_port()
    config = EngineConfig(
        data_dir=data_dir,
        token=TOKEN,
        backend="comfy,mock",
        comfy_kinds="keyframe",
        llm_url="http://127.0.0.1:9/v1",
        comfyui_url=f"http://127.0.0.1:{port}",
    )
    async with _engine(config) as http:
        project_id = (await http.post("/projects", json={"prompt": "a lighthouse"})).json()["id"]
        assert (await http.post(f"/projects/{project_id}/render")).status_code == 200
        keyframes = await _rendered(http, project_id)
        storage = (await http.get("/storage")).json()

    assert {(job["status"], job["backend"]) for job in keyframes} == {("done", "comfyui")}
    work = data_dir / "work" / "comfyui"
    assert _files(work / "output") == [] and _files(work / "input") == []
    copy = data_dir / "programs" / "comfyui"
    assert _files(copy) == ["extra_model_paths.yaml", "python_embeded/python.exe"]
    assert storage["comfyui_bytes"] == 0


async def test_clearing_waits_for_a_render_through_its_own_comfyui(tmp_path, monkeypatch):
    """While a render runs through LocalCut's copy, what it sent and what it
    saved are in the working folder until it has fetched them, so clearing
    the folder then is refused. Once the render is done it clears."""
    data_dir = tmp_path / "data"
    _managed_copy(monkeypatch, data_dir)
    monkeypatch.setenv("FAKE_COMFYUI", json.dumps({"hold_s": 1.0}))
    config = EngineConfig(
        data_dir=data_dir,
        token=TOKEN,
        backend="comfy,mock",
        comfy_kinds="keyframe",
        llm_url="http://127.0.0.1:9/v1",
        comfyui_url=f"http://127.0.0.1:{free_port()}",
    )
    async with _engine(config) as http:
        project_id = (await http.post("/projects", json={"prompt": "a lighthouse"})).json()["id"]
        await http.post(f"/projects/{project_id}/render")
        async with asyncio.timeout(120):
            while True:
                jobs = (await http.get("/jobs", params={"project_id": project_id})).json()
                if any(
                    job["spec"]["kind"] == "keyframe" and job["status"] == "rendering"
                    for job in jobs
                ):
                    break
                await asyncio.sleep(0.05)
        during = await http.post("/storage/comfyui/cleanup")
        await _rendered(http, project_id)
        after = await http.post("/storage/comfyui/cleanup")

    assert during.status_code == 409
    assert "a render is using LocalCut's ComfyUI" in during.json()["detail"]
    assert after.status_code == 200


def _aged(path: Path, data: bytes, *, age_s: float) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    stamp = time.time() - age_s
    os.utime(path, (stamp, stamp))
    return path


async def test_an_engine_start_clears_what_renders_before_it_left(tmp_path):
    """A render an earlier engine never finished (cancelled, failed, or cut
    off when that engine stopped) leaves files nobody will fetch. The next
    engine deletes what is older than its own start in ComfyUI's scratch
    folder and in LocalCut's own folders of the copy's output and input. A
    file of someone else's, ComfyUI's own settings and anything a link
    points at stay."""
    data_dir = tmp_path / "data"
    work = data_dir / "work" / "comfyui"
    stale = [
        _aged(work / "temp" / "preview_00001_.png", b"scratch", age_s=3600),
        _aged(work / "output" / "localcut" / "keyframe_0a1b2c3d4e5f_00001_.png", b"x", age_s=60),
        _aged(work / "output" / "localcut" / "videos" / "clip_00001_.mp4", b"x", age_s=60),
        _aged(work / "input" / "localcut" / "kf.png", b"x", age_s=60),
    ]
    kept = [
        _aged(work / "output" / "mine.png", b"by hand", age_s=3600),
        _aged(work / "input" / "mine.png", b"by hand", age_s=3600),
        _aged(work / "user" / "comfyui.db", b"settings", age_s=3600),
        _aged(tmp_path / "outside" / "old.png", b"elsewhere", age_s=3600),
    ]
    with contextlib.suppress(OSError):
        (work / "output" / "localcut" / "elsewhere").symlink_to(tmp_path / "outside")
    config = EngineConfig(data_dir=data_dir, token=TOKEN, comfyui_url="http://127.0.0.1:9")
    async with _engine(config):
        async with asyncio.timeout(10):
            while any(path.exists() for path in stale):
                await asyncio.sleep(0.05)

    assert [path.read_bytes() for path in kept] == [
        b"by hand",
        b"by hand",
        b"settings",
        b"elsewhere",
    ]


async def test_storage_counts_and_clears_its_own_comfyuis_working_files(tmp_path):
    """Settings > Storage counts what LocalCut's copy has written for renders
    (its folders of the output and input and its scratch folder) and clears
    it on request. ComfyUI's settings and anything of someone else's in
    those folders are neither counted nor cleared. With no working folder
    there is nothing to show."""
    data_dir = tmp_path / "data"
    config = EngineConfig(data_dir=data_dir, token=TOKEN, comfyui_url="http://127.0.0.1:9")
    async with _engine(config) as http:
        assert (await http.get("/storage")).json()["comfyui_bytes"] is None

    work = data_dir / "work" / "comfyui"
    ours = [
        _aged(work / "output" / "localcut" / "keyframe_00001_.png", b"1" * 1000, age_s=-60),
        _aged(work / "input" / "localcut" / "kf.png", b"2" * 200, age_s=-60),
        _aged(work / "temp" / "preview.png", b"3" * 30, age_s=-60),
    ]
    theirs = [
        _aged(work / "output" / "mine.png", b"by hand", age_s=-60),
        _aged(work / "user" / "comfyui.db", b"settings", age_s=-60),
    ]
    async with _engine(config) as http:
        before = (await http.get("/storage")).json()["comfyui_bytes"]
        cleared = await http.post("/storage/comfyui/cleanup")
        after = (await http.get("/storage")).json()["comfyui_bytes"]

    assert before == 1230
    assert cleared.status_code == 200 and cleared.json() == {"ok": True, "freed_bytes": 1230}
    assert after == 0
    assert not any(path.exists() for path in ours)
    assert all(path.exists() for path in theirs)
