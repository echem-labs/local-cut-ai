"""CLI: `localcut-engine serve` — the one engine binary with three homes:
auto-spawned locally by the app, headless on a GPU box, or hosted.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
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

    probe = subcommands.add_parser("probe", help="print the hardware profile and exit")
    del probe

    models = subcommands.add_parser("models", help="list manifest models and download status")
    models.add_argument("--models-dir", default=None)

    download = subcommands.add_parser("download", help="download a model's weights by manifest id")
    download.add_argument("model_id")
    download.add_argument("--models-dir", default=None)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

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

    token_configured = args.token is not None or os.environ.get("LOCALCUT_TOKEN")
    if config.host not in ("127.0.0.1", "localhost", "::1") and not token_configured:
        parser.error(
            "network bind requires an explicit --token (pairing); "
            "see the docs for remote-engine setup"
        )

    connection_info = json.dumps({"host": config.host, "port": config.port, "token": config.token})
    if args.announce_fd3:
        try:
            os.write(3, (connection_info + "\n").encode())
        except OSError:
            print(connection_info, flush=True)
    else:
        print(f"LOCALCUT_ENGINE {connection_info}", flush=True)

    from .api.app import create_app

    # access_log=False: request lines would log ?token=… query strings.
    uvicorn.run(
        create_app(config),
        host=config.host,
        port=config.port,
        log_level="info",
        access_log=False,
    )
    return 0


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
