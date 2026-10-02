"""FFmpeg capability probing, with the drawing stubbed out so no real ffmpeg
is required. Text is probed by drawing it: a title through drawtext and a
caption through libass, both with the bundled font. A static FFmpeg 7+ build
without libharfbuzz has no drawtext, and a machine without fonts draws nothing
with either filter, so titles must fail loudly at probe/use, not mid-export
with "No such filter" or as captions that burn in blank."""

from pathlib import PureWindowsPath

import pytest

from localcut_engine import fonts
from localcut_engine.backends.base import GenerationError
from localcut_engine.backends.ffmpeg import FFmpegBackend, _filter_path


def _drawing(monkeypatch, *, titles: int | None, captions: int | None) -> FFmpegBackend:
    """A backend whose probe frames light this many pixels: `titles` for the
    drawtext frame, `captions` for the libass one. None = the binary could
    not be run."""
    backend = FFmpegBackend(ffmpeg_bin="ffmpeg")

    async def fake_lit(vf: str) -> int | None:
        return titles if vf.startswith("drawtext=") else captions

    monkeypatch.setattr(backend, "_lit_pixels", fake_lit)
    return backend


async def test_text_draws_when_titles_and_captions_both_light_pixels(monkeypatch):
    assert await _drawing(monkeypatch, titles=900, captions=700).supports_drawtext() is True


async def test_a_filter_that_draws_nothing_does_not_count(monkeypatch):
    """Both filters exist on a machine without fonts. What it lacks only
    shows up as a frame with nothing on it, and either half missing is a
    video that will not carry its text."""
    assert await _drawing(monkeypatch, titles=0, captions=700).supports_drawtext() is False
    assert await _drawing(monkeypatch, titles=900, captions=0).supports_drawtext() is False


async def test_missing_binary_probes_as_unknown(tmp_path):
    backend = FFmpegBackend(ffmpeg_bin=str(tmp_path / "no-such-ffmpeg"))
    assert await backend.supports_drawtext() is None
    # Unknown must NOT hard-fail the titles guard: the render's own
    # "ffmpeg binary not found" error is the clearer failure.
    await backend._require_drawtext()


async def test_titles_guard_raises_clear_error(monkeypatch):
    backend = _drawing(monkeypatch, titles=0, captions=700)
    with pytest.raises(GenerationError, match="drawtext"):
        await backend._require_drawtext()


async def test_titles_are_not_refused_because_captions_cannot_draw(monkeypatch):
    """The guard stands in front of drawtext alone. A build that draws titles
    but cannot burn captions can still export a titled cut whose captions go
    out as a sidecar, and refusing the titles would fail that export."""
    await _drawing(monkeypatch, titles=900, captions=0)._require_drawtext()


async def test_probe_is_cached(monkeypatch):
    backend = FFmpegBackend(ffmpeg_bin="ffmpeg")
    drawn: list[str] = []

    async def fake_lit(vf: str) -> int:
        drawn.append(vf)
        return 500

    monkeypatch.setattr(backend, "_lit_pixels", fake_lit)
    await backend.supports_drawtext()
    await backend.supports_drawtext()
    await backend._require_drawtext()
    assert len(drawn) == 2, "one title and one caption, drawn once"


async def test_the_probe_draws_with_the_faces_the_engine_ships(monkeypatch):
    """A probe that let ffmpeg pick a font would answer for the machine it
    ran on, which is the question this fix stops depending on."""
    backend = FFmpegBackend(ffmpeg_bin="ffmpeg")
    drawn: list[str] = []

    async def fake_lit(vf: str) -> int:
        drawn.append(vf)
        return 500

    monkeypatch.setattr(backend, "_lit_pixels", fake_lit)
    await backend.supports_drawtext()
    title, captions = drawn
    assert f"fontfile='{_filter_path(fonts.DIR / fonts.REGULAR)}'" in title
    assert ":font=" not in title, "a family name is a fontconfig lookup"
    assert f"fontsdir='{_filter_path(fonts.DIR)}'" in captions


def test_font_paths_keep_a_windows_drive_letter_out_of_the_option_syntax():
    """Inside a filtergraph a backslash is an escape and a colon separates
    options, so `C:\\...` has to reach ffmpeg as `C\\:/...`. The font paths
    point into the install directory, which on Windows always has one."""
    backend = FFmpegBackend(ffmpeg_bin="ffmpeg")
    backend.fonts_dir = PureWindowsPath(r"C:\Program Files\LocalCut AI\fonts")
    title = backend._title_filter(PureWindowsPath(r"C:\Temp\seg000.txt"), 1920)
    assert r"fontfile='C\:/Program Files/LocalCut AI/fonts/Inter-Regular.ttf'" in title
    captions = backend._captions_filter(PureWindowsPath(r"C:\Temp\captions.ass"))
    assert r"fontsdir='C\:/Program Files/LocalCut AI/fonts'" in captions


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
