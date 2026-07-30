"""Serving the engine to MCP agents.

Phase 3's ecosystem follow-on to CLI automation: `localcut-engine mcp` speaks
Model Context Protocol over stdio to an agent host (Claude, goose, an IDE)
and the engine's HTTP API on the other side. Like automation.py, this is a
*client* of a running engine, never a second way into its data directory —
which is what keeps every doc 02 topology working: the same tools drive the
engine the desktop spawned, a GPU box over pinned TLS, or a container in CI.

Being a client also means an agent's mutations arrive where everyone else's
do. A natural-language edit compiles server-side into ordinary /patch ops,
so the cycle check, the voice-consent gate and the re-plan apply to an agent
exactly as they do to the canvas and the inspector.

What is deliberately NOT a tool here, and must stay that way:
  - enabling ComfyUI node packs: that acknowledges third-party code
    execution (doc 07 risk 9), which is an operator's decision to make, not
    a model's;
  - provider keys, and the cloud `model` field /edit accepts: an agent
    choosing to spend the user's BYOK key is exactly the "silently spend"
    that field's per-request opt-in exists to prevent;
  - model downloads/deletes and project deletion: operator surfaces, served
    by the app and the CLI.
(test_mcp.py holds the toolset to this.)

Tools return the engine's own JSON documents as structured content. Return
annotations must stay `dict[str, Any]` — a bare `dict` silently turns
structured output off in the SDK, leaving agents to re-parse prose.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mcp.server import MCPServer

from . import __version__, automation
from .automation import DEFAULT_ENGINE_URL, EngineClient, EngineError

# An interactive /edit runs a local LLM round trip that can take minutes on
# the same GPU a render is using; the default client timeout would cut it
# off mid-generation and report a transport error for a working engine.
_EDIT_TIMEOUT_S = 600.0

_INSTRUCTIONS = """LocalCut turns a prompt or a script into a finished video \
(clips, narration, music, captions) on the user's own GPU.

Typical flow: create_project -> get_project (the scene board) -> start_render \
-> poll render_status until done (pass start_render's settled_before as \
ignore_job_ids, or old failures count against this render) -> export_video.

Renders take real GPU time: minutes per clip on consumer hardware. Never wait \
inside a call; poll render_status between other work.

To change a project, prefer edit_project (natural language). It previews by \
default: read the returned plan, then land it with apply_edit. patch_project \
takes raw graph ops for precise changes; get_graph shows the node ids and \
params they target. undo/redo revert applied edits."""


def render_status_payload(
    jobs: list[dict], *, export_hash: str | None, ignore_job_ids: list[str]
) -> dict[str, Any]:
    """The render answer an agent polls, from one /jobs snapshot.

    `ignore_job_ids` is start_render's settled_before, carried by the agent
    because MCP calls share no state: /jobs is the project's whole history —
    nothing deletes rows — so without it one clip that failed weeks ago is
    reported as a failure of every render since.
    """
    outstanding = automation._outstanding(jobs)
    ignored = set(ignore_job_ids)
    failed = [
        {
            "id": str(job.get("id")),
            "node_id": (job.get("spec") or {}).get("node_id"),
            "error": job.get("error") or "failed",
        }
        for job in jobs
        if str(job.get("status")) == "failed" and str(job.get("id")) not in ignored
    ]
    return {
        "done": not outstanding,
        "counts": automation.render_summary(jobs),
        "outstanding": [(job.get("spec") or {}).get("node_id") for job in outstanding],
        "failed": failed,
        "export_ready": not outstanding and export_hash is not None,
        "export_hash": export_hash if not outstanding else None,
    }


def build_server(
    url: str = DEFAULT_ENGINE_URL, token: str = "", *, cert: Path | None = None
) -> MCPServer:
    """The MCP server for one engine. Tools open a fresh EngineClient per
    call: this process sits idle for hours between an agent's requests, and a
    pooled connection to an engine that restarted in the meantime would
    report a running server as unreachable."""
    # Fail at startup on what can never work (a cert pin against http://, a
    # missing PEM) rather than letting every later tool call repeat it.
    EngineClient(url, token, cert=cert).close()

    server = MCPServer("localcut", instructions=_INSTRUCTIONS, version=__version__)

    def connect(timeout: float = 30.0) -> EngineClient:
        return EngineClient(url, token, cert=cert, timeout=timeout)

    @server.tool()
    def engine_info() -> dict[str, Any]:
        """Engine and API version, hardware profile, backend chain, and which
        models this machine can run. Call once to calibrate expectations
        (render speed, quality tier) before promising results."""
        with connect() as client:
            return {**(client.get("/health") or {}), **(client.get("/system") or {})}

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
        mode: str = "prompt",
        style_preset: str | None = None,
    ) -> dict[str, Any]:
        """Create a project from a prompt and return it (including its id).
        The engine writes a script, expands scenes and starts draft work by
        itself; follow with render_status. duration_s is a target - the cut's
        real length follows the narration the script produces."""
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
        edits."""
        with connect() as client:
            return client.get(f"/projects/{project_id}")

    @server.tool()
    def get_graph(project_id: str) -> dict[str, Any]:
        """The project's story graph: every node with its id, kind, params,
        pinned state, and the edges between them. Read this before
        patch_project to see what an op would target."""
        with connect() as client:
            return client.get(f"/projects/{project_id}/graph")

    @server.tool()
    def start_render(project_id: str, final: bool = False) -> dict[str, Any]:
        """Enqueue a draft render (or the final-quality pass) and return
        immediately with the pending job count. Keep settled_before and pass
        it to render_status as ignore_job_ids, so failures from earlier
        renders are not blamed on this one. Then poll render_status."""
        with connect() as client:
            # BEFORE the trigger: taken after, a job of this render that
            # failed instantly would be classified as somebody else's.
            settled = automation.settled_jobs(client, project_id)
            action = "finalize" if final else "render"
            client.post(f"/projects/{project_id}/{action}")
            pending = automation.active_jobs(client, project_id)
        return {"pending": len(pending), "settled_before": sorted(settled)}

    @server.tool()
    def render_status(project_id: str, ignore_job_ids: list[str] | None = None) -> dict[str, Any]:
        """Where the render stands: done, job counts by status, outstanding
        node ids, failures (minus ignore_job_ids - pass start_render's
        settled_before), and whether a finished cut is ready to export."""
        with connect() as client:
            jobs = client.get("/jobs", params={"project_id": project_id}) or []
            # The board build scans the project directory; only pay for it
            # when the answer can be "ready" - mid-render it cannot.
            artifact = None
            if not automation._outstanding(jobs):
                board = (client.get(f"/projects/{project_id}") or {}).get("board") or {}
                artifact = automation.export_hash(board)
        return render_status_payload(
            jobs, export_hash=artifact, ignore_job_ids=ignore_job_ids or []
        )

    @server.tool()
    def edit_project(
        project_id: str, instruction: str, scope: str = "project", dry_run: bool = True
    ) -> dict[str, Any]:
        """Edit the project in natural language ("make scene 2 slower and
        mute the music"). Previews by default: the response carries the
        compiled plan and the revision it was built against - read it, then
        land it with apply_edit. Set dry_run=false only when the user has
        already seen the change, because applying re-renders dirtied scenes
        on real GPU time. scope narrows the edit to one scene id."""
        body = {"instruction": instruction, "scope": scope, "dry_run": dry_run}
        with connect(timeout=_EDIT_TIMEOUT_S) as client:
            return client.post(f"/projects/{project_id}/edit", json=body)

    @server.tool()
    def apply_edit(
        project_id: str,
        plan: dict[str, Any],
        scope: str = "project",
        revision: str | None = None,
    ) -> dict[str, Any]:
        """Land a plan a dry-run edit_project returned, without a second LLM
        round trip. Pass the plan and revision exactly as returned; a stale
        revision is refused if the graph moved in between."""
        body = {"plan": plan, "scope": scope, "revision": revision}
        with connect() as client:
            return client.post(f"/projects/{project_id}/edit/apply", json=body)

    @server.tool()
    def patch_project(project_id: str, ops: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply raw graph ops (set_params, set_seed, set_model, pin, unpin,
        add_node, remove_node, connect, disconnect, select_take, add_scene)
        and return the dirtied node ids. This is the same validated /patch
        every other client uses: cycles are refused, and voice_ref accepts
        only a consented voice sample."""
        with connect() as client:
            return client.post(f"/projects/{project_id}/patch", json={"ops": ops})

    @server.tool()
    def undo(project_id: str) -> dict[str, Any]:
        """Revert the most recent graph edit. Re-renders nothing that already
        existed: prior artifacts are content-addressed and still cached."""
        with connect() as client:
            return client.post(f"/projects/{project_id}/undo")

    @server.tool()
    def redo(project_id: str) -> dict[str, Any]:
        """Re-apply the edit the last undo reverted."""
        with connect() as client:
            return client.post(f"/projects/{project_id}/redo")

    @server.tool()
    def project_history(project_id: str) -> dict[str, Any]:
        """Undo/redo stack depths, what the next undo or redo would change,
        and the save points. Read this before undoing blind."""
        with connect() as client:
            return client.get(f"/projects/{project_id}/history")

    @server.tool()
    def export_video(project_id: str, out_path: str, format: str = "mp4") -> dict[str, Any]:
        """Write the finished cut (mp4) or an NLE handoff (otio, fcpxml) to a
        file on this machine. Returns the resolved path and bytes written.
        mp4 requires a completed render."""
        destination = Path(out_path).expanduser().resolve()
        with connect() as client:
            if format in ("otio", "fcpxml"):
                written = client.download(f"/projects/{project_id}/export/{format}", destination)
            elif format == "mp4":
                board = (client.get(f"/projects/{project_id}") or {}).get("board") or {}
                artifact = automation.export_hash(board)
                if artifact is None:
                    raise EngineError(
                        "this project has no finished cut yet - call start_render, poll "
                        "render_status until it reports export_ready, then export"
                    )
                written = client.download(
                    f"/projects/{project_id}/artifacts/{artifact}", destination
                )
            else:
                raise EngineError(f"unknown format: {format} (use mp4, otio or fcpxml)")
        return {"path": str(destination), "bytes": written}

    return server
