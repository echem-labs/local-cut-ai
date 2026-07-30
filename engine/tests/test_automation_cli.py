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
import threading
import time
from pathlib import Path

import pytest

from conftest import free_port, serve_engine

from localcut_engine import automation, cli

TOKEN = "automation-token"


@pytest.fixture
def engine(tmp_path):
    with serve_engine(tmp_path, TOKEN) as url:
        yield url


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
    dead = f"http://127.0.0.1:{free_port()}"

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


def test_exporting_into_a_directory_that_does_not_exist_says_so(engine, capsys, tmp_path):
    """The write is as much a failure mode as the request. `--out
    build/cut.mp4` before `build/` exists is the ordinary way a CI script hits
    this, and a traceback about a WinError is not the automation contract this
    command advertises."""
    run(engine, "create", "unwritable", "--json")
    project_id = json_out(capsys)["id"]
    run(engine, "render", project_id, "--timeout", "120", "--json")
    capsys.readouterr()

    assert run(engine, "export", project_id, "--out", str(tmp_path / "no-dir" / "cut.mp4")) == 1

    error = capsys.readouterr().err
    assert error.startswith("error: could not write")
    assert "no-dir" in error


def test_importing_over_a_shipped_workflow_name_warns_before_it_lands(engine, capsys, tmp_path):
    """`--check` has to be able to say it BEFORE the replacement happens: the
    name decides which renders it takes over, and nothing afterwards shows
    that a packaged workflow was swapped."""
    path = _workflow_file(tmp_path, _WORKFLOW)

    assert run(engine, "workflow", "import", path, "--name", "clip_default", "--check") == 0

    assert "every project on this engine" in capsys.readouterr().out


# -- what "render" has to mean to a script -----------------------------------


def test_render_enqueues_work_when_the_queue_was_drained(engine, capsys):
    """`render` on a project whose jobs were cancelled has to render it.

    The draft path used to POST an empty patch, and `patch` re-plans only when
    an op dirtied something — so nothing was enqueued, `wait_for_render` found
    nothing pending, and the command printed "render finished" and exited 0
    over a queue it had never filled. A script's next step would then export
    whatever the previous complete run left behind.
    """
    run(engine, "create", "drained", "--json")
    project_id = json_out(capsys)["id"]
    with automation.EngineClient(engine, TOKEN) as client:
        # Wait for the screenplay to expand, then cancel everything still to do.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            jobs = client.get("/jobs", params={"project_id": project_id}) or []
            if len(jobs) > 3:
                break
            time.sleep(0.05)
        # Cancel until nothing is left, rather than once over a single
        # snapshot. The re-plan enqueues the expanded graph one job at a time,
        # so the poll above can return between two puts, and the specs planned
        # after it - export is the last of them - reach the queue only once
        # the cancels have already run. Sleeping a fixed 0.3s and hoping was
        # what left a queued export job behind on a loaded runner.
        drained_by = time.monotonic() + 30
        while time.monotonic() < drained_by:
            active = automation.active_jobs(client, project_id)
            if not active:
                break
            for job in active:
                try:
                    client.post(f"/jobs/{job['id']}/cancel")
                except automation.EngineError:
                    pass  # it finished on its own between the list and the cancel
            time.sleep(0.05)
        assert not automation.active_jobs(client, project_id), "the queue should be drained"

        assert run(engine, "render", project_id, "--no-wait", "--json") == 0

        assert json_out(capsys)["pending"] > 0


class _JobsStub:
    """Just enough EngineClient for wait_for_render: a canned /jobs history."""

    def __init__(self, *polls: list[dict]) -> None:
        self._polls = list(polls)

    def get(self, path: str, **kwargs: object) -> list[dict]:
        assert path == "/jobs"
        return self._polls.pop(0) if len(self._polls) > 1 else self._polls[0]


OLD = {"id": "old", "status": "failed", "spec": {"node_id": "s3.clip"}}
MINE = {"id": "mine", "status": "queued", "spec": {"node_id": "s1.clip"}}
BROKE = {**MINE, "status": "failed", "error": "out of memory"}


def test_a_failure_from_an_earlier_render_is_not_reported_as_this_one():
    """/jobs is the project's whole history — nothing deletes rows and the
    query has no status or time bound. Reporting every FAILED row as this
    render's failure meant one clip that failed once made `render` exit 1
    forever, so a CI job could never go green again."""
    failed = automation.wait_for_render(
        _JobsStub([OLD, MINE], [OLD, {**MINE, "status": "done"}]),
        "p1",
        timeout_s=30,
        not_mine=frozenset({"old"}),
    )

    assert failed == []


def test_a_failure_from_this_render_is_still_reported():
    """The bound above must not swallow the failures the command exists to
    report."""
    failed = automation.wait_for_render(
        _JobsStub([OLD, MINE], [OLD, BROKE]), "p1", timeout_s=30, not_mine=frozenset({"old"})
    )

    assert [job["id"] for job in failed] == ["mine"]


def test_a_job_that_fails_before_the_first_poll_is_still_this_render_s():
    """Why the snapshot is the CALLER's and not the wait's.

    Taken at the first poll, it would classify anything already terminal as
    somebody else's — including a job of this render that failed in the
    moment between the trigger and that poll. The command would then print
    "render finished" and exit 0 over a render that failed, which is the
    worse of the two directions to be wrong in.
    """
    failed = automation.wait_for_render(
        _JobsStub([BROKE]), "p1", timeout_s=30, not_mine=frozenset({"old"})
    )

    assert [job["id"] for job in failed] == ["mine"]


# -- what the client refuses to call success ---------------------------------


def test_pinning_a_certificate_against_a_cleartext_url_is_refused():
    """httpx ignores `verify` entirely for an http:// base url, so `--cert`
    there is not a weaker check, it is no check — the token and every provider
    key go out in the clear with the operator believing they are pinned."""
    with pytest.raises(automation.EngineError, match="not https"):
        automation.EngineClient("http://gpu-box:7830", TOKEN, cert=Path("engine.pem"))


def test_a_redirect_is_not_treated_as_a_successful_request():
    """httpx does not follow redirects by default, so a proxy that upgrades
    http->https or canonicalises the host returned a bodyless 302 that fell
    through every check to `return None` — which `render` read as "enqueued"
    and `export` wrote to disk as a finished cut, both exiting 0."""
    redirector = _RedirectServer()
    with redirector as url, automation.EngineClient(url, TOKEN) as client:
        with pytest.raises(automation.EngineError, match="redirected"):
            client.post("/projects/p1/render")


def test_a_redirect_does_not_land_on_disk_as_an_export(tmp_path):
    """The same hole in `download`, where it is worse: the empty body would be
    renamed over the destination, so the atomic rename that exists to stop a
    truncated file wearing a finished export's name delivered exactly that."""
    out = tmp_path / "cut.mp4"
    redirector = _RedirectServer()
    with redirector as url, automation.EngineClient(url, TOKEN) as client:
        with pytest.raises(automation.EngineError, match="redirected"):
            client.download("/projects/p1/export/otio", out)

    assert not out.exists()


class _RedirectServer:
    """A server that 302s everything, the way a reverse proxy in front of the
    engine does."""

    def __enter__(self) -> str:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Handler(BaseHTTPRequestHandler):
            def _redirect(self) -> None:
                self.send_response(302)
                self.send_header("Location", "https://elsewhere.example/")
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = do_POST = _redirect

            def log_message(self, *args: object) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", free_port()), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return f"http://127.0.0.1:{self._server.server_port}"

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=10)
