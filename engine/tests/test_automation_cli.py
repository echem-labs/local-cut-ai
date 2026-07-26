"""Driving a real engine from the command line.

Phase 3's "CLI automation on the headless engine". These run against an
actual uvicorn server on a real socket rather than an ASGI transport, because
the thing under test IS the client half: base urls, bearer headers, status
codes, streamed downloads and exit statuses are exactly what an in-process
shortcut would paper over.

The mock backend renders instantly, so `create` -> `render` -> `export`
completes here in about a second — which makes this the Phase 0 exit
criterion ("a watchable video from one prompt, unattended") expressed as the
automation contract a script actually depends on.
"""

from __future__ import annotations

import json
import socket
import threading
import time

import pytest
import uvicorn

from localcut_engine import automation, cli
from localcut_engine.api.app import create_app
from localcut_engine.config import EngineConfig

TOKEN = "automation-token"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture
def engine(tmp_path):
    """A live engine on loopback, with the mock backend and the scheduler
    actually running (uvicorn drives the lifespan, which is what starts it)."""
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")
    server = uvicorn.Server(
        uvicorn.Config(create_app(config), host="127.0.0.1", port=_free_port(), log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started, "the test engine never came up"
    try:
        yield f"http://127.0.0.1:{server.config.port}"
    finally:
        server.should_exit = True
        thread.join(timeout=20)


def run(engine_url: str, *args: str, token: str = TOKEN) -> int:
    """`localcut-engine <args>` against the test engine."""
    return cli.main([*args, "--engine", engine_url, "--token", token])


def json_out(capsys) -> object:
    return json.loads(capsys.readouterr().out)


# -- the round trip a script actually runs -----------------------------------


def test_a_prompt_becomes_a_rendered_file_without_a_ui(engine, capsys, tmp_path):
    """The whole point of the automation surface, in the order a CI job would
    do it. Every step is a separate process invocation in real use, which is
    why each one has to be usable from the id the previous one printed."""
    assert run(engine, "create", "a short film about tides", "--json") == 0
    project_id = json_out(capsys)["id"]

    assert run(engine, "render", project_id, "--timeout", "120", "--json") == 0
    assert json_out(capsys)["failed"] == []

    out = tmp_path / "cut.mp4"
    assert run(engine, "export", project_id, "--out", str(out), "--json") == 0

    assert out.is_file()
    assert out.stat().st_size > 0
    assert json_out(capsys)["bytes"] == out.stat().st_size


def test_a_project_is_listed_once_it_exists(engine, capsys):
    run(engine, "create", "listed", "--json")
    project_id = json_out(capsys)["id"]

    assert run(engine, "projects", "--json") == 0

    assert [row["id"] for row in json_out(capsys)] == [project_id]


def test_render_reports_nothing_left_outstanding(engine, capsys):
    """`--no-wait` is for a script that wants to enqueue and come back."""
    run(engine, "create", "queued", "--json")
    project_id = json_out(capsys)["id"]

    assert run(engine, "render", project_id, "--no-wait", "--json") == 0

    assert "pending" in json_out(capsys)


# -- the exit statuses a script branches on ----------------------------------


def test_an_unreachable_engine_exits_2_and_says_how_to_start_one(capsys):
    """Distinct from 'the render failed': only one of the two is worth
    retrying, and a script cannot tell them apart from a message."""
    dead = f"http://127.0.0.1:{_free_port()}"

    assert cli.main(["projects", "--engine", dead, "--token", "x"]) == automation.EXIT_UNREACHABLE

    error = capsys.readouterr().err
    assert "no engine at" in error
    assert "localcut-engine serve" in error


def test_a_bad_token_says_which_flag_fixes_it(engine, capsys):
    assert run(engine, "projects", token="wrong-token") == automation.EXIT_FAILED

    error = capsys.readouterr().err
    assert "rejected the token" in error
    assert "LOCALCUT_TOKEN" in error


def test_a_missing_project_reports_the_engine_s_own_reason(engine, capsys):
    assert run(engine, "render", "0123456789") == automation.EXIT_FAILED

    assert "not found" in capsys.readouterr().err


def test_exporting_a_project_that_never_rendered_says_to_render_it(engine, capsys, tmp_path):
    """The failure a first-time script hits: `export` before `render`. The
    404 underneath it is about an artifact hash, which explains nothing."""
    run(engine, "create", "unrendered", "--json")
    project_id = json_out(capsys)["id"]

    assert run(engine, "export", project_id, "--out", str(tmp_path / "x.mp4")) == 1

    assert "run `render` first" in capsys.readouterr().err


# -- templates over the wire -------------------------------------------------


def test_a_template_round_trips_through_two_files_and_a_new_project(engine, capsys, tmp_path):
    run(engine, "create", "the original", "--aspect", "16:9", "--json")
    source_id = json_out(capsys)["id"]

    document = tmp_path / "template.json"
    assert run(engine, "template", "export", source_id, "--out", str(document), "--json") == 0
    # `--out` wrote the document; stdout carries the result, like every other
    # command's --json — so the file is where the template is read from.
    assert json_out(capsys)["path"] == str(document)
    assert json.loads(document.read_text(encoding="utf-8"))["nodes"]

    assert run(engine, "template", "import", str(document), "--title", "the copy", "--json") == 0
    result = json_out(capsys)

    assert result["project"]["title"] == "the copy"
    assert result["project"]["id"] != source_id
    assert result["project"]["aspect"] == "16:9"


def test_importing_a_junk_template_file_fails_before_any_request(capsys, tmp_path):
    """No engine flag needed — the file is read first, so a typo in a path
    does not look like a connection problem."""
    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")

    assert cli.main(["template", "import", str(broken), "--engine", "http://127.0.0.1:1"]) == 1

    assert "not valid JSON" in capsys.readouterr().err


def test_importing_a_template_reports_what_it_would_spend(engine, capsys, tmp_path):
    """A template pinned to a cloud model spends the importer's money on the
    author's choice of provider. The note has to arrive with the project id,
    not with the bill."""
    run(engine, "create", "cloudy", "--json")
    source_id = json_out(capsys)["id"]
    document = tmp_path / "cloudy.json"
    run(engine, "template", "export", source_id, "--out", str(document), "--json")
    capsys.readouterr()

    payload = json.loads(document.read_text(encoding="utf-8"))
    payload["nodes"]["script"]["model"] = "cloud:claude-sonnet-5"
    document.write_text(json.dumps(payload), encoding="utf-8")

    assert run(engine, "template", "import", str(document)) == 0

    assert "cloud:claude-sonnet-5" in capsys.readouterr().out


# -- workflows and packs over the wire ---------------------------------------

_WORKFLOW = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "%%PROMPT%%"}},
    "3": {"class_type": "SaveImage", "inputs": {}},
}


def _workflow_file(tmp_path, document) -> str:
    path = tmp_path / "workflow.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return str(path)


def test_a_builtin_workflow_imports_and_then_lists(engine, capsys, tmp_path):
    path = _workflow_file(tmp_path, _WORKFLOW)

    assert run(engine, "workflow", "import", path, "--name", "my-clip", "--json") == 0
    capsys.readouterr()
    assert run(engine, "workflow", "list", "--json") == 0

    rows = json_out(capsys)
    assert [row["name"] for row in rows] == ["my-clip"]
    assert rows[0]["placeholders"] == ["%%PROMPT%%"]


def test_check_reviews_without_importing(engine, capsys, tmp_path):
    """A dry run has to leave nothing behind, or `--check` is a worse version
    of the real thing."""
    path = _workflow_file(tmp_path, _WORKFLOW)

    assert run(engine, "workflow", "import", path, "--name", "dry", "--check", "--json") == 0
    capsys.readouterr()
    run(engine, "workflow", "list", "--json")

    assert json_out(capsys) == []


def test_a_workflow_needing_a_disabled_pack_is_refused_by_name(engine, capsys, tmp_path):
    path = _workflow_file(
        tmp_path, {**_WORKFLOW, "9": {"class_type": "VHS_VideoCombine", "inputs": {}}}
    )

    assert run(engine, "workflow", "import", path, "--name", "needs-pack") == 1

    error = capsys.readouterr().err
    assert "ComfyUI-VideoHelperSuite" in error
    assert "not enabled" in error


def test_enabling_a_pack_needs_the_risk_flag(engine, capsys):
    """The opt-in doc 07 risk 9 asks for, at the shell. A script cannot
    acknowledge third-party code execution by omission."""
    assert run(engine, "packs", "enable", "video-helper-suite", "--version", "1.2.3") == 1
    assert "third-party Python" in capsys.readouterr().err

    assert (
        run(
            engine,
            "packs",
            "enable",
            "video-helper-suite",
            "--version",
            "1.2.3",
            "--i-understand-the-risk",
            "--json",
        )
        == 0
    )
    assert json_out(capsys)["version"] == "1.2.3"


def test_the_same_workflow_imports_once_its_pack_is_enabled(engine, capsys, tmp_path):
    """The end-to-end version of the gate: identical bytes, different answer,
    because the operator made a decision in between."""
    path = _workflow_file(
        tmp_path, {**_WORKFLOW, "9": {"class_type": "VHS_VideoCombine", "inputs": {}}}
    )
    assert run(engine, "workflow", "import", path, "--name", "vhs") == 1
    capsys.readouterr()

    run(
        engine,
        "packs",
        "enable",
        "video-helper-suite",
        "--version",
        "1.2.3",
        "--i-understand-the-risk",
    )
    capsys.readouterr()

    assert run(engine, "workflow", "import", path, "--name", "vhs", "--json") == 0
    assert json_out(capsys)["packs_required"] == ["video-helper-suite"]


def test_listing_packs_always_carries_the_warning(engine, capsys):
    """The sentence has to travel with the thing it is about, or a client can
    present the enable action without it."""
    assert run(engine, "packs", "list", "--json") == 0

    catalog = json_out(capsys)
    assert "third-party Python" in catalog["warning"]
    assert all(pack["enabled"] is False for pack in catalog["packs"])


def test_removing_a_workflow_that_was_never_there_is_an_error(engine, capsys, tmp_path):
    assert run(engine, "workflow", "remove", "never-imported") == 1

    assert "unknown workflow" in capsys.readouterr().err


# -- output discipline -------------------------------------------------------


def test_json_output_is_only_json(engine, capsys):
    """A script parses stdout. Prose mixed into it means every consumer needs
    a filter, and the first one to forget gets a crash in production."""
    run(engine, "create", "parse me", "--json")

    parsed = json.loads(capsys.readouterr().out)  # would raise on any stray line
    assert parsed["id"]


def test_errors_go_to_stderr_leaving_stdout_clean(engine, capsys):
    assert run(engine, "render", "0123456789", "--json") == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err
