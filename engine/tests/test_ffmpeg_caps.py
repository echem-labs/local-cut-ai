"""FFmpeg capability probing, with the drawing stubbed out so no real ffmpeg
is required. Text is probed by drawing it: a title through drawtext and a
caption through libass, both with the bundled font. A static FFmpeg 7+ build
without libharfbuzz has no drawtext, and a machine without fonts draws nothing
with either filter, so titles must fail loudly at probe/use, not mid-export
with "No such filter" or as captions that burn in blank."""

import json
from pathlib import PureWindowsPath

import pytest
from conftest import make_spec

from localcut_engine import fonts
from localcut_engine.backends.base import ExecutionContext, GenerationError
from localcut_engine.backends.ffmpeg import FFmpegBackend, _filter_path
from localcut_engine.graph.model import NodeKind


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


class _SceneRendered(Exception):
    """Raised where an export starts rendering its first scene."""


async def _export(backend: FFmpegBackend, tmp_path, monkeypatch, captions: str) -> None:
    """Run a one-scene export with burned or sidecar `captions` up to the
    first scene render, which raises _SceneRendered."""
    clip = tmp_path / "s1.mp4"
    clip.write_bytes(b"")
    timeline = tmp_path / "cut.timeline.json"
    segment = {"scene": "s1", "srcs": [clip.name], "duration": 1.0}
    timeline.write_text(json.dumps({"aspect": "9:16", "video": [segment], "duration": 1.0}))
    srt = tmp_path / "captions.srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:01,000\nhello captions\n", encoding="utf-8")

    async def encoder() -> str:
        return "mpeg4"

    async def render(*args, **kwargs) -> None:
        raise _SceneRendered

    monkeypatch.setattr(backend, "_pick_encoder", encoder)
    monkeypatch.setattr(backend, "_render_segment", render)
    await backend.execute(
        make_spec(NodeKind.EXPORT, {"captions": captions}),
        ExecutionContext(
            output_dir=tmp_path, input_artifacts={"default": timeline, "captions": srt}
        ),
    )


async def test_an_export_that_burns_captions_it_cannot_draw_is_refused_first(tmp_path, monkeypatch):
    """Without libass the export dies in its last encode on "No such filter:
    'ass'", and with a libass that draws nothing it ships blank captions as a
    success. Either way every scene has rendered first. The refusal comes
    before the first one, and names a setting that gets the export out."""
    backend = _drawing(monkeypatch, titles=900, captions=0)
    with pytest.raises(GenerationError) as refused:
        await _export(backend, tmp_path, monkeypatch, "burn")
    assert "LOCALCUT_FFMPEG_BIN" in str(refused.value)
    assert '"Separate file (.srt)"' in str(refused.value)


async def test_captions_that_are_not_burned_are_not_refused(tmp_path, monkeypatch):
    """A sidecar is a file beside the video, which this build writes fine."""
    backend = _drawing(monkeypatch, titles=900, captions=0)
    with pytest.raises(_SceneRendered):
        await _export(backend, tmp_path, monkeypatch, "sidecar")


async def test_captions_this_build_draws_are_burned(tmp_path, monkeypatch):
    backend = _drawing(monkeypatch, titles=0, captions=700)
    with pytest.raises(_SceneRendered):
        await _export(backend, tmp_path, monkeypatch, "burn")


async def test_an_unknown_probe_does_not_refuse_captions(tmp_path, monkeypatch):
    """None is an ffmpeg that could not be run, which fails louder on its own."""
    backend = _drawing(monkeypatch, titles=None, captions=None)
    with pytest.raises(_SceneRendered):
        await _export(backend, tmp_path, monkeypatch, "burn")


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
    assert f"fontfile={_filter_path(fonts.DIR / fonts.REGULAR)}:" in title
    assert ":font=" not in title, "a family name is a fontconfig lookup"
    assert captions.endswith(f":fontsdir={_filter_path(fonts.DIR)}")


def test_a_windows_profile_path_is_escaped_for_both_parsers():
    """On Windows the fonts sit in the install directory and the work files
    in the temp directory, both inside the user's profile folder. ffmpeg
    unescapes an option value twice, in the graph parser and again in the
    filter's option parser, so the drive colon and an apostrophe in the
    profile name carry one escape for each."""
    profile = PureWindowsPath(r"C:\Users\O'Brien\AppData\Local")
    escaped = r"C\\:/Users/O\\\'Brien/AppData/Local"
    backend = FFmpegBackend(ffmpeg_bin="ffmpeg")
    backend.fonts_dir = profile / "Programs" / "LocalCut AI" / "fonts"
    title = backend._title_filter(profile / "Temp" / "seg000.txt", 1920)
    assert f":textfile={escaped}/Temp/seg000.txt:" in title
    assert f":fontfile={escaped}/Programs/LocalCut AI/fonts/Inter-Regular.ttf:" in title
    captions = backend._captions_filter(profile / "Temp" / "captions.ass")
    assert captions == (
        f"ass=filename={escaped}/Temp/captions.ass:fontsdir={escaped}/Programs/LocalCut AI/fonts"
    )


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
