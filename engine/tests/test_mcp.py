"""Driving the engine from an MCP agent.

Phase 3's ecosystem follow-on to CLI automation: the MCP server is the same
kind of client of a running engine that automation.py is, speaking Model
Context Protocol on one side and the engine's HTTP API on the other. These
tests run against an actual uvicorn server on a real socket for the same
reason test_automation_cli.py does — the thing under test IS the client half
— with an in-memory MCP session standing in for the agent host.

What the toolset refuses to offer is tested as deliberately as what it does:
enabling a ComfyUI node pack acknowledges third-party code execution, which
is an operator's decision, and a tool would hand that acknowledgment to a
model.
"""

from __future__ import annotations

import asyncio
import sys
import threading
import time

import pytest
import uvicorn
from mcp.client import Client

from conftest import free_port

from localcut_engine import mcp_server
from localcut_engine.api.app import create_app
from localcut_engine.config import EngineConfig

TOKEN = "mcp-token"


@pytest.fixture
def engine(tmp_path):
    """A live engine on loopback, with the mock backend and the scheduler
    actually running (uvicorn drives the lifespan, which is what starts it)."""
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")
    server = uvicorn.Server(
        uvicorn.Config(create_app(config), host="127.0.0.1", port=free_port(), log_level="error")
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


def build(url: str, token: str = TOKEN):
    return mcp_server.build_server(url, token)


def _text(result) -> str:
    return "\n".join(getattr(block, "text", "") for block in result.content)


async def call(client: Client, tool: str, args: dict | None = None) -> dict:
    """Call a tool expecting success, and hold the structured-output line:
    every tool of this server returns a JSON document, because an agent that
    has to re-parse prose out of a text block is an agent that will misread
    it. (A bare `dict` return annotation silently disables structured output
    in the SDK — this assert is what notices the regression.)"""
    result = await client.call_tool(tool, args or {})
    assert not result.is_error, f"{tool} errored: {_text(result)}"
    assert result.structured_content is not None, f"{tool} returned no structured content"
    return result.structured_content


async def refusal(client: Client, tool: str, args: dict | None = None) -> str:
    """Call a tool expecting a readable error, and return its text."""
    result = await client.call_tool(tool, args or {})
    assert result.is_error, f"{tool} unexpectedly succeeded: {result.structured_content}"
    return _text(result)


async def until_done(client: Client, project_id: str, ignore: list[str] | None = None) -> dict:
    """Poll render_status until nothing is outstanding, the way an agent is
    told to. The mock backend renders in about a second."""
    deadline = time.monotonic() + 120
    while True:
        status = await call(
            client,
            "render_status",
            {"project_id": project_id, "ignore_job_ids": ignore or []},
        )
        if status["done"]:
            return status
        assert time.monotonic() < deadline, f"still rendering: {status}"
        await asyncio.sleep(0.05)


# -- the round trip an agent actually runs ------------------------------------


async def test_a_prompt_becomes_a_rendered_file_over_mcp(engine, tmp_path):
    """The Phase 0 exit criterion, driven by an agent: create, render, poll,
    export — each step usable from the ids the previous one returned."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "a short film about tides"})
        project_id = project["id"]

        started = await call(client, "start_render", {"project_id": project_id})
        assert isinstance(started["settled_before"], list)

        status = await until_done(client, project_id, ignore=started["settled_before"])
        assert status["failed"] == []
        assert status["export_ready"] is True

        out = tmp_path / "cut.mp4"
        result = await call(
            client, "export_video", {"project_id": project_id, "out_path": str(out)}
        )

    assert out.is_file()
    assert out.stat().st_size > 0
    assert result["bytes"] == out.stat().st_size
    assert result["path"] == str(out)


async def test_the_finalize_pass_renders_over_mcp(engine):
    """`final=True` posts /finalize with no body, which the route accepts
    (FinalizeBody defaults engine-side). The draft flow above cannot catch a
    regression here - this is the path a script's `render --final` also
    depends on."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "final quality"})
        await until_done(client, project["id"])

        started = await call(client, "start_render", {"project_id": project["id"], "final": True})
        status = await until_done(client, project["id"], ignore=started["settled_before"])

    assert status["failed"] == []


async def test_the_console_command_serves_a_real_agent_over_stdio(engine):
    """test_mcp_serves_stdio_against_the_resolved_engine fakes the server;
    this one does not: the actual `localcut-engine mcp` process, spawned the
    way an agent host spawns it, answering JSON-RPC over its own stdin/stdout
    against a live engine. What the in-memory sessions cannot prove: the
    console entry point, the argparse routing and the SDK's stdio framing
    agree end to end - and nothing else the CLI prints leaks onto the
    protocol channel."""
    from mcp.client.stdio import StdioServerParameters, stdio_client

    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "localcut_engine.cli", "mcp", "--engine", engine, "--token", TOKEN],
    )
    async with Client(stdio_client(params)) as client:
        tools = {tool.name for tool in (await client.list_tools()).tools}
        assert "create_project" in tools

        listing = await call(client, "list_projects")

    assert listing == {"projects": []}


async def test_a_project_is_listed_once_it_exists(engine):
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "listed"})

        listing = await call(client, "list_projects")

    assert [row["id"] for row in listing["projects"]] == [project["id"]]


async def test_engine_info_reports_version_and_backend(engine):
    """What an agent calibrates against before promising anyone a render."""
    async with Client(build(engine)) as client:
        info = await call(client, "engine_info")

    assert info["engine_version"]
    assert info["backend_mode"] == "mock"


# -- the errors an agent has to be able to read --------------------------------


async def test_an_unreachable_engine_reads_as_a_sentence_not_a_traceback():
    """The agent relays this text to a person. It has to say what to do —
    start an engine — not name an errno."""
    dead = f"http://127.0.0.1:{free_port()}"
    async with Client(build(dead)) as client:
        message = await refusal(client, "list_projects")

    assert "no engine at" in message
    assert "localcut-engine serve" in message


async def test_a_wrong_token_names_the_fix(engine):
    async with Client(build(engine, token="wrong-token")) as client:
        message = await refusal(client, "list_projects")

    assert "rejected the token" in message


async def test_exporting_before_a_render_names_the_tools_to_run_first(engine):
    """The automation CLI says "run `render` first"; an agent has to be told
    in its own vocabulary, or the advice points at a command it cannot run."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "unrendered"})
        message = await refusal(
            client,
            "export_video",
            {"project_id": project["id"], "out_path": "/nonexistent/never-written.mp4"},
        )

    assert "start_render" in message
    assert "render_status" in message


# -- edits ride the same chokepoint as every other client ----------------------


async def test_an_edit_names_an_unknown_scene_before_any_llm_runs(engine):
    """Scope validation happens ahead of the model call, so a bad scope is a
    cheap, deterministic refusal rather than a spent LLM round trip."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "scoped"})
        message = await refusal(
            client,
            "edit_project",
            {"project_id": project["id"], "instruction": "make it pop", "scope": "s99"},
        )

    assert "unknown scene" in message


async def test_a_plan_lands_via_apply_edit_without_a_second_llm_round_trip(engine):
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "planned"})
        await until_done(client, project["id"])

        result = await call(
            client,
            "apply_edit",
            {
                "project_id": project["id"],
                "plan": {"summary": "nothing to change", "edits": []},
            },
        )

    assert result["summary"] == "nothing to change"


async def test_a_patch_applies_and_undo_reverses_it(engine):
    """The op surface is /patch — same validation, same history — so what an
    agent pins, undo unpins."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "pinned"})
        project_id = project["id"]
        await until_done(client, project_id)

        await call(
            client,
            "patch_project",
            {"project_id": project_id, "ops": [{"op": "pin", "node_id": "script"}]},
        )
        await until_done(client, project_id)
        graph = await call(client, "get_graph", {"project_id": project_id})
        assert graph["nodes"]["script"]["pinned"] is True

        await call(client, "undo", {"project_id": project_id})
        graph = await call(client, "get_graph", {"project_id": project_id})
        assert graph["nodes"]["script"]["pinned"] is False

        await call(client, "redo", {"project_id": project_id})
        graph = await call(client, "get_graph", {"project_id": project_id})
        assert graph["nodes"]["script"]["pinned"] is True


async def test_an_agent_cannot_fabricate_voice_consent_through_patch(engine):
    """The doc-02 chokepoint, observed from the far side of MCP: add_node
    strips server-owned params, and connect re-checks the edge - so an agent
    that CLAIMS consent on a hand-built asset node still cannot wire it into
    a narration's voice_ref. The consent affirmation lives on the upload
    route alone."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "a cloned voice"})
        project_id = project["id"]
        await until_done(client, project_id)
        graph = await call(client, "get_graph", {"project_id": project_id})
        narration = next(
            node_id for node_id, node in graph["nodes"].items() if node["kind"] == "narration"
        )

        message = await refusal(
            client,
            "patch_project",
            {
                "project_id": project_id,
                "ops": [
                    {
                        "op": "add_node",
                        "node": {
                            "id": "fakesample",
                            "kind": "asset",
                            "params": {"voice_consent": True},
                        },
                    },
                    {
                        "op": "connect",
                        "node_id": narration,
                        "src": "fakesample",
                        "port": "voice_ref",
                    },
                ],
            },
        )

    assert "consent" in message


# -- the client cannot be steered off its own routes ----------------------------


async def test_a_crafted_id_cannot_slide_a_tool_onto_a_different_route(engine):
    """Tool arguments become URL path segments, and tool inputs come from a
    model. Unchecked, a project_id of "<real id>/graph" turns get_project
    into a successful request against the GRAPH route - the toolset's
    deny-list bypassed by string-building, answering with a document the
    tool never meant to fetch. The percent form is the same attack after one
    decode: the ASGI server unescapes %2F before the framework routes, so
    quoting is no defense and both spellings must be refused before any
    request is sent."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "smuggle"})

        for smuggled in (project["id"] + "/graph", project["id"] + "%2Fgraph"):
            message = await refusal(client, "get_project", {"project_id": smuggled})
            assert "not a valid id" in message


async def test_export_refuses_to_replace_an_existing_file_unless_told(engine, tmp_path):
    """An agent's mistyped out_path must not cost the user a file: the CLI
    operator typing --out sees what they typed, an agent's caller does not.
    overwrite=true is the explicit form of the decision."""
    target = tmp_path / "precious.mp4"
    target.write_bytes(b"the user's own bytes")

    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "careful"})
        project_id = project["id"]
        started = await call(client, "start_render", {"project_id": project_id})
        await until_done(client, project_id, ignore=started["settled_before"])

        message = await refusal(
            client, "export_video", {"project_id": project_id, "out_path": str(target)}
        )
        assert "already exists" in message
        assert target.read_bytes() == b"the user's own bytes"

        result = await call(
            client,
            "export_video",
            {"project_id": project_id, "out_path": str(target), "overwrite": True},
        )

    assert result["bytes"] == target.stat().st_size
    assert target.read_bytes() != b"the user's own bytes"


# -- what render_status has to mean to an agent --------------------------------


def test_failures_an_agent_said_to_ignore_are_not_this_renders():
    """/jobs is the project's whole history, so without the ignore list one
    clip that failed weeks ago would be reported as a failure of every render
    since — the same trap wait_for_render's not_mine exists for, carried over
    a stateless protocol by start_render handing out the snapshot."""
    jobs = [
        {"id": "old", "status": "failed", "spec": {"node_id": "s3.clip"}, "error": "oom"},
        {"id": "mine", "status": "failed", "spec": {"node_id": "s1.clip"}, "error": "boom"},
    ]

    payload = mcp_server.render_status_payload(jobs, export_hash=None, ignore_job_ids=["old"])

    assert [row["node_id"] for row in payload["failed"]] == ["s1.clip"]
    assert payload["done"] is True
    assert payload["counts"] == {"failed": 2}
    assert payload["export_ready"] is False


def test_outstanding_work_defers_the_export_answer():
    payload = mcp_server.render_status_payload(
        [{"id": "j1", "status": "queued", "spec": {"node_id": "s1.clip"}}],
        export_hash="abc123",
        ignore_job_ids=[],
    )

    assert payload["done"] is False
    assert payload["outstanding"] == ["s1.clip"]


# -- the toolset stops where operator decisions begin --------------------------


async def test_the_toolset_is_the_agent_surface_not_the_operator_one(engine):
    """Nothing here may enable node packs (third-party code execution is a
    human acknowledgment, doc 07 risk 9), touch provider keys, spend BYOK
    cloud models, download weights, or delete projects. The absence is the
    feature; this holds it."""
    async with Client(build(engine)) as client:
        tools = {tool.name for tool in (await client.list_tools()).tools}

    assert {
        "engine_info",
        "list_projects",
        "create_project",
        "get_project",
        "get_graph",
        "start_render",
        "render_status",
        "edit_project",
        "apply_edit",
        "patch_project",
        "undo",
        "redo",
        "project_history",
        "export_video",
    } <= tools

    for forbidden in ("pack", "provider", "key", "download", "delete", "cloud"):
        offenders = [name for name in tools if forbidden in name]
        assert not offenders, f"operator surface leaked into the toolset: {offenders}"


async def test_edit_project_cannot_choose_a_cloud_model(engine):
    """/edit takes a `model` field so the DESKTOP can offer cloud editing as
    a per-request opt-in. The MCP surface deliberately does not forward it: an
    agent choosing to spend the user's BYOK key is exactly the "silently
    spend" the route's own guard exists to prevent."""
    async with Client(build(engine)) as client:
        schemas = {tool.name: tool.input_schema for tool in (await client.list_tools()).tools}

    assert "model" not in schemas["edit_project"]["properties"]
    assert schemas["edit_project"]["properties"]["dry_run"]["default"] is True


# -- the `mcp` subcommand's wiring ---------------------------------------------


def test_mcp_with_a_bad_cert_exits_1_before_any_server_runs(capsys):
    """What can never work (a pin whose PEM does not exist) fails at startup
    with a sentence, not on the agent's first tool call."""
    from localcut_engine import cli

    code = cli.main(["mcp", "--engine", "https://gpu-box:7830", "--cert", "/nonexistent.pem"])

    assert code == 1
    assert "certificate not found" in capsys.readouterr().err


def test_mcp_serves_stdio_against_the_resolved_engine(monkeypatch):
    """The subcommand resolves url/token from the same env vars the
    automation commands use, hands them to build_server, and runs the stdio
    transport agent hosts spawn. Patched on the module because cli imports it
    inside the command - the import happens per call and picks this up."""
    from localcut_engine import cli, mcp_server as mcp_module

    seen: dict = {}

    class FakeServer:
        def run(self, transport):
            seen["transport"] = transport

    def fake_build(url, token, cert=None):
        seen.update(url=url, token=token, cert=cert)
        return FakeServer()

    monkeypatch.setattr(mcp_module, "build_server", fake_build)
    monkeypatch.setenv("LOCALCUT_ENGINE_URL", "http://10.0.0.5:7830")
    monkeypatch.setenv("LOCALCUT_TOKEN", "env-token")

    assert cli.main(["mcp"]) == 0

    assert seen == {
        "transport": "stdio",
        "url": "http://10.0.0.5:7830",
        "token": "env-token",
        "cert": None,
    }
