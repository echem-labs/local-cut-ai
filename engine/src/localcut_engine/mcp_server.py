"""Serving the engine to MCP agents.

Phase 3's ecosystem follow-on to CLI automation: `localcut-engine mcp` speaks
Model Context Protocol over stdio to an agent host (a chat assistant, goose,
an IDE) and the engine's HTTP API on the other side. Like automation.py,
this is a *client* of a running engine, never a second way into its data
directory — which is what keeps every doc 02 topology working: the same
tools drive the engine the desktop spawned, a GPU box over pinned TLS, or a
container in CI.

Being a client also means an agent's mutations arrive where everyone else's
do. A natural-language edit compiles server-side into ordinary /patch ops,
so the cycle check, the voice-consent gate and the re-plan apply to an agent
exactly as they do to the canvas and the inspector.

Exports are the one thing that leaves that HTTP boundary: export_video
writes a file on the machine running THIS process, and `_export_destination`
is where that is bounded to a single directory. An `out_path` is a
model-authored string, so unconfined it is an arbitrary file write.

What is deliberately NOT reachable here, and must stay that way:
  - enabling ComfyUI node packs: that acknowledges third-party code
    execution (doc 07 risk 9), which is an operator's decision to make, not
    a model's;
  - spending the user's BYOK provider keys. Note what this does and does
    not promise: an agent cannot CHOOSE cloud, but it can still cause a
    node the user ALREADY put on a cloud model to re-render — that is the
    user's own standing decision, and `final=true` likewise uses whatever
    finalize model the engine is configured with. The enforcement is
    server-side: every request carries NO_CLOUD_SPEND, and the engine
    refuses to queue a billable job for such a caller, at the queue rather
    than at any route. Three client-side gates leaked before that (a
    set_model op, then select_take restoring a recorded cloud identity,
    then undo restoring a snapshot), which is why the rule now names the
    outcome instead of the routes;
  - model downloads/deletes and project deletion: operator surfaces, served
    by the app and the CLI.
(test_mcp.py holds the toolset to this.)

Tools return the engine's own JSON documents as structured content. Return
annotations must stay `dict[str, Any]` — a bare `dict` silently turns
structured output off in the SDK, leaving agents to re-parse prose.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

import httpx
from mcp.server import MCPServer

from . import __version__, automation
from .automation import DEFAULT_ENGINE_URL, EngineClient, EngineError
from .project.store import PROJECT_ID_PATTERN

# The engine's own definition of a project id, checked with fullmatch (the
# repo rule for $-anchored patterns shared with pydantic path params). An
# allow-list, NOT a character deny-list: tool inputs come from a model, and
# the deny-list route was beaten twice in one afternoon — httpx removes dot
# segments when merging URLs (a project_id of "." slid get_project onto the
# LIST route, ".." onto the server root), and DEL or a lone surrogate died
# inside httpx instead of being refused. Matching the server's pattern
# refuses the whole class at once and cannot drift from what the routes
# accept.
_PROJECT_ID = re.compile(PROJECT_ID_PATTERN)

# An interactive /edit runs a local LLM round trip that can take minutes on
# the same GPU a render is using — but only the READ needs that patience.
# The connect timeout stays short, so an engine that is unreachable at the
# TCP level reports itself in seconds here exactly like in every other
# tool. Known limitation, accepted: the SDK runs sync tools in a worker
# thread that cancellation cannot unwind, so an in-flight edit pins
# cancellation/shutdown until this read timeout expires; lifting that needs
# an async EngineClient, a change of its own.
_EDIT_TIMEOUT = httpx.Timeout(600.0, connect=30.0)

# Where export_video may write when nothing else is configured. Under the
# home directory rather than the process cwd: an agent host spawns this
# server from wherever it happens to be, and "next to whatever the host was
# doing" is not somewhere a user can find their video - nor somewhere it is
# safe to write.
DEFAULT_EXPORT_DIR = Path.home() / "LocalCut"

# Sent on every request this server makes. The engine refuses to queue a job
# that would render on a cloud model for a caller carrying it, at the queue
# itself - so the guarantee covers routes this module does not know about,
# which is what three rounds of client-side gating failed to do (set_model,
# then select_take restoring a recorded cloud identity, then undo restoring
# a whole snapshot). What survives on this side is the cheap op scan below,
# which keeps a cloud model from being written onto the graph at all.
NO_CLOUD_SPEND = {"X-LocalCut-Cloud-Spend": "deny"}

_INSTRUCTIONS = """LocalCut turns a prompt or a script into a finished video \
(clips, narration, music, captions) on the user's own GPU.

Typical flow: create_project -> get_project (the scene board) -> start_render \
-> poll render_status until done (pass start_render's earlier_failures as \
ignore_job_ids, or failures from past renders are blamed on this one) -> \
export_video. Renders take real GPU time - minutes per clip on consumer \
hardware - so poll between other work. Compare outstanding[].progress across \
polls to spot a stalled render; cancel_render stops one. done only means \
nothing is queued: a never-rendered or checkpoint-gated project is also \
"done", so read export_ready before promising a file. export_video writes \
only inside the export directory engine_info reports.

If a tool says it cannot reach the engine, the fix is in this MCP server's \
own configuration (the command and environment your host launches it with, \
and whether `localcut-engine serve` is running) - the message names CLI \
flags, which are not something you can pass.

mode="beginner" projects pause at the script and storyboard checkpoints for \
the user's review (get_project shows what to review); release each with \
approve.

To change a project, prefer edit_project (natural language). It previews by \
default: show the user the returned plan, then land it with apply_edit, \
passing plan, scope and revision exactly as edit_project returned them. \
Applying re-renders the scenes it dirtied, so poll render_status afterwards \
too. patch_project takes raw graph ops for precise changes; get_graph shows \
the node ids and params they target. undo/redo revert applied edits."""


def _project_id(value: str) -> str:
    """A model-supplied project id, or a refusal with a sentence.

    Every tool validates BEFORE its first request — including ids bound for
    a query parameter: /jobs treats an empty project_id as "no filter", so
    an unvalidated "" would fabricate a status document out of other
    projects' jobs instead of refusing. (The automation CLI does not need
    this: its ids come from the operator's own argv.)
    """
    if not isinstance(value, str) or _PROJECT_ID.fullmatch(value) is None:
        raise EngineError(f"not a project id: {value!r}")
    return value


# Written as an escape, not the character: every string literal in this
# module has to stay ASCII (test_cli.py::test_every_string_the_cli_can_print
# _is_ascii covers it, because these sentences reach a console).
_BOM = chr(0xFEFF)


def _job_id(value: Any) -> str:
    """A job id from the engine's own /jobs answer, on its way back into a
    request path. Engine-derived rather than model-authored, but it is
    interpolated into a URL all the same, so it gets the same shape check
    the ids an agent supplies get."""
    text = str(value)
    if not text or not text.isalnum():
        raise EngineError(f"not a job id: {value!r}")
    return text


def _is_cloud_model(value: Any) -> bool:
    """Would this model string route to a paid provider?

    Normalized before the prefix test, deliberately stricter than the
    engine's own exact `startswith("cloud:")`: " CLOUD:veo" does not reach a
    provider today, but it persists onto the node, and the day any
    normalization appears on the routing side it becomes real spend. A
    refusal here costs nothing; agreeing with a bug does not.
    """
    if not isinstance(value, str):
        return False
    return value.strip().strip(_BOM).strip().casefold().startswith("cloud:")


def _refuse_cloud_models(ops: list[dict[str, Any]]) -> None:
    """The BYOK line, held for raw ops.

    edit_project deliberately does not forward /edit's cloud `model` field;
    a set_model op (or an add_node carrying a model) reaches the same spend
    one tool down, so the same refusal applies here. Local models pass —
    they are the user's own GPU.

    `select_take` carries no model and is checked by the caller instead: the
    identity it restores lives in takes.json, so only the engine's own board
    can say whether it is a cloud one.
    """
    for op in ops:
        if not isinstance(op, dict):
            continue
        node = op.get("node") if isinstance(op.get("node"), dict) else {}
        for model in (op.get("model"), node.get("model")):
            if _is_cloud_model(model):
                raise EngineError(
                    f"{model}: choosing a cloud model spends the user's provider key - "
                    "that is a per-request decision made in the app, not over MCP"
                )


def _export_destination(out_path: str, root: Path, *, overwrite: bool) -> Path:
    """Where export_video is allowed to write, or a refusal.

    `out_path` is a model-authored string and the bytes land on the machine
    running THIS process (the agent host, not necessarily the engine's), so
    an unconfined path is an arbitrary file write: pointed at the engine's
    own project.json it silently empties a project, and nothing in the
    toolset can undo that. Everything is therefore resolved inside one
    export root - a relative path against it rather than against whatever
    cwd the agent host happened to spawn us with, and an absolute path only
    if it lands inside. Resolving before the containment test is what makes
    a symlink out of the root a refusal rather than a way through it.
    """
    root = root.expanduser()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise EngineError(f"could not create the export directory {root}: {exc}") from exc
    root = root.resolve()
    # `root / candidate` IS candidate when candidate is absolute, so one
    # expression covers both spellings and the check below judges both.
    try:
        destination = (root / Path(out_path).expanduser()).resolve()
    except (RuntimeError, ValueError) as exc:
        # An unknown ~user raises RuntimeError and an embedded NUL raises
        # ValueError - neither is an OSError, so without this the agent gets
        # a stack-flavoured message where every other refusal is a sentence.
        raise EngineError(f"not a usable path: {out_path!r} ({exc})") from exc
    if destination == root:
        # An export names a FILE. Allowed through, this reaches the download
        # with destination.parent one level ABOVE the root, and the scratch
        # file - a whole video - is streamed outside the boundary this
        # function exists to draw before the rename fails on a directory.
        raise EngineError(f"{root} is the export directory itself - name a file inside it")
    if root not in destination.parents:
        raise EngineError(
            f"{destination} is outside the export directory {root} - pass a path inside it, "
            "or start the server with --export-dir to allow somewhere else"
        )
    if destination.exists() and not overwrite:
        raise EngineError(f"{destination} already exists - pass overwrite=true to replace it")
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise EngineError(f"could not create {destination.parent}: {exc}") from exc
    return destination


def render_status_payload(
    jobs: list[dict], *, export_hash: str | None, ignore_job_ids: list[str]
) -> dict[str, Any]:
    """The render answer an agent polls, from one /jobs snapshot.

    `ignore_job_ids` is start_render's earlier_failures, carried by the
    agent because MCP calls share no state: /jobs still lists failures from
    every earlier render (nothing prunes rows; the route returns the newest
    200), so without it one clip that failed weeks ago is reported as a
    failure of every render since.

    A cut is only ready when nothing is outstanding, and that conjunction
    lives HERE rather than in the caller's board-fetch skip: the skip is a
    cost decision (a board build scans the project directory) and would one
    day be relaxed, whereas reporting a stale cut as ready mid-render is an
    agent promising the user a file that is the PREVIOUS render.
    history_counts is named for its population — every job the engine still
    lists for this project, not this render — so it can never read as
    contradicting the filtered `failed` list beside it.
    """
    outstanding = automation.outstanding_jobs(jobs)
    ready = not outstanding and export_hash is not None
    return {
        "done": not outstanding,
        # status+progress, not bare node ids: progress that stops moving
        # across polls is the only signal an agent has that a render is
        # wedged rather than slow — the CLI's --timeout, translated.
        "outstanding": [
            {
                "node_id": (job.get("spec") or {}).get("node_id"),
                "status": str(job.get("status")),
                "progress": job.get("progress") or 0.0,
            }
            for job in outstanding
        ],
        "failed": [
            {
                "id": str(job.get("id")),
                "node_id": (job.get("spec") or {}).get("node_id"),
                "error": job.get("error") or "failed",
            }
            for job in automation.failed_jobs(jobs, not_mine=set(ignore_job_ids))
        ],
        "history_counts": automation.render_summary(jobs),
        "export_ready": ready,
        "export_hash": export_hash if ready else None,
    }


def build_server(
    url: str = DEFAULT_ENGINE_URL,
    token: str = "",
    *,
    cert: Path | None = None,
    export_dir: Path | None = None,
) -> MCPServer:
    """The MCP server for one engine. Tools open a fresh EngineClient per
    call: this process sits idle for hours between an agent's requests, and a
    pooled connection to an engine that restarted in the meantime would
    report a running server as unreachable.

    `export_dir` bounds every file export_video can write (see
    _export_destination); it defaults under the user's home rather than the
    process cwd, which on an agent host is arbitrary."""
    export_root = export_dir or DEFAULT_EXPORT_DIR
    server = MCPServer("localcut", instructions=_INSTRUCTIONS, version=__version__)

    def connect(**kwargs: Any) -> EngineClient:
        """The one construction expression for every client this server
        opens — including the startup probe below, so a construction detail
        added here is validated at startup and used by every tool.

        The cloud-spend header is why this is one expression: it is a
        capability this whole surface gives up, and a per-call opt-in is
        exactly what leaked three times."""
        return EngineClient(url, token, cert=cert, headers=NO_CLOUD_SPEND, **kwargs)

    # Fail at startup on what can never work (a cert pin against http://, a
    # missing PEM) rather than letting every later tool call repeat it.
    connect().close()

    @server.tool()
    def engine_info() -> dict[str, Any]:
        """Engine and API version, hardware profile, backend chain, which
        models this machine can run, and export_dir - the only directory
        export_video may write to. Call once to calibrate expectations
        (render speed, quality tier) before promising results."""
        with connect() as client:
            return {
                # Named here because nothing else can tell the agent where
                # exports may go: without it the only way to learn the root
                # is to trigger a refusal.
                "export_dir": str(export_root),
                **(client.get("/health") or {}),
                **(client.get("/system") or {}),
            }

    @server.tool()
    def list_projects() -> dict[str, Any]:
        """All projects on the engine: id, title, mode, aspect."""
        with connect() as client:
            return {"projects": client.get("/projects") or []}

    @server.tool()
    def create_project(
        prompt: str,
        aspect: str = "9:16",
        duration_s: int = 60,
        # Literal, not str: the allowed values reach the tool's JSON Schema,
        # which is what an agent actually reads - a docstring sentence is
        # advice, a schema is a constraint.
        mode: Literal["prompt", "beginner"] = "prompt",
        style_preset: str | None = None,
    ) -> dict[str, Any]:
        """Create a project from a prompt and return it (including its id).
        mode "prompt" (the default) writes the script and starts draft work
        by itself; mode "beginner" pauses at the script and storyboard
        checkpoints until approve releases them. duration_s is a target -
        the cut's real length follows the narration the script produces."""
        body: dict[str, Any] = {
            "prompt": prompt,
            "aspect": aspect,
            "target_duration_s": duration_s,
            "mode": mode,
        }
        if style_preset is not None:
            body["style_preset"] = style_preset
        with connect() as client:
            return client.post("/projects", json=body)

    @server.tool()
    def get_project(project_id: str) -> dict[str, Any]:
        """A project plus its scene board: per-scene status, artifacts,
        narration, and the export slot. This is what to read before and after
        edits, and what the user reviews at a beginner-mode checkpoint."""
        project_id = _project_id(project_id)
        with connect() as client:
            return client.get(f"/projects/{project_id}")

    @server.tool()
    def get_graph(project_id: str) -> dict[str, Any]:
        """The project's story graph: every node with its id, kind, params,
        pinned state, and the edges between them. Read this before
        patch_project to see what an op would target."""
        project_id = _project_id(project_id)
        with connect() as client:
            return client.get(f"/projects/{project_id}/graph")

    @server.tool()
    def approve(project_id: str, checkpoint: Literal["script", "storyboard"]) -> dict[str, Any]:
        """Release a beginner-mode checkpoint after the user has reviewed it:
        "script" for the screenplay, "storyboard" for the keyframes. Returns
        how many jobs the release enqueued. Without this a beginner project
        waits forever - render_status reads done=true with nothing queued
        and export_ready stays false."""
        project_id = _project_id(project_id)
        with connect() as client:
            return client.post(f"/projects/{project_id}/approve", json={"checkpoint": checkpoint})

    @server.tool()
    def start_render(project_id: str, final: bool = False) -> dict[str, Any]:
        """Enqueue a draft render (or with final=true the final-quality
        pass), then poll render_status.

        `enqueued` counts the jobs THIS call added: 0 is normal and does not
        mean nothing is happening - a project renders as soon as it is
        created, so work is often already queued. render_status is the
        authority on what is outstanding. `earlier_failures` lists job ids
        that had already failed BEFORE this render; keep them and pass them
        to render_status as ignore_job_ids so an old failure is never
        blamed on this one."""
        project_id = _project_id(project_id)
        with connect() as client:
            # Snapshot BEFORE the trigger: taken after, a job of this render
            # that failed instantly would be classified as somebody else's.
            jobs = client.get("/jobs", params={"project_id": project_id}) or []
            earlier = automation.failed_jobs(jobs, not_mine=frozenset())
            action = "finalize" if final else "render"
            result = client.post(f"/projects/{project_id}/{action}") or {}
        return {
            # The POST's own answer — not a third round trip that would
            # re-download the whole /jobs history for a count already sent.
            "enqueued": int(result.get("enqueued") or 0),
            # Failed ids only: they are all render_status ever consults, and
            # the agent re-sends this list on every poll — done/cancelled
            # ids would be unbounded dead weight in its context.
            "earlier_failures": sorted(str(job.get("id")) for job in earlier),
        }

    @server.tool()
    def render_status(project_id: str, ignore_job_ids: list[str] | None = None) -> dict[str, Any]:
        """Where the render stands. done means nothing is queued or running
        - a never-rendered or checkpoint-gated project is also "done" - so
        read export_ready (and get_project) before concluding anything.
        outstanding rows carry status and progress (0..1); progress frozen
        across polls means a stalled render worth telling the user about.
        failed excludes ignore_job_ids - pass start_render's
        earlier_failures; omitted, it lists every failure still on record
        for the project. history_counts likewise counts every job the engine
        still lists (its newest 200), not just this render."""
        project_id = _project_id(project_id)
        with connect() as client:
            jobs = client.get("/jobs", params={"project_id": project_id}) or []
            artifact = None
            if not automation.outstanding_jobs(jobs):
                # The board build scans the project directory; only pay for
                # it when the answer can be "ready" — mid-render it cannot.
                artifact = automation.finished_cut_hash(client, project_id)
        return render_status_payload(
            jobs, export_hash=artifact, ignore_job_ids=ignore_job_ids or []
        )

    @server.tool()
    def cancel_render(project_id: str) -> dict[str, Any]:
        """Stop a render: cancels every job still queued or rendering and
        returns how many were cancelled. "Stop it" is an ordinary request,
        and a render that has stalled (render_status progress frozen) is
        otherwise something an agent can only watch. Cancelling only ever
        reduces work - finished artifacts are content-addressed and kept, so
        a later render reuses them."""
        project_id = _project_id(project_id)
        cancelled = 0
        with connect() as client:
            for job in automation.active_jobs(client, project_id):
                try:
                    client.post(f"/jobs/{_job_id(job.get('id'))}/cancel")
                    cancelled += 1
                except EngineError:
                    # It finished on its own between the list and the
                    # cancel. That is the outcome asked for, not a failure.
                    continue
        return {"cancelled": cancelled}

    @server.tool()
    def edit_project(
        project_id: str, instruction: str, scope: str = "project", dry_run: bool = True
    ) -> dict[str, Any]:
        """Edit the project in natural language ("make scene 2 slower and
        mute the music"). Previews by default: the response carries the
        compiled plan, the scope, and the revision it was built against -
        show the user, then land it with apply_edit passing all three back
        exactly as returned. Set dry_run=false only when the user has
        already seen the change, because applying re-renders dirtied scenes
        on real GPU time. scope narrows the edit to one scene id."""
        project_id = _project_id(project_id)
        body = {"instruction": instruction, "scope": scope, "dry_run": dry_run}
        with connect(timeout=_EDIT_TIMEOUT) as client:
            result = client.post(f"/projects/{project_id}/edit", json=body)
        # Echo the scope: apply_edit needs plan, scope AND revision exactly
        # as previewed (the plan re-validates differently per scope), and
        # the engine's response carries only the other two.
        return {**(result or {}), "scope": scope}

    @server.tool()
    def apply_edit(
        project_id: str, plan: dict[str, Any], scope: str, revision: str
    ) -> dict[str, Any]:
        """Land a plan a dry-run edit_project returned, without a second LLM
        round trip. plan, scope and revision must be passed exactly as
        edit_project returned them, and the latter two are required on
        purpose: the plan re-validates against the scope (a remove_scene
        refused in a scene-scoped preview would APPLY at project scope), and
        the revision is the stale-plan refusal - if the graph moved since
        the preview, the apply is rejected instead of landing on content the
        model never saw."""
        project_id = _project_id(project_id)
        body = {"plan": plan, "scope": scope, "revision": revision}
        with connect() as client:
            return client.post(f"/projects/{project_id}/edit/apply", json=body)

    @server.tool()
    def patch_project(project_id: str, ops: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply raw graph ops (set_params, set_seed, set_model, pin, unpin,
        add_node, remove_node, connect, disconnect, select_take, add_scene)
        and return the dirtied node ids. This is the same validated /patch
        every other client uses: cycles are refused, and voice_ref accepts
        only a consented voice sample. Ops naming a cloud:* model are
        refused here - cloud spend is the user's decision, made in the app -
        and so is a select_take that would restore one."""
        project_id = _project_id(project_id)
        _refuse_cloud_models(ops)
        with connect() as client:
            return client.post(f"/projects/{project_id}/patch", json={"ops": ops})

    @server.tool()
    def undo(project_id: str) -> dict[str, Any]:
        """Revert the most recent graph edit. Re-renders nothing that already
        existed: prior artifacts are content-addressed and still cached."""
        project_id = _project_id(project_id)
        with connect() as client:
            return client.post(f"/projects/{project_id}/undo")

    @server.tool()
    def redo(project_id: str) -> dict[str, Any]:
        """Re-apply the edit the last undo reverted."""
        project_id = _project_id(project_id)
        with connect() as client:
            return client.post(f"/projects/{project_id}/redo")

    @server.tool()
    def project_history(project_id: str) -> dict[str, Any]:
        """Undo/redo stack depths, what the next undo or redo would change,
        and the save points. Read this before undoing blind."""
        project_id = _project_id(project_id)
        with connect() as client:
            return client.get(f"/projects/{project_id}/history")

    @server.tool()
    def export_video(
        project_id: str,
        out_path: str,
        format: Literal["mp4", "otio", "fcpxml"] = "mp4",
        overwrite: bool = False,
    ) -> dict[str, Any]:
        """Write the finished cut (mp4) or an NLE handoff (otio, fcpxml) to a
        file. Returns the resolved path and bytes written; mp4 requires a
        completed render. out_path is taken relative to the server's export
        directory and cannot leave it, and an existing file is replaced only
        with overwrite=true - a mistyped path must not cost the user a file,
        and unlike the CLI's --out there is no operator watching."""
        project_id = _project_id(project_id)
        destination = _export_destination(out_path, export_root, overwrite=overwrite)
        with connect() as client:
            if format in ("otio", "fcpxml"):
                written = client.download(f"/projects/{project_id}/export/{format}", destination)
            elif format == "mp4":
                artifact = automation.finished_cut_hash(client, project_id)
                if artifact is None:
                    raise EngineError(
                        "this project has no finished cut yet - call start_render, poll "
                        "render_status until it reports export_ready, then export"
                    )
                written = client.download(
                    f"/projects/{project_id}/artifacts/{artifact}", destination
                )
            # No `else`: the Literal above is what makes these two branches
            # exhaustive, and the SDK rejects anything else against the
            # schema before the tool is ever entered.
        return {"path": str(destination), "bytes": written}

    return server
