"""scripts/pin-programs.py's rules for which upstream release a pin takes,
against GitHub's own answers.

The fixtures in fixtures/github are GitHub API responses recorded on
2026-10-21 and cut down to the fields the script reads (BtbN's to the
releases since July and the assets a pin could take), so nothing here
touches the network. A case the recording does not hold, such as two
BtbN runs on one last day of a month, is made by changing a copy of it.

Measuring an archive is not tested here: the script refuses a pin it
cannot reproduce byte for byte. program-pins.yml runs it against
every pinned program on a pull request that changes the script.
"""

from __future__ import annotations

import copy
import datetime
import importlib.util
import json
import sys
from pathlib import Path

import httpx

ENGINE = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "github"
REPOSITORY = "echem-labs/local-cut-ai"


def _load_script():
    spec = importlib.util.spec_from_file_location(
        "pin_programs", ENGINE / "scripts" / "pin-programs.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses look their module up while the class is being made.
    sys.modules["pin_programs"] = module
    spec.loader.exec_module(module)
    return module


pins = _load_script()


def _fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _manifest() -> dict:
    return json.loads(
        (ENGINE / "src/localcut_engine/programs/programs-manifest.json").read_text(encoding="utf-8")
    )


def _pin(program: str, **changes) -> dict:
    entry = copy.deepcopy(next(p for p in _manifest()["programs"] if p["id"] == program))
    entry.update(changes)
    return entry


def _release(releases: list[dict], tag: str) -> dict:
    return next(r for r in releases if r["tag_name"] == tag)


def _utc(text: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(text).replace(tzinfo=datetime.UTC)


# -- FFmpeg ------------------------------------------------------------------------------


def test_ffmpeg_takes_the_last_build_of_a_month_that_has_ended():
    """On 2026-10-21 BtbN had fourteen daily builds of October, all newer
    than September's last. They go within weeks, so none of them is taken."""
    release = pins.ffmpeg_release(_fixture("btbn-releases.json"), datetime.date(2026, 10, 21))
    assert release is not None
    assert release.tag == "autobuild-2026-09-30-13-08"


def test_ffmpeg_takes_nothing_from_a_month_that_has_not_ended():
    """On the last day of a month a later run that day could still replace
    the build, so the month before is the newest that has ended."""
    release = pins.ffmpeg_release(_fixture("btbn-releases.json"), datetime.date(2026, 9, 30))
    assert release is not None
    assert release.tag == "autobuild-2026-08-31-13-27"


def test_ffmpeg_of_two_runs_on_the_last_day_takes_the_later():
    """BtbN keeps the newest build of a month, so of two that day only the
    later one survives."""
    releases = _fixture("btbn-releases.json")
    earlier = copy.deepcopy(_release(releases, "autobuild-2026-09-30-13-08"))
    later = copy.deepcopy(earlier)
    later["tag_name"] = "autobuild-2026-09-30-21-40"
    earlier["tag_name"] = "autobuild-2026-09-30-02-10"
    shuffled = [later if r["tag_name"] == "autobuild-2026-09-30-13-08" else r for r in releases]
    release = pins.ffmpeg_release([*shuffled, earlier], datetime.date(2026, 10, 21))
    assert release is not None and release.tag == "autobuild-2026-09-30-21-40"


def test_ffmpeg_takes_the_lgpl_build_of_the_newest_release_branch():
    """The September build carries the 8.1 and 9.0 branches, each as GPL
    and LGPL, static and shared, beside the master builds. The pin is the
    static LGPL build of 9.0 for both platforms."""
    release = pins.ffmpeg_release(_fixture("btbn-releases.json"), datetime.date(2026, 10, 21))
    assert release is not None
    assert (release.version, release.describe) == ("9.0.2", "n9.0.2-17-g2a571b6068")
    assert {platform: asset["name"] for platform, asset in release.assets.items()} == {
        "windows-x64": "ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-9.0.zip",
        "linux-x64": "ffmpeg-n9.0.2-17-g2a571b6068-linux64-lgpl-9.0.tar.xz",
    }
    assert release.branch == "pins/ffmpeg-9.0.2-2026-09-30"


def test_ffmpeg_passes_over_a_branch_built_for_one_platform_only():
    releases = _fixture("btbn-releases.json")
    september = _release(releases, "autobuild-2026-09-30-13-08")
    september["assets"] = [
        a for a in september["assets"] if not a["name"].endswith("-linux64-lgpl-9.0.tar.xz")
    ]
    release = pins.ffmpeg_release(releases, datetime.date(2026, 10, 21))
    assert release is not None and release.version == "8.1.3"


def test_a_later_month_end_build_moves_the_ffmpeg_pin():
    releases = _fixture("btbn-releases.json")
    pin = _pin("ffmpeg")
    current = pins.ffmpeg_release(releases, datetime.date(2026, 10, 21))
    assert current is not None and not pins.is_newer("ffmpeg", current, pin)
    october = copy.deepcopy(_release(releases, "autobuild-2026-09-30-13-08"))
    october["tag_name"] = "autobuild-2026-10-31-13-05"
    newer = pins.ffmpeg_release([october, *releases], datetime.date(2026, 11, 2))
    assert newer is not None and newer.tag == "autobuild-2026-10-31-13-05"
    assert pins.is_newer("ffmpeg", newer, pin)


# -- Ollama ------------------------------------------------------------------------------


def test_ollama_takes_the_newest_release():
    release = pins.ollama_release(_fixture("ollama-releases.json"))
    assert release is not None
    assert (release.version, release.tag) == ("0.40.7", "v0.40.7")
    assert pins.is_newer("ollama", release, _pin("ollama"))


def test_a_prerelease_is_passed_over():
    """0.40.7 was marked a prerelease until after 0.40.6 was pinned."""
    releases = _fixture("ollama-releases.json")
    _release(releases, "v0.40.7")["prerelease"] = True
    release = pins.ollama_release(releases)
    assert release is not None and release.version == "0.40.6"
    assert not pins.is_newer("ollama", release, _pin("ollama"))


def test_ollama_goes_by_version_not_by_date():
    """0.35.1 came out four days after 0.40.0, as a fix to the older line."""
    releases = [
        r
        for r in _fixture("ollama-releases.json")
        if r["tag_name"] in ("v0.40.0", "v0.35.1", "v0.35.0")
    ]
    assert (
        _release(releases, "v0.35.1")["published_at"]
        > _release(releases, "v0.40.0")["published_at"]
    )
    release = pins.ollama_release(releases)
    assert release is not None and release.version == "0.40.0"


def test_an_ollama_release_without_both_archives_is_passed_over():
    """Ollama publishes a release before its assets have all uploaded."""
    releases = _fixture("ollama-releases.json")
    newest = _release(releases, "v0.40.7")
    newest["assets"] = [a for a in newest["assets"] if a["name"] != "ollama-linux-amd64.tar.zst"]
    release = pins.ollama_release(releases)
    assert release is not None and release.version == "0.40.6"


# -- ComfyUI -----------------------------------------------------------------------------


def test_comfyui_is_held_until_it_is_three_days_old():
    """0.42.1 came out at 01:33 UTC on 2026-10-19, three hours after 0.42.0,
    which it fixed."""
    releases = _fixture("comfyui-releases.json")
    taken, held = pins.comfyui_release(releases, _utc("2026-10-21T07:00:00"))
    assert taken is None
    assert held is not None and held.version == "0.42.1"
    taken, held = pins.comfyui_release(releases, _utc("2026-10-22T01:34:00"))
    assert held is None
    assert taken is not None and taken.version == "0.42.1"


def test_nothing_older_is_taken_while_the_newest_comfyui_is_held():
    """0.41.0 was five days old on 2026-10-21 and is still not taken: a
    release followed that closely by others is the one to wait on."""
    pin = _pin("comfyui", version="0.40.0")
    taken, held = pins.comfyui_release(
        _fixture("comfyui-releases.json"), _utc("2026-10-21T07:00:00")
    )
    assert taken is None and held is not None and pins.is_newer("comfyui", held, pin)


def test_a_comfyui_release_missing_a_portable_build_is_passed_over():
    releases = _fixture("comfyui-releases.json")
    newest = _release(releases, "v0.42.1")
    newest["assets"] = [
        a for a in newest["assets"] if a["name"] != "ComfyUI_windows_portable_intel.7z"
    ]
    taken, held = pins.comfyui_release(releases, _utc("2026-10-22T01:34:00"))
    assert held is None and taken is not None and taken.version == "0.42.0"
    assert set(taken.assets) == set(pins.COMFYUI_PORTABLE)


# -- what has been proposed already --------------------------------------------------------


def test_an_existing_branch_is_not_proposed_again():
    reason = pins.proposed_already("main", REPOSITORY, _fixture("refs-ma.json"), [])
    assert reason == "branch main exists"


def test_a_branch_whose_name_only_starts_another_is_not_taken_for_it():
    """GitHub's matching-refs answers every ref that starts with the name."""
    assert pins.proposed_already("ma", REPOSITORY, _fixture("refs-ma.json"), []) is None


def test_a_pull_request_from_the_branch_counts_even_closed_and_deleted():
    """#166's branch is gone. Its pull request still says the bump was made,
    and a closed one that was not merged is a decision not to."""
    reason = pins.proposed_already(
        "chore/ollama-0.40.6", REPOSITORY, [], _fixture("pulls-chore-ollama-0.40.6.json")
    )
    assert reason == "pull request #166 (closed) is from chore/ollama-0.40.6"


def test_a_release_with_neither_is_proposed():
    assert (
        pins.proposed_already(
            "pins/ollama-0.40.7",
            REPOSITORY,
            _fixture("refs-pins-ollama-0.40.7.json"),
            _fixture("pulls-pins-ollama-0.40.7.json"),
        )
        is None
    )


# -- the report, end to end ----------------------------------------------------------------


def _github(refs: dict[str, list], pulls: dict[str, list]) -> httpx.Client:
    """A client whose GitHub answers from the fixtures: the releases and
    for each branch named, its refs and its pull requests."""
    releases = {
        "/repos/BtbN/FFmpeg-Builds/releases": "btbn-releases.json",
        "/repos/ollama/ollama/releases": "ollama-releases.json",
        "/repos/Comfy-Org/ComfyUI/releases": "comfyui-releases.json",
    }

    def answer(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path in releases:
            return httpx.Response(200, json=_fixture(releases[path]))
        prefix = f"/repos/{REPOSITORY}/git/matching-refs/heads/"
        if path.startswith(prefix):
            return httpx.Response(200, json=refs[path.removeprefix(prefix)])
        if path == f"/repos/{REPOSITORY}/pulls":
            assert request.url.params["state"] == "all"
            return httpx.Response(200, json=pulls[request.url.params["head"].split(":", 1)[1]])
        return httpx.Response(404, json={"message": "Not Found"})

    return httpx.Client(transport=httpx.MockTransport(answer))


def test_the_report_names_what_is_newer_and_where_it_would_go():
    with _github(
        refs={"pins/ollama-0.40.7": _fixture("refs-pins-ollama-0.40.7.json")},
        pulls={"pins/ollama-0.40.7": _fixture("pulls-pins-ollama-0.40.7.json")},
    ) as client:
        report = pins.check_report(client, _manifest(), _utc("2026-10-21T07:00:00"), REPOSITORY)
    assert [(e["program"], e["version"], e["branch"]) for e in report["newer"]] == [
        ("ollama", "0.40.7", "pins/ollama-0.40.7")
    ]
    assert report["held"] == [] and report["skipped"] == []


def test_the_report_skips_a_bump_already_proposed_and_shows_one_held():
    manifest = _manifest()
    next(p for p in manifest["programs"] if p["id"] == "comfyui")["version"] = "0.40.0"
    # #166's answer, as if it had come from the branch a bump would use.
    pulls = _fixture("pulls-chore-ollama-0.40.6.json")
    pulls[0]["head"]["ref"] = "pins/ollama-0.40.7"
    with _github(
        refs={"pins/ollama-0.40.7": _fixture("refs-pins-ollama-0.40.7.json")},
        pulls={"pins/ollama-0.40.7": pulls},
    ) as client:
        report = pins.check_report(client, manifest, _utc("2026-10-21T07:00:00"), REPOSITORY)
    assert report["newer"] == []
    assert [(e["program"], e["reason"]) for e in report["skipped"]] == [
        ("ollama", "pull request #166 (closed) is from pins/ollama-0.40.7")
    ]
    assert [(e["program"], e["version"]) for e in report["held"]] == [("comfyui", "0.42.1")]


# -- measuring ---------------------------------------------------------------------------


def test_a_link_written_with_a_leading_dot_slash_is_pinned_bare(monkeypatch):
    """Ollama 0.40.7's tarball writes two CUDA 13 sonames as
    `./libcublas.so.13.1.1.3`. The pin keeps the bare name, which the
    manifest takes and which names the same file."""
    import zipfile

    from localcut_engine.programs.manifest import parse_programs_manifest

    def published(name: str) -> dict:
        return {
            "name": name,
            "browser_download_url": f"https://example.com/{name}",
            "size": 10,
            "digest": "sha256:" + "a" * 64,
        }

    release = pins.Release(
        program="ollama",
        version="0.40.7",
        tag="v0.40.7",
        published="2026-10-18T00:28:57Z",
        label="0.40.7",
        assets={
            "windows-x64": published("ollama-windows-amd64.zip"),
            "linux-x64": published("ollama-linux-amd64.tar.zst"),
        },
    )
    executable = zipfile.ZipInfo("ollama.exe")
    executable.file_size = 6
    monkeypatch.setattr(pins, "_checksums", lambda client, release, name: None)
    monkeypatch.setattr(pins, "zip_listing", lambda client, asset: [executable])
    monkeypatch.setattr(
        pins,
        "tar_stream",
        lambda client, asset: (
            10,
            "a" * 64,
            [
                pins.TarEntry("bin/ollama", "file", 6),
                pins.TarEntry("lib/ollama/cuda_v13/libcublas.so.13.1.1.3", "file", 40),
                pins.TarEntry(
                    "lib/ollama/cuda_v13/libcublas.so.13", "link", 0, "./libcublas.so.13.1.1.3"
                ),
            ],
        ),
    )
    entry = pins.measure_ollama(None, release, _pin("ollama")).entry
    linux = next(asset for asset in entry["assets"] if asset["platform"] == "linux-x64")
    soname = next(kept for kept in linux["files"] if kept["path"].endswith("libcublas.so.13"))
    assert soname["link"] == "libcublas.so.13.1.1.3"
    parse_programs_manifest(json.dumps({"schema_version": 1, "programs": [entry]}))
