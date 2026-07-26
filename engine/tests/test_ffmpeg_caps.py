"""FFmpeg capability probing — no real ffmpeg required. FFmpeg 7 moved
drawtext behind libharfbuzz and popular static builds omit it, so titles
must fail loudly at probe/use, not mid-export with "No such filter"."""

import pytest

from localcut_engine.backends.base import GenerationError
from localcut_engine.backends.ffmpeg import FFmpegBackend

# Trimmed real `ffmpeg -filters` table shapes.
_FILTERS_WITH_DRAWTEXT = """\
Filters:
  T.. = Timeline support
 ... crop              V->V       Crop the input video.
 T.C drawtext          V->V       Draw text on top of video frames using libfreetype library.
 ... scale             V->V       Scale the input video size and/or convert the image format.
"""
_FILTERS_WITHOUT_DRAWTEXT = """\
Filters:
  T.. = Timeline support
 ... crop              V->V       Crop the input video.
 ... scale             V->V       Scale the input video size and/or convert the image format.
"""


def _stubbed(monkeypatch, filters_output: str) -> FFmpegBackend:
    backend = FFmpegBackend(ffmpeg_bin="ffmpeg")

    async def fake_probe() -> str:
        return filters_output

    monkeypatch.setattr(backend, "_probe_filters", fake_probe)
    return backend


async def test_drawtext_detected_from_filters_table(monkeypatch):
    backend = _stubbed(monkeypatch, _FILTERS_WITH_DRAWTEXT)
    assert await backend.supports_drawtext() is True


async def test_drawtext_missing_from_filters_table(monkeypatch):
    backend = _stubbed(monkeypatch, _FILTERS_WITHOUT_DRAWTEXT)
    assert await backend.supports_drawtext() is False
    # The name appearing only in prose (another filter's description) must
    # not count — the check reads the name column, not the whole line.
    prose = _FILTERS_WITHOUT_DRAWTEXT + " ... subtitles V->V Render like drawtext does.\n"
    other = _stubbed(monkeypatch, prose)
    assert await other.supports_drawtext() is False


async def test_missing_binary_probes_as_unknown(tmp_path):
    backend = FFmpegBackend(ffmpeg_bin=str(tmp_path / "no-such-ffmpeg"))
    assert await backend.supports_drawtext() is None
    # Unknown must NOT hard-fail the titles guard: the render's own
    # "ffmpeg binary not found" error is the clearer failure.
    await backend._require_drawtext()


async def test_titles_guard_raises_clear_error(monkeypatch):
    backend = _stubbed(monkeypatch, _FILTERS_WITHOUT_DRAWTEXT)
    with pytest.raises(GenerationError, match="drawtext"):
        await backend._require_drawtext()


async def test_probe_is_cached(monkeypatch):
    backend = FFmpegBackend(ffmpeg_bin="ffmpeg")
    calls = 0

    async def fake_probe() -> str:
        nonlocal calls
        calls += 1
        return _FILTERS_WITH_DRAWTEXT

    monkeypatch.setattr(backend, "_probe_filters", fake_probe)
    await backend.supports_drawtext()
    await backend.supports_drawtext()
    assert calls == 1


def test_ffprobe_keeps_the_executable_extension():
    """ffmpeg ships as ffmpeg.exe on Windows. Deriving the probe's path by
    name alone looks for an extensionless sibling that isn't there — and
    supports() gates on ffmpeg only, so the backend claims the work and then
    dies at the first probe, after every clip has already been generated."""
    from localcut_engine.backends.ffmpeg import FFmpegBackend

    # Path is platform-native, so separators differ by host — compare against
    # a Path-derived string rather than a hardcoded POSIX one. What matters
    # is that the sibling keeps the executable suffix.
    from pathlib import Path

    assert FFmpegBackend("/opt/ffmpeg/bin/ffmpeg.exe").ffprobe_bin.endswith("ffprobe.exe")
    assert FFmpegBackend("/opt/ffmpeg/bin/ffmpeg").ffprobe_bin == str(
        Path("/opt/ffmpeg/bin/ffprobe")
    )
    assert FFmpegBackend("ffmpeg").ffprobe_bin == "ffprobe"  # bare name: resolve on PATH
