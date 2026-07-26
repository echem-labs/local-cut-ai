"""CLI: `localcut-engine serve` — the one engine binary with three homes:
auto-spawned locally by the app, headless on a GPU box, or hosted.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
from pathlib import Path

import uvicorn

from . import __version__
from .config import EngineConfig


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="localcut-engine")
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

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    _survive_console_encoding()

    if args.command == "probe":
        from .hardware.probe import probe_hardware

        config = EngineConfig.from_env()
        config.data_dir.mkdir(parents=True, exist_ok=True)
        print(probe_hardware(str(config.data_dir)).model_dump_json(indent=2))
        return 0

    if args.command in ("models", "download"):
        return _models_command(args)

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
            f"cannot bind {config.host}:{config.port}: {exc}\n"
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


if __name__ == "__main__":
    sys.exit(main())
