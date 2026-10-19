"""Stands in for `ollama serve` in the tests: the routes LocalCut asks
(/api/version, /api/tags, /v1/models, a streaming /api/pull), on the address
in OLLAMA_HOST, keeping what it pulls under OLLAMA_MODELS the way Ollama
does, so a model pulled is still there after a restart.

The tests pack this file into an archive as the Ollama binary and run it
with the Python running the tests. FAKE_OLLAMA, a JSON object in the
environment it inherits, changes how it behaves:

- "exit": exit with this status this many seconds after it starts answering
  ("exit_after", default 0.2), the way a crash ends a server;
- "silent": listen and never answer, the way a server that hangs does;
- "pull_error": answer a pull with this error, as Ollama reports a model
  its registry does not have;
- "layer": the size of the one layer a pull fetches (default 3000 bytes),
  reported in five steps "pace" seconds apart (default 0.15), slow enough
  for the engine's throttled progress to show one;
- "env_to": a file to which every start adds one line, a JSON object of the
  OLLAMA_ variables it was started with, which is what Ollama reads its
  settings from.

Standard library only: it runs outside the engine's environment.
"""

from __future__ import annotations

import json
import os
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "0.40.4"


def _manifest(models: Path, name: str) -> Path:
    model, _, tag = name.partition(":")
    parts = model.split("/")
    if len(parts) == 1:
        parts = ["registry.ollama.ai", "library", *parts]
    return (models / "manifests").joinpath(*parts, tag or "latest")


def _pulled(models: Path) -> list[str]:
    root = models / "manifests" / "registry.ollama.ai" / "library"
    if not root.is_dir():
        return []
    return sorted(f"{model.name}:{tag.name}" for model in root.iterdir() for tag in model.iterdir())


def main() -> int:
    if sys.argv[1:] != ["serve"]:
        print("usage: ollama serve", file=sys.stderr)
        return 2
    host, _, port = os.environ["OLLAMA_HOST"].rpartition(":")
    models = Path(os.environ["OLLAMA_MODELS"])
    behaviour = json.loads(os.environ.get("FAKE_OLLAMA") or "{}")
    if behaviour.get("env_to"):
        settings = {key: value for key, value in os.environ.items() if key.startswith("OLLAMA_")}
        with open(behaviour["env_to"], "a", encoding="utf-8") as record:
            record.write(json.dumps(settings) + "\n")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _json(self, status: int, body: object) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
            if behaviour.get("silent"):
                time.sleep(30)
                return
            if self.path == "/api/version":
                self._json(200, {"version": VERSION})
            elif self.path == "/api/tags":
                self._json(200, {"models": [{"name": name} for name in _pulled(models)]})
            elif self.path == "/v1/models":
                data = [{"id": name, "object": "model"} for name in _pulled(models)]
                # Ollama 0.40.4 answers an empty list as null.
                self._json(200, {"object": "list", "data": data or None})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - the stdlib's name
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path != "/api/pull":
                self._json(404, {"error": "not found"})
                return
            name = str(body.get("model") or "")
            # The stream ends when the connection does, as Ollama's does.
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()

            def line(update: dict) -> None:
                self.wfile.write(json.dumps(update).encode() + b"\n")
                self.wfile.flush()

            line({"status": "pulling manifest"})
            if behaviour.get("pull_error"):
                line({"error": behaviour["pull_error"]})
                return
            total = int(behaviour.get("layer", 3000))
            for done in range(0, total + 1, max(1, total // 4)):
                line(
                    {
                        "status": "pulling abc",
                        "digest": "sha256:abc",
                        "total": total,
                        "completed": done,
                    }
                )
                time.sleep(float(behaviour.get("pace", 0.15)))
            line({"status": "verifying sha256 digest"})
            target = _manifest(models, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("{}")
            line({"status": "success"})

        def log_message(self, format: str, *args) -> None:  # noqa: A002 - the stdlib's name
            print(f"[fake ollama] {format % args}", flush=True)

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def server_bind(self) -> None:
            # HTTPServer's own looks the address up with socket.getfqdn,
            # which on a macOS runner can stall for longer than a test waits
            # for a server to answer. Ollama does no such lookup.
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = self.server_address[:2]

    try:
        server = Server((host, int(port)), Handler)
    except OSError:
        print(f"Error: listen tcp {host}:{port}: bind: address already in use", flush=True)
        return 1
    print(f"Listening on {host}:{port} (version {VERSION})", flush=True)
    if "exit" in behaviour:

        def leave() -> None:
            time.sleep(float(behaviour.get("exit_after", 0.2)))
            print("fake ollama: something went wrong", flush=True)
            os._exit(int(behaviour["exit"]))

        threading.Thread(target=leave, daemon=True).start()
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
