"""CLI: `localcut serve` — the one engine binary with three homes:
auto-spawned locally by the app, headless on a GPU box, or hosted.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import uvicorn

from . import __version__
from .config import EngineConfig

#: The words `serve` leads with when it could not claim the port.
#:
#: The desktop reads this off the engine's stderr (engine.ts, BIND_REFUSED) to
#: tell "the port is not free yet" from "the engine died for some other
#: reason" — the first is worth waiting out, the second is not. Nothing
#: reconciles the two spellings at build time, so `test_ui_contract.py` does.
BIND_REFUSED = "cannot bind "


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="localcut")
    parser.add_argument("--version", action="version", version=__version__)
    subcommands = parser.add_subparsers(dest="command", required=True)

    serve = subcommands.add_parser("serve", help="run the engine API server")
    serve.add_argument(
        "--host",
        default=None,
        help="bind address (default 127.0.0.1; non-localhost requires an explicit --token)",
    )
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--token", default=None, help="pairing token (generated if omitted)")
    serve.add_argument("--data-dir", default=None)
    serve.add_argument(
        "--backend",
        default=None,
        help="backend chain, comma-separated; first match per node kind wins "
        "(e.g. 'mock', 'local', 'llm,comfy,mock')",
    )
    serve.add_argument(
        "--announce-fd3",
        action="store_true",
        help="write the connection info JSON to fd 3 (used by the desktop shell)",
    )
    serve.add_argument(
        "--no-tls",
        action="store_true",
        help="serve plain HTTP on a network bind (only sensible inside a "
        "VPN/tailnet that already encrypts the link)",
    )

    probe = subcommands.add_parser("probe", help="print the hardware profile and exit")
    del probe

    models = subcommands.add_parser("models", help="list manifest models and download status")
    models.add_argument("--models-dir", default=None)

    download = subcommands.add_parser("download", help="download a model's weights by manifest id")
    download.add_argument("model_id")
    download.add_argument("--models-dir", default=None)

    mcp = subcommands.add_parser(
        "mcp",
        help="serve this engine's projects to MCP agents over stdio "
        "(configure the agent host to run this command)",
    )
    mcp.add_argument(
        "--export-dir",
        default=None,
        help="directory export_video may write into, and the root its paths resolve against "
        "(default $LOCALCUT_MCP_EXPORT_DIR, else ~/LocalCut)",
    )
    _add_connection_flags(mcp)

    _add_automation_commands(subcommands)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    _survive_console_encoding()

    if args.command == "mcp":
        return _mcp_command(args)

    if args.command == "probe":
        from .hardware.probe import probe_hardware

        config = EngineConfig.from_env()
        config.data_dir.mkdir(parents=True, exist_ok=True)
        print(probe_hardware(str(config.data_dir)).model_dump_json(indent=2))
        return 0

    if args.command in ("models", "download"):
        return _models_command(args)

    if args.command in _AUTOMATION_COMMANDS:
        return _automation_command(args)

    overrides = {
        key: value
        for key, value in {
            "host": args.host,
            "port": args.port,
            "token": args.token,
            "data_dir": args.data_dir,
            "backend": args.backend,
        }.items()
        if value is not None
    }
    config = EngineConfig(**{**EngineConfig.from_env().model_dump(), **overrides})

    network_bind = config.host not in ("127.0.0.1", "localhost", "::1")
    # bool(), not `is not None`: an empty --token/LOCALCUT_TOKEN must count as
    # unconfigured, otherwise `--token ""` binds to the LAN with an empty
    # secret that compare_digest("","") accepts from any client.
    token_configured = bool(args.token) or bool(os.environ.get("LOCALCUT_TOKEN"))
    if network_bind and not token_configured:
        parser.error(
            "network bind requires an explicit --token (pairing); "
            "see the docs for remote-engine setup"
        )

    # Remote engine mode: non-localhost serves HTTPS with a self-signed,
    # fingerprint-pinned certificate (generated once under the data dir).
    ssl_args: dict = {}
    fingerprint: str | None = None
    if network_bind and not args.no_tls:
        from .tls import ensure_certificate

        config.data_dir.mkdir(parents=True, exist_ok=True)
        cert_path, key_path, fingerprint = ensure_certificate(
            config.data_dir / "tls", [config.host]
        )
        ssl_args = {"ssl_certfile": str(cert_path), "ssl_keyfile": str(key_path)}

    scheme = "https" if ssl_args else "http"

    # Claim the port BEFORE anything with side effects runs.
    #
    # create_app() builds the JobQueue, whose __init__ recovers interrupted
    # jobs by flipping every RENDERING row back to QUEUED. Passing
    # create_app(config) as an *argument* to uvicorn.run evaluated it before
    # the bind that fails on a port clash — so a second engine that was about
    # to exit with "address in use" had already resurrected the first
    # engine's in-flight job, and both then rendered it. Binding first turns
    # that into a clean exit that touches nothing.
    try:
        sockets = [_bind(config.host, config.port)]
    except OSError as exc:
        print(
            f"{BIND_REFUSED}{config.host}:{config.port}: {exc}\n"
            "Another engine is probably already running - quit it, or pass a different --port.",
            file=sys.stderr,
        )
        return 1

    connection_info = json.dumps({"host": config.host, "port": config.port, "token": config.token})
    if args.announce_fd3:
        try:
            os.write(3, (connection_info + "\n").encode())
        except OSError:
            print(connection_info, flush=True)
    else:
        print(f"LOCALCUT_ENGINE {connection_info}", flush=True)
    if network_bind:
        _print_pairing(scheme, config.host, config.port, config.token, fingerprint)

    from .api.app import create_app, install_log_redaction

    # access_log=False drops the HTTP request lines, but uvicorn logs the
    # WebSocket handshake path on `uvicorn.error`, which it does NOT silence —
    # so a client still using ?token= would write the live token to the log.
    install_log_redaction()
    config_kwargs = dict(
        host=config.host, port=config.port, log_level="info", access_log=False, **ssl_args
    )
    uvicorn_config = uvicorn.Config(create_app(config), **config_kwargs)
    # Again, now that uvicorn has installed its own handlers: a filter on a
    # Logger only sees records logged directly to it, so the handlers are
    # what covers uvicorn's child loggers.
    install_log_redaction()
    server = uvicorn.Server(uvicorn_config)
    server.run(sockets=sockets)
    return 0


def _survive_console_encoding() -> None:
    """Never let the console's code page be fatal.

    A Windows console (and a piped stdout, which uses the ANSI code page)
    defaults to cp1252, which cannot encode the arrow in the pairing block —
    so `print()` raised UnicodeEncodeError and killed the engine at startup,
    before uvicorn ever ran, on exactly the network bind the block exists to
    document. The operator saw a traceback about a charmap codec instead of a
    running engine. Degrade the un-encodable character, never the process.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")  # type: ignore[union-attr]
        except (AttributeError, OSError, ValueError):
            pass  # not a text stream we can retune — nothing to do


def _bind(host: str, port: int) -> socket.socket:
    """A listening socket for (host, port), or OSError. Handed to uvicorn so
    the bind happens before the app (and its job-queue recovery) is built."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        # No SO_REUSEADDR: a clashing engine must fail here, which is the
        # whole point. (On Windows SO_REUSEADDR would even let two sockets
        # share the port outright.)
        sock.bind((host, port))
        sock.listen(2048)
        sock.set_inheritable(True)
    except OSError:
        sock.close()
        raise
    return sock


def _lan_address(bind_host: str) -> str:
    """The address a laptop should dial: a bind-all host advertises the
    machine's primary outbound interface, best-effort."""
    if bind_host not in ("0.0.0.0", "::"):
        return bind_host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 1))  # TEST-NET: no packets actually sent
            return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def _print_pairing(scheme: str, host: str, port: int, token: str, fingerprint: str | None) -> None:
    """The block a user copies to the frontend: human-readable connection
    facts plus a single base64url pairing code carrying all of them.

    ASCII only, deliberately. This block exists for the headless deployment —
    stdout piped to a service manager or a log file — where Windows encodes
    with the ANSI code page rather than UTF-8. `_survive_console_encoding`
    keeps an un-encodable character from killing the engine, but it degrades
    it to a `\\uXXXX` escape, and this is the one instruction the operator has
    to be able to read. Say "Settings > Remote engine", not "Settings →",
    so it renders on every console instead of surviving on most of them.
    """
    import base64

    url = f"{scheme}://{_lan_address(host)}:{port}"
    payload: dict = {"url": url, "token": token}
    if fingerprint:
        payload["fingerprint"] = fingerprint
    code = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    headline = (
        "Remote engine ready - pair from Settings > Remote engine:"
        if fingerprint
        else "Remote engine ready (cleartext http - TLS disabled):"
    )
    lines = ["", headline, f"  url:          {url}"]
    if fingerprint:
        pretty = ":".join(fingerprint[i : i + 2] for i in range(0, len(fingerprint), 2))
        lines.append(f"  fingerprint:  {pretty}")
    lines += [f"  pairing code: {code}", ""]
    if not fingerprint:
        # --no-tls. The desktop app refuses a cleartext pairing to anything
        # but loopback (remote.ts parsePairingCode): the bearer token and
        # every provider key would ride unencrypted with no pin to stop a
        # MITM. Say so here rather than printing an instruction that ends in
        # "a remote engine must use https" with no explanation.
        lines += [
            "  NOTE: TLS is off, so the desktop app will REFUSE this pairing code.",
            "  Drop --no-tls to pair from the app, or reach this engine over an SSH",
            "  tunnel (the app accepts http:// only to localhost) / from an API client.",
            "",
        ]
    print("\n".join(lines), flush=True)


def _models_command(args: argparse.Namespace) -> int:
    import asyncio

    from .manifest.downloads import DownloadError, download_model, is_downloaded
    from .manifest.loader import load_manifest

    config = EngineConfig.from_env()
    manifest = load_manifest(config)
    models_dir = Path(args.models_dir) if args.models_dir else config.resolved_models_dir

    if args.command == "models":
        for entry in manifest.models:
            status = (
                "downloaded"
                if is_downloaded(entry, models_dir)
                else ("available" if entry.files else "no-files")
            )
            print(f"{entry.id:32} {entry.task:12} {entry.license.id:12} {status}")
        return 0

    entry = next((m for m in manifest.models if m.id == args.model_id), None)
    if entry is None:
        print(f"unknown model id: {args.model_id}", file=sys.stderr)
        return 1

    async def report(dest: str, done: int, total: int) -> None:
        if total and done % (256 << 20) < (1 << 20):  # ~every 256 MB
            print(f"  {dest}: {done / 2**30:.2f} / {total / 2**30:.2f} GiB", flush=True)

    try:
        paths = asyncio.run(download_model(entry, models_dir, progress=report))
    except DownloadError as exc:
        print(f"download failed: {exc}", file=sys.stderr)
        return 1
    for path in paths:
        print(f"ok: {path}")
    return 0


def _mcp_command(args: argparse.Namespace) -> int:
    """`localcut mcp` - an MCP stdio server that is a client of a
    running engine, exactly as the automation commands are (see
    mcp_server.py). stdout belongs to the protocol from here on; everything
    human-readable, including logging, goes to stderr."""
    from .automation import EngineError, fail
    from .mcp_server import build_server

    url, token, cert = _resolve_connection(args)
    export_dir = args.export_dir or os.environ.get("LOCALCUT_MCP_EXPORT_DIR")
    try:
        server = build_server(
            url, token, cert=cert, export_dir=Path(export_dir) if export_dir else None
        )
    except EngineError as exc:
        # Only what can never work fails here (--cert against http://, a
        # missing PEM), so this is exit 1 in practice - but pass the flag
        # through rather than relying on that, so the 0/1/2 contract stays
        # true by construction if build_server ever reaches the network.
        return fail(str(exc), unreachable=exc.unreachable)
    try:
        server.run(transport="stdio")
    except KeyboardInterrupt:
        # A foreground server interrupted at the terminal is a shutdown, not
        # a failed operation - same contract `serve` has under uvicorn.
        pass
    return 0


# -- automation: a client of the headless engine (Phase 3) -------------------
#
# Every command here talks HTTP to a running engine rather than opening the
# data directory. See automation.py for why that is not merely tidier.

# One list, used both to route into the automation path and to dispatch
# within it. Written three times (parser registration, this gate, and a
# `match` in the dispatcher) it had two silent failure modes: a command
# missing here falls through to the `serve` branch below and dies reading
# `args.host`, which the automation subparsers deliberately never define;
# a command missing from the dispatcher exits 1 with no output. Neither
# failed a test or a type check.
# The dispatch table itself is built at the bottom of this section, from the
# functions it names — see _AUTOMATION_COMMANDS there.


def _add_connection_flags(parser: argparse.ArgumentParser) -> None:
    """Where to find the engine. Env defaults so a CI job sets them once.

    Strictly connection facts (`mcp` uses this as-is): --json is an OUTPUT
    flag and lives in _add_automation_flags — on a command whose stdout is
    the MCP protocol channel it would promise a mode that cannot exist.
    """
    parser.add_argument(
        "--engine",
        default=None,
        help="engine base url (default $LOCALCUT_ENGINE_URL, else http://127.0.0.1:7830)",
    )
    parser.add_argument(
        "--token", default=None, help="bearer token (default $LOCALCUT_TOKEN)", dest="api_token"
    )
    parser.add_argument(
        "--cert",
        default=None,
        help="PEM of a remote engine's self-signed certificate, pinned as the only trusted CA",
    )


def _add_automation_flags(parser: argparse.ArgumentParser) -> None:
    """Connection flags plus the automation commands' output contract."""
    _add_connection_flags(parser)
    parser.add_argument("--json", action="store_true", help="print the raw JSON result")


def _resolve_connection(args: argparse.Namespace) -> tuple[str, str, Path | None]:
    """One interpretation of the connection flags for every client command.

    _add_connection_flags declares the contract once; this is the matching
    single reader, so `mcp` and the automation commands cannot drift on
    precedence or env names while both documenting "the same flags"."""
    from .automation import DEFAULT_ENGINE_URL

    url = args.engine or os.environ.get("LOCALCUT_ENGINE_URL") or DEFAULT_ENGINE_URL
    token = args.api_token or os.environ.get("LOCALCUT_TOKEN") or ""
    return url, token, Path(args.cert) if args.cert else None


def _add_automation_commands(subcommands) -> None:
    projects = subcommands.add_parser("projects", help="list projects on the engine")
    _add_automation_flags(projects)

    create = subcommands.add_parser("create", help="create a project from a prompt")
    create.add_argument("prompt")
    create.add_argument("--aspect", default="9:16")
    create.add_argument("--duration", type=int, default=60, dest="duration_s")
    create.add_argument("--mode", default="prompt")
    _add_automation_flags(create)

    render = subcommands.add_parser("render", help="render a project and wait for it to finish")
    render.add_argument("project_id")
    render.add_argument(
        "--final", action="store_true", help="run the final-quality pass, not a draft"
    )
    render.add_argument(
        "--timeout",
        type=float,
        default=3600.0,
        dest="timeout_s",
        help="seconds to wait before giving up (default 3600)",
    )
    render.add_argument("--no-wait", action="store_true", help="enqueue and return without waiting")
    _add_automation_flags(render)

    export = subcommands.add_parser("export", help="write a finished cut or an NLE handoff to disk")
    export.add_argument("project_id")
    export.add_argument(
        "--format", default="mp4", choices=("mp4", "otio", "fcpxml"), dest="export_format"
    )
    export.add_argument("--out", required=True, type=Path, help="file to write")
    _add_automation_flags(export)

    template = subcommands.add_parser("template", help="export or import a project template")
    template_actions = template.add_subparsers(dest="action", required=True)
    template_export = template_actions.add_parser("export", help="write a project's template")
    template_export.add_argument("project_id")
    template_export.add_argument("--out", required=True, type=Path)
    template_export.add_argument("--name", default="")
    template_export.add_argument("--description", default="")
    _add_automation_flags(template_export)
    template_import = template_actions.add_parser(
        "import", help="create a project from a template file"
    )
    template_import.add_argument("file", type=Path)
    template_import.add_argument("--title", default="")
    _add_automation_flags(template_import)

    workflow = subcommands.add_parser("workflow", help="manage imported ComfyUI workflows")
    workflow_actions = workflow.add_subparsers(dest="action", required=True)
    workflow_import = workflow_actions.add_parser(
        "import", help="import a ComfyUI API-format workflow"
    )
    workflow_import.add_argument("file", type=Path)
    workflow_import.add_argument("--name", required=True, help="template name (a-z, 0-9, - and _)")
    workflow_import.add_argument(
        "--check", action="store_true", help="review it without storing anything"
    )
    _add_automation_flags(workflow_import)
    workflow_list = workflow_actions.add_parser("list", help="list imported workflows")
    _add_automation_flags(workflow_list)
    workflow_remove = workflow_actions.add_parser("remove", help="delete an imported workflow")
    workflow_remove.add_argument("name")
    _add_automation_flags(workflow_remove)

    packs = subcommands.add_parser("packs", help="ComfyUI custom-node packs this engine allows")
    pack_actions = packs.add_subparsers(dest="action", required=True)
    packs_list = pack_actions.add_parser("list", help="show the catalog and what is enabled")
    _add_automation_flags(packs_list)
    packs_enable = pack_actions.add_parser("enable", help="allow one pack, at one version")
    packs_enable.add_argument("pack_id")
    packs_enable.add_argument(
        "--version", required=True, help="the version you installed on the ComfyUI host"
    )
    packs_enable.add_argument(
        "--i-understand-the-risk",
        action="store_true",
        dest="acknowledged",
        help="required: node packs are third-party code that runs inside ComfyUI",
    )
    _add_automation_flags(packs_enable)
    packs_disable = pack_actions.add_parser("disable", help="revoke a pack")
    packs_disable.add_argument("pack_id")
    _add_automation_flags(packs_disable)


def _automation_command(args: argparse.Namespace) -> int:
    from .automation import EXIT_FAILED, EngineClient, EngineError

    url, token, cert = _resolve_connection(args)
    try:
        with EngineClient(url, token, cert=cert) as client:
            return _dispatch_automation(args, client)
    except EngineError as exc:
        from .automation import fail

        return fail(str(exc), unreachable=exc.unreachable)
    except KeyboardInterrupt:
        # NOT 0. An interrupted `render` has not rendered anything, and 0 is
        # the one status a script reads as "carry on" - it would go straight
        # to `export` and ship whatever the last complete run left behind.
        print("interrupted", file=sys.stderr)
        return EXIT_FAILED


def _dispatch_automation(args: argparse.Namespace, client) -> int:
    # No fallback return: _AUTOMATION_COMMANDS is what let us in here, so a
    # key that is missing is a programming error worth the KeyError rather
    # than a silent exit 1.
    return _AUTOMATION_COMMANDS[args.command](args, client)


def _projects_command(args: argparse.Namespace, client) -> int:
    from . import automation

    rows = client.get("/projects") or []
    automation.emit(
        rows,
        as_json=args.json,
        lines=[f"{row['id']}  {row.get('mode', ''):10}  {row['title']}" for row in rows]
        or ["no projects"],
    )
    return automation.EXIT_OK


def _create_command(args: argparse.Namespace, client) -> int:
    from . import automation

    project = client.post(
        "/projects",
        json={
            "prompt": args.prompt,
            "aspect": args.aspect,
            "target_duration_s": args.duration_s,
            "mode": args.mode,
        },
    )
    automation.emit(project, as_json=args.json, lines=[project["id"]])
    return automation.EXIT_OK


def _render_command(args: argparse.Namespace, client) -> int:
    from . import automation

    # BEFORE the trigger, so a job of this render that fails between the
    # trigger and the first poll is still reported as ours. Skipped for
    # --no-wait, which reports a count and never looks at failures — that
    # path exists to enqueue and leave, and against a remote engine this
    # would be a round trip spent on an answer nobody reads.
    not_mine = frozenset() if args.no_wait else automation.settled_jobs(client, args.project_id)

    if args.final:
        client.post(f"/projects/{args.project_id}/finalize")
    else:
        # NOT an empty patch: `patch` re-plans only when an op dirtied
        # something, so `{"ops": []}` enqueued nothing and this command
        # reported "render finished" over a queue it had never filled.
        client.post(f"/projects/{args.project_id}/render")

    if args.no_wait:
        pending = automation.active_jobs(client, args.project_id)
        automation.emit(
            {"pending": len(pending)}, as_json=args.json, lines=[f"{len(pending)} job(s) queued"]
        )
        return automation.EXIT_OK

    seen: dict[str, int] = {}

    def progress(jobs: list[dict], pending: list[dict]) -> None:
        # One line per change, not per poll: a 40-minute render on a 2s poll
        # is 1200 identical lines in a CI log otherwise.
        counts = automation.render_summary(jobs)
        nonlocal seen
        if counts != seen and not args.json:
            seen = counts
            state = "  ".join(f"{status}:{n}" for status, n in sorted(counts.items()))
            print(f"  {state}  ({len(pending)} outstanding)", flush=True)

    failed = automation.wait_for_render(
        client,
        args.project_id,
        timeout_s=args.timeout_s,
        on_progress=progress,
        not_mine=not_mine,
    )
    payload = {
        "project_id": args.project_id,
        "failed": [
            {"node_id": job["spec"]["node_id"], "error": job.get("error")} for job in failed
        ],
    }
    automation.emit(
        payload,
        as_json=args.json,
        lines=[f"{job['spec']['node_id']}: {job.get('error') or 'failed'}" for job in failed]
        or ["render finished"],
    )
    return automation.EXIT_FAILED if failed else automation.EXIT_OK


def _export_command(args: argparse.Namespace, client) -> int:
    from . import automation

    if args.export_format in ("otio", "fcpxml"):
        written = client.download(
            f"/projects/{args.project_id}/export/{args.export_format}", args.out
        )
    else:
        artifact = automation.finished_cut_hash(client, args.project_id)
        if artifact is None:
            raise automation.EngineError(
                "this project has no finished cut yet - run `render` first, and check that "
                "its export node succeeded"
            )
        written = client.download(f"/projects/{args.project_id}/artifacts/{artifact}", args.out)
    automation.emit(
        {"path": str(args.out), "bytes": written},
        as_json=args.json,
        lines=[f"wrote {args.out} ({written} bytes)"],
    )
    return automation.EXIT_OK


def _template_command(args: argparse.Namespace, client) -> int:
    from . import automation

    if args.action == "export":
        document = client.get(
            f"/projects/{args.project_id}/template",
            params={"name": args.name, "description": args.description},
        )
        automation.write_json_file(args.out, document, what="template")
        # The result, not the document: --out already wrote the document, and
        # echoing it to stdout as well makes `template export | jq` read the
        # template where every other command's --json reads a result.
        automation.emit(
            {
                "path": str(args.out),
                "name": document.get("name"),
                "nodes": len(document.get("nodes", {})),
            },
            as_json=args.json,
            lines=[f"wrote {args.out} ({len(document.get('nodes', {}))} nodes)"],
        )
        return automation.EXIT_OK

    document = automation.read_json_file(args.file, what="template")
    result = client.post(
        "/projects/from-template", json={"template": document, "title": args.title}
    )
    lines = [result["project"]["id"]]
    # Both of these are things the importer would otherwise discover later:
    # a bill, or a scene that renders without its conditioning image.
    if result.get("cloud_models"):
        lines.append(f"note: renders on cloud models: {', '.join(result['cloud_models'])}")
    if result.get("dropped_assets"):
        lines.append(
            f"note: {result['dropped_assets']} conditioning asset(s) were not part of "
            "this template - re-upload them if the scenes need conditioning"
        )
    automation.emit(result, as_json=args.json, lines=lines)
    return automation.EXIT_OK


def _workflow_command(args: argparse.Namespace, client) -> int:
    from . import automation

    if args.action == "list":
        rows = client.get("/comfy/workflows") or []
        automation.emit(
            rows,
            as_json=args.json,
            lines=[
                f"{row['name']:24} {row['nodes']:4} nodes  {' '.join(row['placeholders']) or '-'}"
                for row in rows
            ]
            or ["no imported workflows"],
        )
        return automation.EXIT_OK

    if args.action == "remove":
        client.delete(f"/comfy/workflows/{args.name}")
        automation.emit({"ok": True}, as_json=args.json, lines=[f"removed {args.name}"])
        return automation.EXIT_OK

    workflow = automation.read_json_file(args.file, what="workflow")
    route = "/comfy/workflows/review" if args.check else "/comfy/workflows"
    result = client.post(route, json={"name": args.name, "workflow": workflow})
    lines = [
        ("would import" if args.check else "imported")
        + f" {args.name}: {len(result['class_types'])} node type(s)"
    ]
    if result.get("packs_required"):
        lines.append(f"uses enabled packs: {', '.join(result['packs_required'])}")
    lines += [f"warning: {w}" for w in result.get("warnings", [])]
    automation.emit(result, as_json=args.json, lines=lines)
    return automation.EXIT_OK


def _packs_command(args: argparse.Namespace, client) -> int:
    from . import automation

    if args.action == "list":
        catalog = client.get("/comfy/node-packs") or {}
        lines = [catalog.get("warning", ""), ""]
        for pack in catalog.get("packs", []):
            state = f"enabled ({pack['version']})" if pack["enabled"] else "disabled"
            lines.append(f"{pack['id']:24} {state:22} {pack['repo']}")
        automation.emit(catalog, as_json=args.json, lines=lines)
        return automation.EXIT_OK

    if args.action == "disable":
        result = client.delete(f"/comfy/node-packs/{args.pack_id}")
        automation.emit(
            result,
            as_json=args.json,
            lines=[f"disabled {args.pack_id}" if result.get("was_enabled") else "was not enabled"],
        )
        return automation.EXIT_OK

    result = client.post(
        f"/comfy/node-packs/{args.pack_id}/enable",
        json={"version": args.version, "acknowledge_code_execution": args.acknowledged},
    )
    automation.emit(result, as_json=args.json, lines=[f"enabled {args.pack_id} at {args.version}"])
    return automation.EXIT_OK


# ONE list of the automation commands, used for both the routing gate in
# `main` and the dispatch above. Built from the functions themselves, so a
# command cannot be registered in the parser and forgotten in one of the two
# places that have to know about it — the failure modes were an AttributeError
# out of the `serve` branch, and a silent exit 1.
_AUTOMATION_COMMANDS: dict[str, Callable[[argparse.Namespace, Any], int]] = {
    "projects": _projects_command,
    "create": _create_command,
    "render": _render_command,
    "export": _export_command,
    "template": _template_command,
    "workflow": _workflow_command,
    "packs": _packs_command,
}


if __name__ == "__main__":
    sys.exit(main())
