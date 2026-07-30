"""Driving the engine from an MCP agent.

Phase 3's ecosystem follow-on to CLI automation: the MCP server is the same
kind of client of a running engine that automation.py is, speaking Model
Context Protocol on one side and the engine's HTTP API on the other. These
tests run against an actual uvicorn server on a real socket for the same
reason test_automation_cli.py does — the thing under test IS the client half
— with an in-memory MCP session standing in for the agent host.

What the toolset refuses to offer is tested as deliberately as what it does:
enabling a ComfyUI node pack acknowledges third-party code execution, which
is an operator's decision; a cloud model spends the user's provider key,
which is a per-request decision made in the app. A tool would hand either
one to a model.
"""

from __future__ import annotations

import asyncio
import socket
import sys
import time

import pytest
from mcp.client import Client

from conftest import serve_engine

from localcut_engine import mcp_server

TOKEN = "mcp-token"


@pytest.fixture
def engine(tmp_path):
    with serve_engine(tmp_path, TOKEN) as url:
        yield url


def build(url: str, token: str = TOKEN, export_dir=None):
    return mcp_server.build_server(url, token, export_dir=export_dir)


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
    async with Client(build(engine, export_dir=tmp_path)) as client:
        project = await call(client, "create_project", {"prompt": "a short film about tides"})
        project_id = project["id"]

        started = await call(client, "start_render", {"project_id": project_id})
        assert started["earlier_failures"] == []

        status = await until_done(client, project_id, ignore=started["earlier_failures"])
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
        # A real count read out of the POST body - a typo'd key would report
        # 0 forever. Asserted here rather than on the draft flow, where 0 is
        # the honest answer: creation had already queued that work.
        assert started["enqueued"] > 0
        status = await until_done(client, project["id"], ignore=started["earlier_failures"])

    assert status["failed"] == []


async def test_a_beginner_project_advances_through_approve(engine):
    """mode="beginner" pauses at the script and storyboard checkpoints,
    released only by /approve — so without an approve tool the project is a
    dead end no other tool can advance: done=true, nothing enqueued,
    export_ready never true. This is the storyboard-first UX (approve before
    burning GPU time), operable by an agent."""
    async with Client(build(engine)) as client:
        project = await call(
            client, "create_project", {"prompt": "step by step", "mode": "beginner"}
        )
        project_id = project["id"]

        status = await until_done(client, project_id)
        assert status["export_ready"] is False, "the checkpoint should still be closed"

        released = await call(client, "approve", {"project_id": project_id, "checkpoint": "script"})
        assert released["ok"] is True
        await until_done(client, project_id)

        await call(client, "approve", {"project_id": project_id, "checkpoint": "storyboard"})
        status = await until_done(client, project_id)

    assert status["failed"] == []
    assert status["export_ready"] is True


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
    start an engine — not name an errno. The dead port is HELD (bound, never
    listening) for the duration: a merely-probed free port can be claimed by
    another process between the probe and the connect, turning 'unreachable'
    into a reachable non-engine and this assert into a flake."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("127.0.0.1", 0))
        dead = f"http://127.0.0.1:{held.getsockname()[1]}"
        async with Client(build(dead)) as client:
            message = await refusal(client, "list_projects")

    assert "no engine at" in message
    assert "localcut-engine serve" in message


async def test_a_wrong_token_names_the_fix(engine):
    async with Client(build(engine, token="wrong-token")) as client:
        message = await refusal(client, "list_projects")

    assert "rejected the token" in message


async def test_a_missing_token_is_not_reported_as_a_rejected_one(engine):
    """With no token configured, no Authorization header goes out at all.
    'Rejected the token' would send the operator to debug a value that was
    never sent — an env var that templated to empty is the ordinary way a
    host config gets here, and nobody sees the request on a stdio channel."""
    async with Client(build(engine, token="")) as client:
        message = await refusal(client, "list_projects")

    assert "none was sent" in message


async def test_exporting_before_a_render_names_the_tools_to_run_first(engine, tmp_path):
    """The automation CLI says "run `render` first"; an agent has to be told
    in its own vocabulary, or the advice points at a command it cannot run."""
    async with Client(build(engine, export_dir=tmp_path)) as client:
        project = await call(client, "create_project", {"prompt": "unrendered"})
        message = await refusal(
            client,
            "export_video",
            {"project_id": project["id"], "out_path": "never-written.mp4"},
        )

    assert "start_render" in message
    assert "render_status" in message
    assert not (tmp_path / "never-written.mp4").exists()


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


async def test_a_plan_lands_via_apply_edit_with_the_previewed_revision(engine):
    """apply_edit requires the scope and revision the preview returned; with
    the real revision the plan lands, exactly once around the LLM."""
    from localcut_engine.graph.editor import graph_revision
    from localcut_engine.graph.model import StoryGraph

    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "planned"})
        await until_done(client, project["id"])
        graph = await call(client, "get_graph", {"project_id": project["id"]})
        revision = graph_revision(StoryGraph.model_validate(graph), "project")

        result = await call(
            client,
            "apply_edit",
            {
                "project_id": project["id"],
                "plan": {"summary": "nothing to change", "edits": []},
                "scope": "project",
                "revision": revision,
            },
        )

    assert result["summary"] == "nothing to change"


async def test_a_stale_revision_refuses_to_land(engine):
    """The stale-plan refusal is the reason revision is a REQUIRED argument:
    optional, it silently skipped the check server-side, and a plan
    previewed before a background re-expansion would land on renumbered
    scenes the model never saw."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "stale"})
        await until_done(client, project["id"])

        message = await refusal(
            client,
            "apply_edit",
            {
                "project_id": project["id"],
                "plan": {"summary": "late", "edits": []},
                "scope": "project",
                # Well-formed (graph_revision returns 16 hex) but not this
                # graph's: a malformed value would also be refused, by a
                # different rule than the one this test names.
                "revision": "0" * 16,
            },
        )

    assert "while the edit was being generated" in message


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


async def test_an_agent_cannot_set_a_cloud_model_through_patch(engine):
    """The BYOK line edit_project draws is only a line if patch_project
    holds it too: a raw set_model (or an add_node carrying a model) reaches
    the same provider-key spend one tool down. Local models stay allowed —
    they are the user's own GPU."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "billed"})
        project_id = project["id"]
        await until_done(client, project_id)

        for op in (
            {"op": "set_model", "node_id": "s1.clip", "model": "cloud:kling-pro"},
            {
                "op": "add_node",
                "node": {"id": "expensive", "kind": "clip", "model": "cloud:veo-3.1-fast"},
            },
            # Spelling variants the ENGINE's exact-prefix routing would send
            # to a local backend today - but they persist onto the node, and
            # the day any normalization appears on the routing side they are
            # real spend. Refusing costs nothing; agreeing with a bug does.
            {"op": "set_model", "node_id": "s1.clip", "model": "CLOUD:kling-pro"},
            {"op": "set_model", "node_id": "s1.clip", "model": " cloud:kling-pro"},
            {"op": "set_model", "node_id": "s1.clip", "model": "﻿cloud:kling-pro"},
        ):
            message = await refusal(
                client, "patch_project", {"project_id": project_id, "ops": [op]}
            )
            assert "provider key" in message

        result = await call(
            client,
            "patch_project",
            {
                "project_id": project_id,
                "ops": [{"op": "set_model", "node_id": "s1.clip", "model": "local:ltx-video"}],
            },
        )
        assert "s1.clip" in result["dirty"]
        await until_done(client, project_id)


# -- the client cannot be steered off its own routes ----------------------------


async def test_a_crafted_id_cannot_slide_a_tool_onto_a_different_route(engine):
    """Tool arguments become URL path segments, and tool inputs come from a
    model. Every spelling of path structure must be refused before any
    request goes out: "<id>/graph" would hit the GRAPH route directly;
    "%2Fgraph" arrives there after the ASGI server's percent-decode; "." and
    ".." are removed by httpx itself when merging URLs, landing on the LIST
    route and the server root; DEL dies inside httpx with a traceback
    instead of a sentence. The allow-list (the engine's own id pattern)
    refuses the whole class, not an enumeration of yesterday's tricks."""
    async with Client(build(engine)) as client:
        project = await call(client, "create_project", {"prompt": "smuggle"})

        for smuggled in (
            project["id"] + "/graph",
            project["id"] + "%2Fgraph",
            ".",
            "..",
            "\x7f",
        ):
            message = await refusal(client, "get_project", {"project_id": smuggled})
            assert "not a project id" in message


async def test_an_empty_id_is_refused_not_broadened(engine):
    """/jobs treats an empty project_id as NO filter, so before validation
    an empty id fabricated a status document out of every other project's
    jobs — a plausible-looking answer about nothing. It must be a refusal,
    and the same refusal whether or not unrelated work happens to be
    queued."""
    async with Client(build(engine)) as client:
        await call(client, "create_project", {"prompt": "somebody else's render"})

        message = await refusal(client, "render_status", {"project_id": ""})

    assert "not a project id" in message


def _as_the_app(engine_url: str):
    """A raw HTTP client with no cloud-spend header - i.e. the desktop app,
    where choosing a cloud model is the user's own decision to make."""
    import httpx

    return httpx.Client(base_url=engine_url, headers={"Authorization": f"Bearer {TOKEN}"})


def _record_a_cloud_take(api, project_id: str, node_id: str) -> str:
    """Put `node_id` on a cloud model and regenerate, which parks the prior
    identity in takes.json - the way a cloud take really comes to exist."""
    api.post(
        f"/projects/{project_id}/patch",
        json={"ops": [{"op": "set_model", "node_id": node_id, "model": "cloud:kling-2.5"}]},
    ).raise_for_status()
    api.post(f"/projects/{project_id}/nodes/{node_id}/regenerate", json={}).raise_for_status()
    # Back to local: the realistic end state, and the one that matters -
    # the cloud model now lives only in the take record, where restoring it
    # is the spend an agent must not be able to reach.
    api.post(
        f"/projects/{project_id}/patch",
        json={"ops": [{"op": "set_model", "node_id": node_id, "model": "local:ltx-video"}]},
    ).raise_for_status()
    board = api.get(f"/projects/{project_id}").raise_for_status().json()["board"]
    stack, found = [board], []
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            for take in item.get("takes") or []:
                if (take.get("model") or "").startswith("cloud:"):
                    found.append(take["output_hash"])
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    assert found, f"no cloud take was recorded on {node_id}"
    return found[0]


async def test_a_take_rendered_on_a_cloud_model_cannot_be_restored(engine, tmp_path):
    """select_take names only an output hash - the engine substitutes the
    recorded params, seed AND model - so a take rendered on a cloud model
    puts that model back on the node and re-renders it. That is the BYOK
    spend this surface refuses, reached without an agent ever naming a
    model, which is why scanning the ops cannot be the whole answer."""
    async with Client(build(engine, export_dir=tmp_path)) as client:
        project = await call(client, "create_project", {"prompt": "a pricey take"})
        project_id = project["id"]
        await until_done(client, project_id)
        with _as_the_app(engine) as api:
            billed = _record_a_cloud_take(api, project_id, "s1.clip")
        await until_done(client, project_id)

        message = await refusal(
            client,
            "patch_project",
            {
                "project_id": project_id,
                "ops": [{"op": "select_take", "node_id": "s1.clip", "take": billed}],
            },
        )

    assert "provider keys" in message


async def test_hiding_a_scene_from_the_board_does_not_unlock_a_cloud_take(engine, tmp_path):
    """Why the refusal is the ENGINE's and not a read of the board.

    A scene card exists only for scene ids derived from `.clip` nodes, so
    removing s1.clip - an ordinary, permitted op - takes that scene's takes
    off the board while s1.clip2 stays in the graph and stays selectable.
    Any client-side check reading the board sees nothing left to refuse.
    The queue does not care what the board shows."""
    async with Client(build(engine, export_dir=tmp_path)) as client:
        project = await call(client, "create_project", {"prompt": "a split scene"})
        project_id = project["id"]
        await until_done(client, project_id)
        with _as_the_app(engine) as api:
            billed = _record_a_cloud_take(api, project_id, "s1.clip2")
        await until_done(client, project_id)

        await call(
            client,
            "patch_project",
            {"project_id": project_id, "ops": [{"op": "remove_node", "node_id": "s1.clip"}]},
        )
        await until_done(client, project_id)

        message = await refusal(
            client,
            "patch_project",
            {
                "project_id": project_id,
                "ops": [{"op": "select_take", "node_id": "s1.clip2", "take": billed}],
            },
        )

    assert "provider keys" in message


async def test_undo_cannot_restore_a_snapshot_that_spends(engine, tmp_path):
    """undo restores a whole prior graph - model fields included - and then
    re-enqueues the dirty cone, so a cloud model the user backed out of is
    one documented tool call away from rendering again. No gate on any
    single tool could have seen this; the queue's can."""
    async with Client(build(engine, export_dir=tmp_path)) as client:
        project = await call(client, "create_project", {"prompt": "a change of mind"})
        project_id = project["id"]
        await until_done(client, project_id)

        with _as_the_app(engine) as api:
            # The user picks cloud, then thinks better of it - two ordinary
            # app actions, leaving the cloud model in the undo history.
            for model in ("cloud:kling-2.5", "local:ltx-video"):
                api.post(
                    f"/projects/{project_id}/patch",
                    json={"ops": [{"op": "set_model", "node_id": "s1.clip", "model": model}]},
                ).raise_for_status()
        await until_done(client, project_id)

        message = await refusal(client, "undo", {"project_id": project_id})

    assert "provider keys" in message


async def test_the_app_itself_is_not_gated(engine, tmp_path):
    """The refusal belongs to callers that declare they may not spend, not
    to the engine at large: the desktop app - where the user makes the
    decision - must still be able to put a node on a cloud model."""
    async with Client(build(engine, export_dir=tmp_path)) as client:
        project = await call(client, "create_project", {"prompt": "the user's own call"})
        project_id = project["id"]
        await until_done(client, project_id)

    with _as_the_app(engine) as api:
        response = api.post(
            f"/projects/{project_id}/patch",
            json={"ops": [{"op": "set_model", "node_id": "s1.clip", "model": "cloud:kling-2.5"}]},
        )

    assert response.status_code == 200, response.text
    assert "s1.clip" in response.json()["dirty"]


async def test_a_render_can_be_stopped(engine, tmp_path):
    """ "Stop it" is an ordinary request, and a stalled render is otherwise
    something an agent can only watch. Cancelling only reduces work."""
    async with Client(build(engine, export_dir=tmp_path)) as client:
        project = await call(client, "create_project", {"prompt": "second thoughts"})
        project_id = project["id"]

        result = await call(client, "cancel_render", {"project_id": project_id})
        assert isinstance(result["cancelled"], int)

        status = await until_done(client, project_id)

    assert status["done"] is True


async def test_export_cannot_write_outside_its_export_directory(engine, tmp_path):
    """out_path is a model-authored string and the bytes land on the machine
    running the MCP server. Unconfined it is an arbitrary write: pointed at
    the engine's own project.json it empties a project, and nothing in the
    toolset can undo that. Relative paths resolve against the export root
    rather than whatever cwd the agent host spawned us with."""
    exports = tmp_path / "exports"
    outside = tmp_path / "precious" / "project.json"
    outside.parent.mkdir()
    outside.write_text("the user's own state", encoding="utf-8")

    async with Client(build(engine, export_dir=exports)) as client:
        project = await call(client, "create_project", {"prompt": "contained"})
        project_id = project["id"]
        started = await call(client, "start_render", {"project_id": project_id})
        await until_done(client, project_id, ignore=started["earlier_failures"])

        for escape in (str(outside), "../precious/project.json", "/etc/hosts"):
            message = await refusal(
                client,
                "export_video",
                {"project_id": project_id, "out_path": escape, "overwrite": True},
            )
            assert "outside the export directory" in message

        # A symlink is resolved BEFORE the containment test, so it cannot be
        # used as a door out of the root.
        (exports).mkdir(parents=True, exist_ok=True)
        (exports / "door.mp4").symlink_to(outside)
        message = await refusal(
            client,
            "export_video",
            {"project_id": project_id, "out_path": "door.mp4", "overwrite": True},
        )
        assert "outside the export directory" in message

        # And a plain relative path lands inside the root, subdirectories
        # created for it.
        result = await call(
            client,
            "export_video",
            {"project_id": project_id, "out_path": "cuts/final.mp4"},
        )

    assert result["path"] == str((exports / "cuts" / "final.mp4").resolve())
    assert outside.read_text(encoding="utf-8") == "the user's own state"


async def test_export_does_not_clobber_a_neighbouring_part_file(engine, tmp_path):
    """The download writes a scratch file beside the destination before
    renaming it into place. Named `<destination>.part` it was a SECOND
    destination nobody approved: one unrelated user file destroyed per
    export, with overwrite=false and no error, because the overwrite check
    can only ever see the path the caller named."""
    exports = tmp_path / "exports"
    exports.mkdir()
    bystander = exports / "cut.mp4.part"
    bystander.write_text("somebody else's work", encoding="utf-8")

    async with Client(build(engine, export_dir=exports)) as client:
        project = await call(client, "create_project", {"prompt": "tidy"})
        project_id = project["id"]
        started = await call(client, "start_render", {"project_id": project_id})
        await until_done(client, project_id, ignore=started["earlier_failures"])

        await call(client, "export_video", {"project_id": project_id, "out_path": "cut.mp4"})

    assert bystander.read_text(encoding="utf-8") == "somebody else's work"
    assert (exports / "cut.mp4").stat().st_size > 0
    # The scratch file is cleaned up, not merely uniquely named.
    assert sorted(p.name for p in exports.iterdir()) == ["cut.mp4", "cut.mp4.part"]


async def test_export_refuses_to_replace_an_existing_file_unless_told(engine, tmp_path):
    """An agent's mistyped out_path must not cost the user a file: the CLI
    operator typing --out sees what they typed, an agent's caller does not.
    overwrite=true is the explicit form of the decision."""
    target = tmp_path / "precious.mp4"
    target.write_bytes(b"the user's own bytes")

    async with Client(build(engine, export_dir=tmp_path)) as client:
        project = await call(client, "create_project", {"prompt": "careful"})
        project_id = project["id"]
        started = await call(client, "start_render", {"project_id": project_id})
        await until_done(client, project_id, ignore=started["earlier_failures"])

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
    a stateless protocol by start_render handing out earlier_failures."""
    jobs = [
        {"id": "old", "status": "failed", "spec": {"node_id": "s3.clip"}, "error": "oom"},
        {"id": "mine", "status": "failed", "spec": {"node_id": "s1.clip"}, "error": "boom"},
    ]

    payload = mcp_server.render_status_payload(jobs, export_hash=None, ignore_job_ids=["old"])

    assert [row["node_id"] for row in payload["failed"]] == ["s1.clip"]
    assert payload["done"] is True
    # Named for its population: every job ever, NOT this render — so the
    # filtered `failed` beside it is a different answer, not a contradiction.
    assert payload["history_counts"] == {"failed": 2}
    assert payload["export_ready"] is False


def test_outstanding_rows_carry_the_stall_signal():
    """status+progress, not bare node ids: progress that stops moving across
    polls is the only way an agent can tell a wedged render from a slow one —
    the CLI's bounded --timeout, translated to a stateless poll."""
    payload = mcp_server.render_status_payload(
        [{"id": "j1", "status": "rendering", "progress": 0.4, "spec": {"node_id": "s1.clip"}}],
        export_hash=None,
        ignore_job_ids=[],
    )

    assert payload["done"] is False
    assert payload["outstanding"] == [
        {"node_id": "s1.clip", "status": "rendering", "progress": 0.4}
    ]


def test_a_settled_render_reports_its_cut():
    payload = mcp_server.render_status_payload([], export_hash="c" * 64, ignore_job_ids=[])

    assert payload["export_ready"] is True
    assert payload["export_hash"] == "c" * 64


def test_a_mid_render_poll_never_reports_the_previous_cut_as_ready():
    """Re-rendering a project that already exported once: the OLD cut's
    hash is still on the board while new jobs are queued. Reporting it
    ready is an agent promising the user a file that is the previous
    render. The tool's board-fetch skip happens to avoid asking mid-render,
    but that skip is a cost decision - the guarantee has to live here, or
    relaxing the skip silently reintroduces the lie."""
    payload = mcp_server.render_status_payload(
        [{"id": "j1", "status": "queued", "spec": {"node_id": "s1.clip"}}],
        export_hash="c" * 64,
        ignore_job_ids=[],
    )

    assert payload["export_ready"] is False
    assert payload["export_hash"] is None


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
        "approve",
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
    spend" the route's own guard exists to prevent. And apply_edit's scope
    and revision are REQUIRED: optional, the stale-plan check was silently
    skipped and a scene-scoped preview could re-validate at project scope."""
    async with Client(build(engine)) as client:
        schemas = {tool.name: tool.input_schema for tool in (await client.list_tools()).tools}

    assert "model" not in schemas["edit_project"]["properties"]
    assert schemas["edit_project"]["properties"]["dry_run"]["default"] is True
    assert {"project_id", "plan", "scope", "revision"} <= set(schemas["apply_edit"]["required"])


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
    from localcut_engine import cli
    from localcut_engine import mcp_server as mcp_module

    seen: dict = {}

    class FakeServer:
        def run(self, transport):
            seen["transport"] = transport

    def fake_build(url, token, cert=None, export_dir=None):
        seen.update(url=url, token=token, cert=cert, export_dir=export_dir)
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
        "export_dir": None,
    }
