"""CLI: `localcut-engine serve` — the one engine binary with three homes:
auto-spawned locally by the app, headless on a GPU box, or hosted.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

import uvicorn

from . import __version__
from .config import EngineConfig


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="localcut-engine")
    parser.add_argument("--version", action="version", version=__version__)
    subcommands = parser.add_subparsers(dest="command", required=True)

    serve = subcommands.add_parser("serve", help="run the engine API server")
    serve.add_argument("--host", default=None, help="bind address (default 127.0.0.1; "
                       "non-localhost requires an explicit --token)")
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--token", default=None, help="pairing token (generated if omitted)")
    serve.add_argument("--data-dir", default=None)
    serve.add_argument("--backend", choices=["mock", "local"], default=None)
    serve.add_argument("--announce-fd3", action="store_true",
                       help="write the connection info JSON to fd 3 (used by the desktop shell)")

    probe = subcommands.add_parser("probe", help="print the hardware profile and exit")
    del probe

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    if args.command == "probe":
        from .hardware.probe import probe_hardware

        print(probe_hardware().model_dump_json(indent=2))
        return 0

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

    if config.host not in ("127.0.0.1", "localhost", "::1") and args.token is None:
        parser.error(
            "network bind requires an explicit --token (pairing); "
            "see the docs for remote-engine setup"
        )

    connection_info = json.dumps(
        {"host": config.host, "port": config.port, "token": config.token}
    )
    if args.announce_fd3:
        try:
            import os

            os.write(3, (connection_info + "\n").encode())
        except OSError:
            print(connection_info, flush=True)
    else:
        print(f"LOCALCUT_ENGINE {connection_info}", flush=True)

    from .api.app import create_app

    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
