"""Download manager: fresh, resumed, and checksum-failing downloads against
a local HTTP server (python's RangeRequestHandler-capable SimpleHTTP)."""

import asyncio
import email.utils
import hashlib
import pathlib
import threading
from datetime import UTC, datetime, timedelta
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from localcut_engine.manifest import downloads as downloads_module
from localcut_engine.manifest.downloads import (
    ChecksumMismatch,
    DownloadError,
    SizeMismatch,
    UnsafeURL,
    assert_public_url,
    download_file,
    download_file_retrying,
    download_model,
    is_downloaded,
    partial_bytes,
)
from localcut_engine.manifest.model import LicenseInfo, ModelEntry, ModelFile, Requirements

PAYLOAD = b"localcut-weights-" * 64 * 1024  # ~1 MiB


class RangeHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with minimal Range support."""

    def send_head(self):
        range_header = self.headers.get("Range")
        if range_header is None:
            return super().send_head()
        path = self.translate_path(self.path)
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404)
            return None
        size = f.seek(0, 2)
        start = int(range_header.removeprefix("bytes=").split("-")[0])
        if start >= size:
            self.send_error(416)
            f.close()
            return None
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Length", str(size - start))
        self.send_header("Content-Range", f"bytes {start}-{size - 1}/{size}")
        self.end_headers()
        return f

    def log_message(self, *args):
        pass


@pytest.fixture
def server(tmp_path, monkeypatch):
    """A loopback weight server. The SSRF guard exists precisely to refuse
    loopback (see the assert_public_url tests below), so these mechanics
    tests neutralize it — they are about resume/checksum/limits, not policy."""
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    (tmp_path / "weights.bin").write_bytes(PAYLOAD)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(RangeHandler, directory=str(tmp_path)))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def model_file(url: str, sha256: str = "") -> ModelFile:
    return ModelFile(url=url, dest="checkpoints/weights.bin", sha256=sha256)


async def test_fresh_download_verifies_checksum(server, tmp_path):
    models_dir = tmp_path / "models"
    good = hashlib.sha256(PAYLOAD).hexdigest()
    path = await download_file(model_file(f"{server}/weights.bin", good), models_dir)
    assert path.read_bytes() == PAYLOAD
    assert not path.with_suffix(path.suffix + ".part").exists()


async def test_resume_from_partial(server, tmp_path):
    models_dir = tmp_path / "models"
    dest = models_dir / "checkpoints/weights.bin"
    dest.parent.mkdir(parents=True)
    part = dest.with_suffix(dest.suffix + ".part")
    part.write_bytes(PAYLOAD[: len(PAYLOAD) // 2])  # interrupted halfway

    progress_starts = []

    async def progress(name, done, total):
        progress_starts.append(done)

    good = hashlib.sha256(PAYLOAD).hexdigest()
    path = await download_file(
        model_file(f"{server}/weights.bin", good), models_dir, progress=progress
    )
    assert path.read_bytes() == PAYLOAD
    # First progress callback starts beyond the partial size → actually resumed.
    assert progress_starts[0] > len(PAYLOAD) // 2


async def test_checksum_mismatch_discards_partial(server, tmp_path):
    models_dir = tmp_path / "models"
    with pytest.raises(ChecksumMismatch):
        await download_file(model_file(f"{server}/weights.bin", "0" * 64), models_dir)
    dest = models_dir / "checkpoints/weights.bin"
    assert not dest.exists()
    assert not dest.with_suffix(dest.suffix + ".part").exists()


async def test_existing_valid_file_is_skipped(server, tmp_path):
    models_dir = tmp_path / "models"
    dest = models_dir / "checkpoints/weights.bin"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(PAYLOAD)
    good = hashlib.sha256(PAYLOAD).hexdigest()
    path = await download_file(
        model_file(f"{server}/does-not-exist.bin", good), models_dir
    )  # URL 404s — proves no request was needed
    assert path == dest


async def test_stream_larger_than_manifest_size_is_aborted(server, tmp_path):
    """A lying/compromised server must not be able to fill the disk: the
    stream is cut off once it exceeds the manifest's declared size."""
    oversized = ModelFile(url=f"{server}/weights.bin", dest="checkpoints/weights.bin", size=1024)
    with pytest.raises(DownloadError, match="exceeded"):
        await download_file(oversized, tmp_path / "models")
    part = tmp_path / "models/checkpoints/weights.bin.part"
    assert not part.exists()  # poisoned bytes are not kept for resume


@pytest.mark.parametrize("extra", [-1, 1])
async def test_an_exact_size_download_refuses_any_other_length(tmp_path, monkeypatch, extra):
    """A program's pin holds its download to the byte, and says so before
    the digest does: a body one byte short or one byte long is refused as
    the wrong size, and nothing of it is kept."""
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    body = PAYLOAD[:-1] if extra < 0 else PAYLOAD + b"!"
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=body))
    )
    pinned = ModelFile(
        url="https://cdn.example.com/w.bin",
        dest="w.bin",
        sha256=hashlib.sha256(PAYLOAD).hexdigest(),
        size=len(PAYLOAD),
    )
    with pytest.raises(SizeMismatch) as refused:
        await download_file(pinned, tmp_path / "out", client=client, exact_size=True)
    await client.aclose()
    assert (refused.value.expected, refused.value.actual) == (len(PAYLOAD), len(PAYLOAD) + extra)
    assert list((tmp_path / "out").iterdir()) == []


async def test_http_error_raises(server, tmp_path):
    with pytest.raises(DownloadError, match="404"):
        await download_file(model_file(f"{server}/missing.bin"), tmp_path / "models")


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/w.bin",  # cleartext at all
        "https://127.0.0.1/w.bin",  # loopback
        "https://localhost/w.bin",
        "https://10.0.0.5/w.bin",  # RFC1918
        "https://192.168.1.10/w.bin",
        "https://172.16.4.4/w.bin",
        "https://169.254.169.254/latest/meta-data/",  # cloud metadata
        "https://[::1]/w.bin",
        "https://100.64.0.1/w.bin",  # CGNAT
        "ftp://example.com/w.bin",
        "https:///w.bin",  # no host
    ],
)
def test_ssrf_guard_refuses_non_public_targets(url):
    """A catalog entry's URL is user-supplied and fetched from the engine's
    network position — on the remote topology that is a box inside someone's
    LAN, or a cloud instance with a metadata endpoint. Anything not plain
    https-to-public must be refused before a request goes out."""
    with pytest.raises(UnsafeURL):
        assert_public_url(url)


def test_ssrf_guard_allows_a_public_https_host(monkeypatch):
    monkeypatch.setattr(
        downloads_module.socket,
        "getaddrinfo",
        lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))],
    )
    assert_public_url("https://weights.example.com/model.safetensors")  # no raise


def test_ssrf_guard_refuses_a_host_that_resolves_to_any_private_address(monkeypatch):
    """Split-horizon DNS: one public answer must not launder a private one —
    httpx would be free to dial either."""
    monkeypatch.setattr(
        downloads_module.socket,
        "getaddrinfo",
        lambda *a, **k: [
            (2, 1, 6, "", ("93.184.216.34", 443)),
            (2, 1, 6, "", ("169.254.169.254", 443)),
        ],
    )
    with pytest.raises(UnsafeURL, match="169.254.169.254"):
        assert_public_url("https://sneaky.example.com/model.safetensors")


async def test_redirect_into_a_private_host_is_refused(tmp_path, monkeypatch):
    """httpx's own follow_redirects would only have checked the URL we passed,
    so a public host could bounce the engine onto the metadata endpoint."""
    seen = []

    def fake_guard(url: str) -> None:
        seen.append(url)
        if "169.254" in url:
            raise UnsafeURL("non-public address")

    monkeypatch.setattr(downloads_module, "assert_public_url", fake_guard)

    def handler(request):
        if "start" in str(request.url):
            return httpx.Response(302, headers={"location": "https://169.254.169.254/w.bin"})
        return httpx.Response(200, content=PAYLOAD)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(UnsafeURL):
        await download_file(
            model_file("https://cdn.example.com/start.bin"), tmp_path / "models", client=client
        )
    await client.aclose()
    assert seen == ["https://cdn.example.com/start.bin", "https://169.254.169.254/w.bin"]


async def test_checksumless_download_rejects_a_login_page(tmp_path, monkeypatch):
    """A manifest entry with no sha256 has nothing verifying the bytes. A
    captive portal's HTML would otherwise be saved as .safetensors and report
    installed forever, so the real weights never download and the failure
    surfaces much later as an opaque load error."""
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                content=b"<html><body>Sign in to the hotel wifi</body></html>",
                headers={"content-type": "text/html; charset=utf-8"},
            )
        )
    )
    with pytest.raises(DownloadError, match="not a weight file"):
        await download_file(
            model_file("https://cdn.example.com/w.bin"), tmp_path / "models", client=client
        )
    await client.aclose()
    assert not (tmp_path / "models/checkpoints/weights.bin").exists()
    assert not (tmp_path / "models/checkpoints/weights.bin.part").exists()


async def test_checksumless_download_rejects_an_implausibly_small_body(tmp_path, monkeypatch):
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, content=b"not found", headers={"content-type": "application/octet-stream"}
            )
        )
    )
    with pytest.raises(DownloadError, match="too small"):
        await download_file(
            model_file("https://cdn.example.com/w.bin"), tmp_path / "models", client=client
        )
    await client.aclose()


async def test_checksumless_download_of_real_weights_still_succeeds(tmp_path, monkeypatch):
    """The heuristics must not block the legitimate case they exist beside."""
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, content=PAYLOAD, headers={"content-type": "application/octet-stream"}
            )
        )
    )
    path = await download_file(
        model_file("https://cdn.example.com/w.bin"), tmp_path / "models", client=client
    )
    await client.aclose()
    assert path.read_bytes() == PAYLOAD


async def test_a_complete_partial_resumes_past_a_416_error_page(tmp_path, monkeypatch):
    """416 means the .part is already complete — the response carries an error
    page, not the file, so its content-type says nothing about the bytes on
    disk. Reading the type off it condemned a finished multi-GB download as a
    login page and deleted it, on the one path resume exists to protect."""
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    part = tmp_path / "models" / "checkpoints" / "weights.bin.part"
    part.parent.mkdir(parents=True)
    part.write_bytes(PAYLOAD)
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                416,
                content=b"<html><body>Range Not Satisfiable</body></html>",
                headers={"content-type": "text/html; charset=utf-8"},
            )
        )
    )
    path = await download_file(
        model_file("https://cdn.example.com/w.bin"), tmp_path / "models", client=client
    )
    await client.aclose()
    assert path.read_bytes() == PAYLOAD
    assert not part.exists()  # promoted, not abandoned


async def test_a_resume_answered_from_another_byte_is_not_appended(tmp_path, monkeypatch):
    """A 206 is a resume only when its Content-Range starts where the .part
    ends. A proxy that answers `bytes=N-` with the file from its first byte,
    still as a 206, would otherwise have the whole file written after the N
    bytes already there. The .part goes too, so the next attempt asks for
    the whole file rather than a resume this server cannot answer."""
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    part = tmp_path / "models" / "checkpoints" / "weights.bin.part"
    part.parent.mkdir(parents=True)
    part.write_bytes(PAYLOAD[: len(PAYLOAD) // 2])
    asked = []

    def handler(request):
        asked.append(request.headers.get("range"))
        return httpx.Response(
            206,
            content=PAYLOAD,
            headers={"content-range": f"bytes 0-{len(PAYLOAD) - 1}/{len(PAYLOAD)}"},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    good = hashlib.sha256(PAYLOAD).hexdigest()
    with pytest.raises(DownloadError, match="resume from byte"):
        await download_file(
            model_file("https://cdn.example.com/w.bin", good), tmp_path / "models", client=client
        )
    await client.aclose()
    assert asked == [f"bytes={len(PAYLOAD) // 2}-"]
    assert not part.exists()


def test_is_downloaded(tmp_path):
    entry = ModelEntry(
        id="m1",
        task="image.gen",
        family="test",
        requirements=Requirements(vram_gb=1, disk_gb=1),
        license=LicenseInfo(id="mit", commercial=True),
        files=[ModelFile(url="http://x/y", dest="checkpoints/y.bin")],
    )
    assert not is_downloaded(entry, tmp_path)
    (tmp_path / "checkpoints").mkdir(parents=True)
    (tmp_path / "checkpoints/y.bin").write_bytes(b"x")
    assert is_downloaded(entry, tmp_path)


def test_partial_bytes_reports_resumable_state(tmp_path):
    """An interrupted download must be visible as partial bytes — the UI's
    Resume label (vs a fresh Download) has no other signal."""
    entry = ModelEntry(
        id="m1",
        task="video.i2v",
        family="test",
        requirements=Requirements(vram_gb=1, disk_gb=1),
        license=LicenseInfo(id="mit", commercial=True),
        files=[
            ModelFile(url="http://x/a", dest="checkpoints/a.bin", size=100),
            ModelFile(url="http://x/b", dest="checkpoints/b.bin", size=100),
        ],
    )
    assert partial_bytes(entry, tmp_path) == 0  # fresh: nothing on disk
    (tmp_path / "checkpoints").mkdir(parents=True)
    (tmp_path / "checkpoints/a.bin").write_bytes(b"x" * 100)  # one file complete
    (tmp_path / "checkpoints/b.bin.part").write_bytes(b"x" * 40)  # one interrupted
    assert partial_bytes(entry, tmp_path) == 140


async def test_manager_delete_removes_files_and_partials(tmp_path):
    """Delete frees downloaded weights AND resume remnants; a live download
    must be cancelled first so its dying task can't resurrect the files."""
    import json

    from localcut_engine.config import EngineConfig
    from localcut_engine.events import EventBus
    from localcut_engine.manifest.manager import DownloadManager

    manifest = {
        "models": [
            {
                "id": "m1",
                "task": "image.gen",
                "family": "test",
                "requirements": {"vram_gb": 0, "disk_gb": 0},
                "license": {"id": "mit", "commercial": True},
                "files": [
                    {"url": "http://x/a", "dest": "checkpoints/a.bin", "size": 100},
                    {"url": "http://x/b", "dest": "checkpoints/b.bin", "size": 100},
                ],
            }
        ]
    }
    (tmp_path / "model-manifest.json").write_text(json.dumps(manifest))
    config = EngineConfig(data_dir=tmp_path)
    manager = DownloadManager(config, EventBus())
    models_dir = config.resolved_models_dir
    (models_dir / "checkpoints").mkdir(parents=True)
    (models_dir / "checkpoints/a.bin").write_bytes(b"x" * 100)
    (models_dir / "checkpoints/b.bin.part").write_bytes(b"x" * 40)

    with pytest.raises(KeyError):
        manager.delete("no-such-model")

    # A pending task blocks deletion.
    blocker = asyncio.get_running_loop().create_task(asyncio.sleep(60))
    manager._tasks["m1"] = blocker
    with pytest.raises(RuntimeError, match="cancel"):
        manager.delete("m1")
    blocker.cancel()
    manager._tasks.pop("m1")

    assert manager.delete("m1") == 140
    assert not (models_dir / "checkpoints/a.bin").exists()
    assert not (models_dir / "checkpoints/b.bin.part").exists()
    assert manager.delete("m1") == 0  # idempotent


async def test_manager_publishes_terminal_events(server, tmp_path):
    """The background manager mirrors download outcomes onto the event bus —
    the UI's progress bars have no other signal."""
    import json

    from localcut_engine.config import EngineConfig
    from localcut_engine.events import EventBus
    from localcut_engine.manifest.manager import DownloadManager

    good = hashlib.sha256(PAYLOAD).hexdigest()
    manifest = {
        "models": [
            {
                "id": "tiny",
                "task": "image.gen",
                "family": "test",
                "requirements": {"vram_gb": 0, "disk_gb": 0},
                "license": {"id": "mit", "commercial": True},
                "files": [
                    {
                        "url": f"{server}/weights.bin",
                        "dest": "checkpoints/weights.bin",
                        "sha256": good,
                        "size": len(PAYLOAD),
                    }
                ],
            },
            {
                "id": "broken",
                "task": "image.gen",
                "family": "test",
                "requirements": {"vram_gb": 0, "disk_gb": 0},
                "license": {"id": "mit", "commercial": True},
                "files": [{"url": f"{server}/missing.bin", "dest": "checkpoints/missing.bin"}],
            },
        ]
    }
    (tmp_path / "model-manifest.json").write_text(json.dumps(manifest))
    config = EngineConfig(data_dir=tmp_path)
    events = EventBus()
    queue = events.subscribe()
    manager = DownloadManager(config, events)

    assert await manager.start("tiny") == "started"
    assert await manager.start("broken") == "started"
    with pytest.raises(KeyError):
        await manager.start("no-such-model")
    await asyncio.gather(*manager._tasks.values(), return_exceptions=True)

    seen = []
    while not queue.empty():
        seen.append(queue.get_nowait())
    outcomes = {e.get("model"): e["type"] for e in seen if e["type"].endswith(("done", "failed"))}
    assert outcomes["tiny"] == "model.download.done"
    assert outcomes["broken"] == "model.download.failed"
    assert await manager.start("tiny") == "downloaded"
    assert not manager.cancel("tiny")  # nothing in flight
    # Terminal bookkeeping cleared before the events went out: nothing is
    # still reported as downloading.
    assert not any(row["downloading"] for row in manager.status())


async def test_traversal_dest_rejected_even_with_relative_models_dir(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "models").mkdir()
    with pytest.raises(DownloadError, match="escapes"):
        await download_file(
            ModelFile(url="http://127.0.0.1:1/x", dest="../escaped.bin"),
            pathlib.Path("models"),  # relative on purpose
        )
    with pytest.raises(DownloadError, match="escapes"):
        await download_file(
            ModelFile(url="http://127.0.0.1:1/x", dest="/etc/escaped.bin"),
            tmp_path / "models",
        )


def test_publishing_removes_the_partial_when_the_producer_fails(tmp_path):
    """ffmpeg and soundfile write the file themselves, so they get a temp
    path. A killed or failed encode must leave NO {hash}{suffix} behind:
    cached_hashes() reads the cache off bare filenames, so a truncated file
    is served as a finished render forever and never re-enqueued."""
    from localcut_engine.backends.base import ExecutionContext

    ctx = ExecutionContext(output_dir=tmp_path)
    with pytest.raises(RuntimeError):
        with ctx.publishing("deadbeef", ".mp4") as partial:
            partial.write_bytes(b"truncated moov-less mp4")
            # The temp must be invisible to the artifact scan while in flight.
            assert partial.name.startswith(".")
            assert partial.suffix == ".mp4", "muxers pick format by extension"
            raise RuntimeError("encoder died")

    assert not (tmp_path / "deadbeef.mp4").exists()
    assert list(tmp_path.iterdir()) == [], "a partial file was left behind"


def test_publishing_renames_into_place_on_success(tmp_path):
    from localcut_engine.backends.base import ExecutionContext

    ctx = ExecutionContext(output_dir=tmp_path)
    with ctx.publishing("cafe1234", ".wav") as partial:
        partial.write_bytes(b"RIFF....")
    out = tmp_path / "cafe1234.wav"
    assert out.read_bytes() == b"RIFF...."
    assert [p.name for p in tmp_path.iterdir()] == ["cafe1234.wav"]


def test_escaping_dest_is_never_reported_installed(tmp_path):
    """A user-supplied catalog can name any dest. The read-only probes must
    not answer from outside models_dir — that turns the models list into a
    file-existence/size oracle, and lets a bogus entry claim it is already
    installed so its real weights are never fetched."""
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (tmp_path / "secret.txt").write_bytes(b"x" * 64)

    def entry_for(dest: str, size: int) -> ModelEntry:
        return ModelEntry(
            id="evil",
            task="image.gen",
            family="test",
            requirements=Requirements(vram_gb=1, disk_gb=1),
            license=LicenseInfo(id="mit", commercial=True),
            files=[ModelFile(url="http://x/y", dest=dest, size=size)],
        )

    escaped = entry_for("../secret.txt", 64)
    assert is_downloaded(escaped, models_dir) is False
    assert partial_bytes(escaped, models_dir) == 0

    # A contained dest still reports normally.
    (models_dir / "real.bin").write_bytes(b"y" * 8)
    assert is_downloaded(entry_for("real.bin", 8), models_dir) is True


async def test_a_locked_weight_file_is_reported_not_traced(tmp_path, monkeypatch):
    """Windows refuses to unlink a file another process still has mapped — a
    ComfyUI holding the weights is the ordinary case. The OSError escaped as
    an unhandled 500 with a traceback and no hint at which file was stuck,
    and the bytes had already been counted as freed before the failed unlink.
    The route maps RuntimeError to a 409, so this is what makes the answer
    actionable."""
    import json

    from localcut_engine.config import EngineConfig
    from localcut_engine.events import EventBus
    from localcut_engine.manifest.manager import DownloadManager

    manifest = {
        "models": [
            {
                "id": "m1",
                "task": "image.gen",
                "family": "test",
                "requirements": {"vram_gb": 0, "disk_gb": 0},
                "license": {"id": "mit", "commercial": True},
                "files": [{"url": "http://x/a", "dest": "checkpoints/a.bin", "size": 100}],
            }
        ]
    }
    (tmp_path / "model-manifest.json").write_text(json.dumps(manifest))
    config = EngineConfig(data_dir=tmp_path)
    manager = DownloadManager(config, EventBus())
    weights = config.resolved_models_dir / "checkpoints" / "a.bin"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"x" * 100)

    def refuse(self, missing_ok=False):
        raise PermissionError(32, "The process cannot access the file")

    monkeypatch.setattr(pathlib.Path, "unlink", refuse)

    with pytest.raises(RuntimeError) as caught:
        manager.delete("m1")

    message = str(caught.value)
    assert "checkpoints/a.bin" in message, message  # says WHICH file is stuck
    assert "in use" in message
    # And nothing was reported freed: the file is still there.
    monkeypatch.undo()
    assert weights.exists()
    assert manager.delete("m1") == 100  # unlocked, it deletes and counts normally


# -- trouble that passes, and trouble that does not -------------------------


class _Flaky:
    """Serves PAYLOAD at /weights.bin over loopback, answering each request
    with the next entry of `script` and then normally: `("status", code,
    headers)` answers with that status and no file, `("drop", n)` sends
    the first n bytes of the body and closes the connection. A Range of
    `bytes=N-` gets a 206 with the rest. Records the Range of every
    request."""

    def __init__(self) -> None:
        self.script: list[tuple] = []
        self.ranges: list[str | None] = []
        outer = self

        class Handler(SimpleHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
                asked = self.headers.get("Range")
                outer.ranges.append(asked)
                answer = outer.script.pop(0) if outer.script else ("serve",)
                if answer[0] == "status":
                    self.send_response(answer[1])
                    for name, value in answer[2].items():
                        self.send_header(name, value)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if self.path != "/weights.bin":
                    self.send_error(404)
                    return
                start = int(asked.removeprefix("bytes=").split("-")[0]) if asked else 0
                if start:
                    self.send_response(206)
                    self.send_header(
                        "Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}"
                    )
                else:
                    self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(PAYLOAD) - start))
                self.end_headers()
                body = PAYLOAD[start:]
                if answer[0] == "drop":
                    self.wfile.write(body[: answer[1]])
                    self.wfile.flush()
                    self.close_connection = True
                    return
                self.wfile.write(body)

            def log_message(self, *args) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"


@pytest.fixture
def flaky(monkeypatch):
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    monkeypatch.setattr(downloads_module, "_RETRY_PAUSE_S", 0.0)
    server = _Flaky()
    yield server
    server.httpd.shutdown()
    server.httpd.server_close()


def _entry(url: str) -> ModelEntry:
    return ModelEntry(
        id="tiny",
        task="image.gen",
        family="test",
        requirements=Requirements(vram_gb=0, disk_gb=0),
        license=LicenseInfo(id="mit", commercial=True),
        files=[
            ModelFile(
                url=url,
                dest="checkpoints/weights.bin",
                sha256=hashlib.sha256(PAYLOAD).hexdigest(),
                size=len(PAYLOAD),
            )
        ],
    )


@pytest.mark.parametrize("status", [500, 502, 503, 504, 429])
async def test_a_model_download_waits_out_a_server_error_and_carries_on(flaky, tmp_path, status):
    """A weight host that is overloaded, restarting or rate-limiting answers
    with a status that says so, and none of them says the file is gone. A
    multi-GB download asks again rather than failing on the first one."""
    flaky.script = [("status", status, {}), ("status", status, {})]

    paths = await download_model(_entry(f"{flaky.url}/weights.bin"), tmp_path / "models")

    assert paths[0].read_bytes() == PAYLOAD
    assert len(flaky.ranges) == 3


async def test_a_model_download_that_drops_mid_body_picks_up_where_it_stopped(flaky, tmp_path):
    flaky.script = [("drop", 300_000), ("drop", 300_000)]

    paths = await download_model(_entry(f"{flaky.url}/weights.bin"), tmp_path / "models")

    assert paths[0].read_bytes() == PAYLOAD
    assert flaky.ranges[0] is None
    assert flaky.ranges[1] == "bytes=300000-"
    assert flaky.ranges[2] == "bytes=600000-"


async def test_a_model_url_that_is_gone_fails_at_once_and_says_so(flaky, tmp_path):
    """A 404 is not going to change by asking again: the URL in the catalog
    is out of date. One request, and a reason that says the file is gone
    rather than that the download failed."""
    with pytest.raises(DownloadError) as refused:
        await download_model(_entry(f"{flaky.url}/moved.bin"), tmp_path / "models")

    assert len(flaky.ranges) == 1
    assert "HTTP 404" in str(refused.value)
    assert "no longer at this address" in str(refused.value)


async def test_a_refusal_other_than_429_is_not_asked_again(flaky, tmp_path):
    flaky.script = [("status", 403, {})]

    with pytest.raises(DownloadError, match="HTTP 403"):
        await download_model(_entry(f"{flaky.url}/weights.bin"), tmp_path / "models")

    assert len(flaky.ranges) == 1


async def test_a_server_that_keeps_failing_gives_up_after_a_run_of_attempts(flaky, tmp_path):
    flaky.script = [("status", 503, {})] * 50

    with pytest.raises(DownloadError, match="HTTP 503"):
        await download_model(_entry(f"{flaky.url}/weights.bin"), tmp_path / "models")

    assert len(flaky.ranges) == 1 + downloads_module._RETRIES


async def test_retry_after_is_waited_for_up_to_a_cap(tmp_path, monkeypatch):
    """A 429 or 503 that says when to come back is taken at its word, in
    seconds or as a date, but never for longer than a minute: a server
    asking for an hour would hold a setup that long with nothing on screen."""
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    soon = email.utils.format_datetime(datetime.now(UTC) + timedelta(seconds=3), usegmt=True)
    answers = [
        httpx.Response(503, headers={"Retry-After": "7"}),
        httpx.Response(429, headers={"Retry-After": "86400"}),
        httpx.Response(503, headers={"Retry-After": soon}),
        httpx.Response(200, content=PAYLOAD),
    ]
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: answers.pop(0)))
    waits: list[float] = []
    sleep = asyncio.sleep

    async def record(delay: float, *args, **kwargs):
        if delay:
            waits.append(delay)
        await sleep(0)

    monkeypatch.setattr(asyncio, "sleep", record)

    await download_file_retrying(
        model_file("https://cdn.example.com/w.bin", hashlib.sha256(PAYLOAD).hexdigest()),
        tmp_path / "models",
        client=client,
    )
    await client.aclose()

    assert waits[:2] == [7.0, downloads_module._RETRY_AFTER_CAP_S]
    assert 1.0 < waits[2] <= 3.0


async def test_a_model_download_can_be_cancelled_while_it_waits(flaky, tmp_path, caplog):
    import json

    from localcut_engine.config import EngineConfig
    from localcut_engine.events import EventBus
    from localcut_engine.manifest.manager import DownloadManager

    flaky.script = [("status", 503, {"Retry-After": "60"})]
    entry = _entry(f"{flaky.url}/weights.bin").model_dump(mode="json")
    (tmp_path / "model-manifest.json").write_text(json.dumps({"models": [entry]}))
    events = EventBus()
    queue = events.subscribe()
    manager = DownloadManager(EngineConfig(data_dir=tmp_path), events)

    with caplog.at_level("WARNING"):
        assert await manager.start("tiny") == "started"
        async with asyncio.timeout(10):
            while "trying again" not in caplog.text:
                await asyncio.sleep(0.02)
        assert manager.cancel("tiny")
        async with asyncio.timeout(5):
            await asyncio.gather(*manager._tasks.values(), return_exceptions=True)

    seen = []
    while not queue.empty():
        seen.append(queue.get_nowait()["type"])
    assert "model.download.cancelled" in seen
    assert len(flaky.ranges) == 1


async def test_a_host_that_did_not_resolve_is_asked_again(tmp_path, monkeypatch):
    """The guard looks the host up before anything is fetched, so a lookup
    that fails during a network blip never reaches httpx as the connection
    error it is. It is asked again like one."""
    looked_up: list[str] = []

    def guard(url: str) -> None:
        looked_up.append(url)
        if len(looked_up) == 1:
            raise downloads_module.UnresolvedHost(
                "could not resolve cdn.example.com: [Errno -3] Temporary failure in name resolution"
            )

    monkeypatch.setattr(downloads_module, "assert_public_url", guard)
    monkeypatch.setattr(downloads_module, "_RETRY_PAUSE_S", 0.0)
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=PAYLOAD))
    )

    path = await download_file_retrying(
        model_file("https://cdn.example.com/w.bin", hashlib.sha256(PAYLOAD).hexdigest()),
        tmp_path / "models",
        client=client,
    )
    await client.aclose()

    assert path.read_bytes() == PAYLOAD
    assert len(looked_up) == 2


async def test_a_url_the_guard_refuses_is_not_asked_again(tmp_path, monkeypatch):
    looked_up: list[str] = []

    def guard(url: str) -> None:
        looked_up.append(url)
        raise UnsafeURL("refusing to fetch cdn.example.com: it resolves to 10.0.0.5")

    monkeypatch.setattr(downloads_module, "assert_public_url", guard)

    with pytest.raises(UnsafeURL):
        await download_file_retrying(model_file("https://cdn.example.com/w.bin"), tmp_path)

    assert len(looked_up) == 1
