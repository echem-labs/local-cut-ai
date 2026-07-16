"""Download manager: fresh, resumed, and checksum-failing downloads against
a local HTTP server (python's RangeRequestHandler-capable SimpleHTTP)."""

import hashlib
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest

from localcut_engine.manifest.downloads import (
    ChecksumMismatch,
    DownloadError,
    download_file,
    is_downloaded,
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
def server(tmp_path):
    (tmp_path / "weights.bin").write_bytes(PAYLOAD)
    httpd = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(RangeHandler, directory=str(tmp_path))
    )
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


async def test_http_error_raises(server, tmp_path):
    with pytest.raises(DownloadError, match="404"):
        await download_file(model_file(f"{server}/missing.bin"), tmp_path / "models")


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
