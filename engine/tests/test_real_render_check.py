"""scripts/real-render-check.py, the parts that decide its verdicts.

The check itself needs an NVIDIA card, real models and an engine to drive,
so it runs by hand (docs/running-real-models.md). What it concludes comes
from a handful of pure functions: what the workflow templates need from
ComfyUI's /object_info, what FFmpeg's freezedetect, volumedetect and psnr
filters printed, what ffprobe says about the export, which backend each
stage ran on and how all of that adds up to a verdict and an exit status.
These hold those functions to what they claim, from fixtures. The FFmpeg
output below is what FFmpeg 9.0.2 printed for real clips and real music.
"""

from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "real-render-check.py"


def _load():
    spec = importlib.util.spec_from_file_location("real_render_check", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rrc = _load()


# -- /object_info --------------------------------------------------------------------

_TEMPLATES = {
    "keyframe.json": {
        "checkpoint": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "x"}},
        "sampler": {
            "class_type": "KSampler",
            "inputs": {"seed": 1, "steps": 20, "model": ["checkpoint", 0]},
        },
    },
    "music.json": {
        "sampler": {"class_type": "KSampler", "inputs": {"denoise": 1.0}},
        "save": {"class_type": "SaveAudio", "inputs": {"audio": ["sampler", 0]}},
    },
}


def _object_info(**classes: tuple[list[str], list[str]]) -> dict:
    return {
        name: {
            "input": {
                "required": {key: [["a"]] for key in required},
                "optional": {key: ["INT", {}] for key in optional},
            }
        }
        for name, (required, optional) in classes.items()
    }


def test_the_templates_need_each_class_with_every_input_any_of_them_sends():
    assert rrc.template_requirements(_TEMPLATES) == {
        "CheckpointLoaderSimple": {"ckpt_name"},
        "KSampler": {"seed", "steps", "model", "denoise"},
        "SaveAudio": {"audio"},
    }


def test_object_info_names_a_class_it_lacks_and_an_input_a_class_does_not_declare():
    info = _object_info(
        CheckpointLoaderSimple=(["ckpt_name"], []),
        KSampler=(["seed", "steps", "model"], []),
    )
    gaps = rrc.object_info_gaps(rrc.template_requirements(_TEMPLATES), info)
    assert gaps == ["KSampler has no input denoise", "no node class SaveAudio"]
    verdict = rrc.object_info_check(rrc.template_requirements(_TEMPLATES), info)
    assert not verdict["passed"]
    assert "no node class SaveAudio" in verdict["detail"]


def test_an_optional_input_counts_as_declared():
    info = _object_info(
        CheckpointLoaderSimple=(["ckpt_name"], []),
        KSampler=(["seed", "steps", "model"], ["denoise"]),
        SaveAudio=(["audio"], []),
    )
    verdict = rrc.object_info_check(rrc.template_requirements(_TEMPLATES), info)
    assert verdict["passed"], verdict
    assert verdict["measured"] == {"classes": 3, "inputs": 6}


def test_every_packaged_template_reads_as_node_classes_and_inputs():
    """The check reads the templates the engine ships. One it could not
    read would make the coverage check crash or pass over its nodes."""
    templates = rrc.load_templates()
    shipped = sorted(path.name for path in rrc.TEMPLATES.glob("*.json"))
    assert sorted(templates) == shipped and shipped
    needed = rrc.template_requirements(templates)
    for workflow in templates.values():
        for node in workflow.values():
            assert set(node.get("inputs") or {}) <= needed[node["class_type"]]


# -- freezedetect, psnr and motion -------------------------------------------------

_STILL_TO_THE_END = """\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'static.mp4':
  Duration: 00:00:04.00, start: 0.000000, bitrate: 18 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (mpeg4 (native) -> wrapped_avframe (native))
[Parsed_freezedetect_0 @ 0x7cc4d4002d80] lavfi.freezedetect.freeze_start: 0
[out#0/null @ 0x623074878340] video:42KiB audio:0KiB subtitle:0KiB other streams:0KiB
"""

_STILL_AT_THE_START = """\
[Parsed_freezedetect_0 @ 0x798948002d80] lavfi.freezedetect.freeze_start: 0
[Parsed_freezedetect_0 @ 0x798948002d80] lavfi.freezedetect.freeze_duration: 1.5
[Parsed_freezedetect_0 @ 0x798948002d80] lavfi.freezedetect.freeze_end: 1.5
"""

_MOVING = """\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Duration: 00:00:08.04, start: 0.000000, bitrate: 1032 kb/s
[out#0/null @ 0x623074878340] video:103KiB audio:0KiB subtitle:0KiB other streams:0KiB
"""

_PSNR_MOVING = (
    "[Parsed_psnr_0 @ 0x745268001d40] PSNR r:9.440702 g:9.838599 b:10.596084 "
    "average:9.932409 min:9.932409 max:9.932409\n"
)
_PSNR_SAME = "[Parsed_psnr_0 @ 0x7d8a14001e80] PSNR r:inf g:inf b:inf average:inf min:inf max:inf\n"


def test_a_freeze_still_running_when_the_clip_ends_lasts_to_the_end():
    assert rrc.parse_freezes(_STILL_TO_THE_END, 4.0) == [(0.0, 4.0)]


def test_a_freeze_that_ends_is_read_from_its_start_and_end():
    assert rrc.parse_freezes(_STILL_AT_THE_START, 3.5) == [(0.0, 1.5)]
    assert rrc.parse_freezes(_MOVING, 8.04) == []


def test_psnr_reads_the_average_and_infinity():
    assert rrc.parse_psnr(_PSNR_MOVING) == pytest.approx(9.932409)
    assert rrc.parse_psnr(_PSNR_SAME) == float("inf")
    assert rrc.parse_psnr(_MOVING) is None


def test_a_clip_that_walks_across_the_frame_moves():
    verdict = rrc.motion_check(
        "s1.clip",
        duration_s=8.04,
        frames="193",
        freezes=rrc.parse_freezes(_MOVING, 8.04),
        psnr_db=rrc.parse_psnr(_PSNR_MOVING),
    )
    assert verdict["passed"], verdict
    assert verdict["name"] == "motion s1.clip"


def test_a_clip_of_identical_frames_does_not_move():
    verdict = rrc.motion_check(
        "s1.clip",
        duration_s=4.0,
        frames="96",
        freezes=rrc.parse_freezes(_STILL_TO_THE_END, 4.0),
        psnr_db=rrc.parse_psnr(_PSNR_SAME),
    )
    assert not verdict["passed"]
    assert "still for 4.0 s" in verdict["detail"]
    # JSON has no infinity: the report records it as text.
    assert verdict["measured"]["first_last_psnr_db"] == "inf"
    json.dumps(verdict, allow_nan=False)


def test_a_clip_that_ends_where_it_started_does_not_move_even_with_no_still_second():
    verdict = rrc.motion_check(
        "s2.clip",
        duration_s=8.04,
        frames="193",
        freezes=[],
        psnr_db=rrc.MAX_FIRST_LAST_PSNR_DB + 1,
    )
    assert not verdict["passed"]
    assert "dB PSNR from its first" in verdict["detail"]


def test_a_still_second_fails_a_clip_whose_ends_differ():
    verdict = rrc.motion_check(
        "s1.clip",
        duration_s=3.5,
        frames="84",
        freezes=rrc.parse_freezes(_STILL_AT_THE_START, 3.5),
        psnr_db=rrc.parse_psnr(_PSNR_MOVING),
    )
    assert not verdict["passed"]


# -- volumedetect ------------------------------------------------------------------

# FFmpeg 9 configures the graph twice and prints an empty report first.
_MUSIC = """\
[Parsed_volumedetect_0 @ 0x6042c9d80180] n_samples: 0
[Parsed_volumedetect_0 @ 0x7aa15c002cc0] n_samples: 1409024
[Parsed_volumedetect_0 @ 0x7aa15c002cc0] mean_volume: -33.5 dB
[Parsed_volumedetect_0 @ 0x7aa15c002cc0] max_volume: -15.9 dB
[Parsed_volumedetect_0 @ 0x7aa15c002cc0] histogram_15db: 8
[Parsed_volumedetect_0 @ 0x7aa15c002cc0] histogram_16db: 58
"""

_SILENCE = """\
[Parsed_volumedetect_0 @ 0x56cbd93f5380] n_samples: 0
[Parsed_volumedetect_0 @ 0x71a250002cc0] n_samples: 194560
[Parsed_volumedetect_0 @ 0x71a250002cc0] mean_volume: -91.0 dB
[Parsed_volumedetect_0 @ 0x71a250002cc0] max_volume: -91.0 dB
[Parsed_volumedetect_0 @ 0x71a250002cc0] histogram_91db: 194560
"""

_MIX = """\
[Parsed_volumedetect_0 @ 0x5eac6a8a1e80] n_samples: 0
[Parsed_volumedetect_0 @ 0x759754002cc0] n_samples: 992096
[Parsed_volumedetect_0 @ 0x759754002cc0] mean_volume: -24.0 dB
[Parsed_volumedetect_0 @ 0x759754002cc0] max_volume: -5.8 dB
[Parsed_volumedetect_0 @ 0x759754002cc0] histogram_5db: 1
"""

_NOTHING_MEASURED = "[Parsed_volumedetect_0 @ 0x56cbd93f5380] n_samples: 0\n"


def test_volumedetect_is_read_from_the_report_that_saw_the_audio():
    assert rrc.parse_volume(_MUSIC) == {"mean_db": -33.5, "peak_db": -15.9, "samples": 1409024}
    assert rrc.parse_volume(_NOTHING_MEASURED) is None
    assert rrc.parse_volume("") is None


def test_a_quiet_bed_is_music_and_silence_is_not():
    def music(stderr: str) -> dict:
        return rrc.loudness_check(
            "music",
            rrc.parse_volume(stderr),
            min_mean_db=rrc.MUSIC_MIN_MEAN_DB,
            min_peak_db=rrc.MUSIC_MIN_PEAK_DB,
        )

    assert music(_MUSIC)["passed"]
    silent = music(_SILENCE)
    assert not silent["passed"]
    assert "mean -91.0 dB" in silent["detail"]
    assert not music(_NOTHING_MEASURED)["passed"]


def test_a_mix_with_the_voice_in_it_has_sound_and_a_silent_one_does_not():
    def mix(stderr: str) -> dict:
        return rrc.loudness_check(
            "mix",
            rrc.parse_volume(stderr),
            min_mean_db=rrc.MIX_MIN_MEAN_DB,
            min_peak_db=rrc.MIX_MIN_PEAK_DB,
        )

    assert mix(_MIX)["passed"]
    assert not mix(_SILENCE)["passed"]


# -- the export's streams ----------------------------------------------------------


def _probe(**changes: dict) -> dict:
    """What ffprobe said about a real 9:16 export, with `changes` merged
    into the video, audio or format part."""
    probe = {
        "streams": [
            {
                "index": 0,
                "codec_name": "h264",
                "codec_type": "video",
                "width": 1080,
                "height": 1920,
                "avg_frame_rate": "24/1",
                "duration": "10.333333",
                "nb_frames": "248",
            },
            {
                "index": 1,
                "codec_name": "aac",
                "codec_type": "audio",
                "avg_frame_rate": "0/0",
                "sample_rate": "48000",
                "channels": 2,
                "duration": "10.334333",
                "nb_frames": "486",
            },
        ],
        "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "10.334333"},
    }
    probe["streams"][0].update(changes.get("video", {}))
    probe["streams"][1].update(changes.get("audio", {}))
    probe["format"].update(changes.get("format", {}))
    return probe


def _streams(probe: dict, target_s: float = 16) -> dict:
    return rrc.streams_check(probe, target_s=target_s, size=(1080, 1920))


def test_a_real_export_has_the_streams_the_export_promises():
    verdict = _streams(_probe())
    assert verdict["passed"], verdict
    assert verdict["detail"] == "H.264 1080x1920 at 24 fps, AAC 48 kHz stereo, 10.33 s"


@pytest.mark.parametrize(
    ("changes", "complaint"),
    [
        ({"video": {"codec_name": "hevc"}}, "video is hevc, not h264"),
        ({"video": {"width": 1920, "height": 1080}}, "video is 1920x1080, not 1080x1920"),
        ({"audio": {"codec_name": "mp3"}}, "audio is mp3, not aac"),
        ({"audio": {"sample_rate": "24000"}}, "audio is 24000 Hz, not 48000"),
        ({"audio": {"channels": 1}}, "audio has 1 channels, not 2"),
        ({"audio": {"duration": "6.000000"}}, "the audio track is 6.00 s of 10.33 s"),
        ({"format": {"duration": "2.000000"}}, "shorter than"),
    ],
)
def test_streams_that_break_a_promise_fail(changes, complaint):
    verdict = _streams(_probe(**changes))
    assert not verdict["passed"]
    assert complaint in verdict["detail"]


def test_an_export_far_longer_than_asked_fails():
    assert not _streams(_probe(), target_s=6)["passed"]


def test_an_export_with_no_audio_track_fails():
    probe = _probe()
    probe["streams"].pop()
    verdict = _streams(probe)
    assert not verdict["passed"]
    assert "0 audio tracks, not 1" in verdict["detail"]


# -- stages and backends -------------------------------------------------------------


def _job(node: str, kind: str, backend: str | None, started: float, seconds: float, **more):
    return {
        "id": f"{node}-{started}",
        "spec": {"node_id": node, "kind": kind, "output_hash": "ab" * 32},
        "status": more.pop("status", "done"),
        "backend": backend,
        "model": None,
        "attempt": 0,
        "error": None,
        "created_at": 100.0,
        "started_at": started,
        "finished_at": started + seconds,
        **more,
    }


_JOBS = [
    _job("export", "export", "ffmpeg", 160.0, 5.2),
    _job("script", "script", "mock", 100.5, 0.0),
    _job("music", "music", "comfyui", 101.0, 11.6),
    _job("s1.keyframe", "keyframe", "comfyui", 113.0, 21.8),
    _job("s1.clip", "clip", "comfyui", 135.0, 20.0),
    _job("s1.narration", "narration", "kokoro", 102.0, 4.0),
    _job("captions", "captions", "align", 156.0, 1.7),
    _job("timeline", "timeline", "ffmpeg", 158.0, 0.5),
]
_EXPECTED = {"script": "mock", **rrc.EXPECTED_BACKENDS}


def test_stages_are_listed_in_the_order_they_started_with_their_times():
    rows = rrc.stage_rows(_JOBS)
    assert [row["node"] for row in rows] == [
        "script",
        "music",
        "s1.narration",
        "s1.keyframe",
        "s1.clip",
        "captions",
        "timeline",
        "export",
    ]
    assert rows[1] == {
        "node": "music",
        "kind": "music",
        "status": "done",
        "backend": "comfyui",
        "model": None,
        "attempt": 0,
        "error": None,
        "seconds": 11.6,
        "created_at": 100.0,
        "started_at": 101.0,
        "finished_at": 112.6,
    }


def test_every_stage_on_its_real_backend_passes():
    assert rrc.backends_check(rrc.stage_rows(_JOBS), _EXPECTED)["passed"]


def test_a_clip_from_the_still_clip_tier_fails_though_its_mp4_plays():
    jobs = [job for job in _JOBS if job["spec"]["kind"] != "clip"]
    jobs.append(_job("s1.clip", "clip", "ffmpeg", 135.0, 0.8))
    verdict = rrc.backends_check(rrc.stage_rows(jobs), _EXPECTED)
    assert not verdict["passed"]
    assert verdict["detail"] == "s1.clip on ffmpeg instead of comfyui"


def test_a_stage_that_never_rendered_fails():
    jobs = [job for job in _JOBS if job["spec"]["kind"] != "music"]
    jobs.append(_job("music", "music", None, 101.0, 0.0, status="cancelled"))
    verdict = rrc.backends_check(rrc.stage_rows(jobs), _EXPECTED)
    assert verdict["detail"] == "no music rendered"


def test_the_newest_finished_job_of_a_node_is_the_one_checked():
    older = _job("s1.clip", "clip", "comfyui", 50.0, 10.0, id="old")
    newer = _job("s1.clip", "clip", "comfyui", 135.0, 20.0, id="new")
    failed = _job("s2.clip", "clip", "comfyui", 140.0, 1.0, status="failed")
    picked = rrc.finished_by_node([newer, failed, older, *_JOBS[:3]], "clip")
    assert [job["id"] for job in picked] == ["new"]


# -- what to set up and download ---------------------------------------------------


def _program(program_id: str, managed: dict | None, checks: dict | None = None) -> dict:
    return {"id": program_id, "managed": managed, "checks": checks or {}}


def test_a_program_needs_a_setup_unless_its_copy_is_the_pinned_build():
    assert rrc.program_ready(_program("comfyui", {"current": True, "version": "0.42.1"}))
    assert not rrc.program_ready(_program("comfyui", {"current": False, "version": "0.40.0"}))
    assert not rrc.program_ready(_program("ffmpeg", None))


def test_ollama_also_needs_the_script_model():
    current = {"current": True, "version": "0.40.6"}
    assert rrc.program_ready(_program("ollama", current, {"model_present": True}))
    assert not rrc.program_ready(_program("ollama", current, {"model_present": False}))
    assert not rrc.program_ready(_program("ollama", current, {"model_present": None}))


def test_only_recommended_models_with_files_that_are_not_on_disk_download():
    recommendations = [
        {"task": "text.llm", "model": {"id": "qwen3-8b-q4"}},
        {"task": "image.gen", "model": {"id": "sdxl-base-1.0"}},
        {"task": "video.i2v", "model": {"id": "ltx-video-0.9-i2v"}},
        {"task": "transcribe", "model": None},
    ]
    models = [
        {"id": "qwen3-8b-q4", "size_bytes": 0, "downloaded": False},
        {"id": "sdxl-base-1.0", "size_bytes": 6938078334, "downloaded": True},
        {"id": "ltx-video-0.9-i2v", "size_bytes": 11498078188, "downloaded": False},
        {"id": "wan2.2-i2v-14b-fp8", "size_bytes": 35579207879, "downloaded": False},
    ]
    assert [row["id"] for row in rrc.models_to_download(recommendations, models)] == [
        "ltx-video-0.9-i2v"
    ]
    assert [row["id"] for row in rrc.recommended_downloads(recommendations, models)] == [
        "sdxl-base-1.0",
        "ltx-video-0.9-i2v",
    ]


def test_picked_ports_avoid_the_ports_localcut_and_its_programs_use(monkeypatch):
    offered = iter([8188, 11434, 7830, 25001, 25001, 25002, 25003])
    monkeypatch.setattr(rrc.random, "randrange", lambda *_: next(offered))
    assert rrc.pick_ports(3) == [25001, 25002, 25003]


def test_the_comfyui_log_kept_is_this_runs():
    log = (
        "\n-- LocalCut started comfyui at 2026-10-20 22:14:39: http://127.0.0.1:8291\n"
        "an earlier run's line\n"
        "\n-- LocalCut started comfyui at 2026-10-21 11:55:41: http://127.0.0.1:23401\n"
        "this run's line\n"
    )
    kept = rrc.this_runs_log(log, "http://127.0.0.1:23401")
    assert kept.startswith("-- LocalCut started comfyui at 2026-10-21 11:55:41")
    assert "earlier" not in kept and "this run's line" in kept
    # A start at an address that only shares a prefix is another run's.
    assert rrc.this_runs_log(log, "http://127.0.0.1:829") == log


# -- the report ----------------------------------------------------------------------


def _report(checks: list[dict], unreachable: str | None = None) -> dict:
    return rrc.build_report(
        started=1_790_000_000.0,
        finished=1_790_000_400.0,
        request={
            "prompt": "A red fox trotting through a snowy pine forest at sunrise",
            "duration_s": 16,
            "aspect": "9:16",
            "script_model": None,
        },
        versions={
            "engine": {"commit": "9315b60aa1b2", "dirty": False},
            "ffmpeg": "9.0.2",
            "comfyui": "0.42.1",
            "comfyui_python": "3.13.16",
            "torch": "2.14.1+cu130",
            "ollama": None,
            "python": "3.14.7",
            "gpu": {
                "name": "NVIDIA GeForce RTX 3080 Laptop GPU",
                "vram_gb": 8.0,
                "driver": "595.99",
            },
        },
        setup={"seconds": 12.0, "downloaded_bytes": 0},
        project={"id": "0f11f126e9", "created_at": 100.0},
        stages=rrc.stage_rows(_JOBS),
        checks=checks,
        unreachable=unreachable,
    )


def test_a_run_passes_only_when_every_check_did():
    ok = rrc.check("render", True, "8 jobs done")
    report = _report([ok, rrc.check("streams", True, "fine")])
    assert (report["verdict"], report["exit_status"]) == ("passed", 0)
    report = _report([ok, rrc.check("music", False, "mean -91.0 dB")])
    assert (report["verdict"], report["exit_status"]) == ("failed", 1)


def test_a_run_that_checked_nothing_did_not_pass():
    assert _report([])["exit_status"] == 1


def test_an_engine_that_could_not_be_reached_exits_2_whatever_else_passed():
    report = _report([rrc.check("programs", True, "fine")], unreachable="no engine at ...")
    assert (report["verdict"], report["exit_status"]) == ("engine_unreachable", 2)


def test_the_render_time_runs_from_create_to_the_last_stage_that_finished():
    assert _report([])["render_s"] == pytest.approx(165.2 - 100.0)


def test_the_summary_carries_the_versions_the_stages_and_the_checks():
    summary = rrc.summary_markdown(
        _report([rrc.check("render", True, "8 jobs done"), rrc.check("music", False, "a | b")])
    )
    assert summary.startswith("# Real render check: failed\n")
    assert "engine 9315b60aa1b2," in summary
    assert "FFmpeg 9.0.2, ComfyUI 0.42.1 (Python 3.13.16, PyTorch 2.14.1+cu130)" in summary
    assert "Ollama not used" in summary
    assert "NVIDIA GeForce RTX 3080 Laptop GPU, 8 GB, driver 595.99." in summary
    assert "| s1.clip | comfyui | done | 20.0 s |" in summary
    assert "| create to finished export | | | 1 min 5 s |" in summary
    # A pipe in a detail would split its table cell.
    assert "| music | FAIL | a / b |" in summary
    assert summary.isascii()


def test_the_report_is_json_without_infinities():
    report = _report(
        [
            rrc.loudness_check(
                "music",
                {"mean_db": float("-inf"), "peak_db": float("-inf"), "samples": 9},
                min_mean_db=-55,
                min_peak_db=-35,
            )
        ]
    )
    json.dumps(rrc.json_safe(report), allow_nan=False)


def test_every_string_the_check_can_print_is_ascii():
    """Its lines reach a console, which on a headless Windows box is the
    ANSI code page, as CLAUDE.md asks of every command here. Docstrings
    are read in the source, never printed."""
    tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and ast.get_docstring(node) is not None
    }
    offenders = [
        (node.lineno, ascii(char))
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
        for char in node.value
        if not char.isascii()
    ]
    assert not offenders, f"non-ASCII in printable strings: {offenders}"
