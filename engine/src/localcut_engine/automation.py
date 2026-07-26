"""Driving a headless engine from a shell.

Phase 3's "CLI automation on the headless engine". The engine is a server the
UI happens to launch (see api/app.py), so automation is a *client* of it, not
a second way into the same data directory. That matters for more than
tidiness: two processes writing one queue.db and one project directory is the
race the `serve` bind ordering exists to prevent, and a CLI that opened the
store directly would reintroduce it every time someone ran a command while
the desktop app was up.

Being a client also means every topology from doc 02 works for free. The same
`render` invocation drives the engine the desktop spawned on this machine, a
GPU box across the room over pinned TLS, or a container in CI — because none
of them are special, they are all just a URL and a token.

Output is designed to be read by two audiences at once: a human sees lines,
`--json` emits the raw document. Exit status is the automation contract —
0 succeeded, 1 the operation failed, 2 the engine could not be reached.
"""

from __future__ import annotations

import json
import ssl
import sys
import time
from pathlib import Path
from typing import Any

import httpx

# The engine's own default. Kept here rather than imported from config so a
# `--engine` default never silently follows a change meant for the server.
DEFAULT_ENGINE_URL = "http://127.0.0.1:7830"

# Exit statuses. A script wants to tell "the render failed" apart from "there
# was no engine to ask", because only one of those is worth retrying.
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_UNREACHABLE = 2

# Polling cadence while waiting on a render. Generous: a clip is minutes of
# GPU, and a tighter loop only adds requests to a machine that is busy.
_POLL_INTERVAL_S = 2.0

_TERMINAL = {"done", "failed", "cancelled"}


class EngineError(RuntimeError):
    """Anything the operator needs to read rather than a traceback."""

    def __init__(self, message: str, *, unreachable: bool = False) -> None:
        super().__init__(message)
        self.unreachable = unreachable


class EngineClient:
    """The engine's HTTP API, with the errors turned into sentences.

    Pinning mirrors the desktop's discipline (electron/request.ts): a remote
    engine serves a self-signed certificate, so `--cert` supplies that exact
    PEM as the only trusted CA. There is deliberately no `--insecure`: the
    bearer token and every provider key ride this connection, and a flag that
    turns verification off is a flag that ends up in somebody's CI script.
    """

    def __init__(
        self,
        url: str = DEFAULT_ENGINE_URL,
        token: str = "",
        *,
        cert: Path | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.url = url.rstrip("/")
        self.token = token
        verify: Any = True
        if cert is not None:
            if not cert.is_file():
                raise EngineError(f"certificate not found: {cert}")
            context = ssl.create_default_context(cafile=str(cert))
            # A self-signed engine cert names an IP or a LAN hostname that
            # will not match; the pin IS the identity check, exactly as the
            # desktop does it.
            context.check_hostname = False
            verify = context
        self._client = httpx.Client(
            base_url=self.url,
            headers={"Authorization": f"Bearer {self.token}"} if self.token else {},
            timeout=timeout,
            verify=verify,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> EngineClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.ConnectError as exc:
            raise EngineError(
                f"no engine at {self.url} - start one with `localcut-engine serve`, "
                "or pass --engine",
                unreachable=True,
            ) from exc
        except ssl.SSLError as exc:
            raise EngineError(
                f"TLS failed talking to {self.url}: {exc}. A remote engine serves a "
                "self-signed certificate - pass --cert with the PEM it printed at startup.",
                unreachable=True,
            ) from exc
        except httpx.HTTPError as exc:
            raise EngineError(f"could not reach {self.url}: {exc}", unreachable=True) from exc

        if response.status_code == 401:
            raise EngineError(
                "the engine rejected the token - pass --token, or set LOCALCUT_TOKEN "
                "to the value the engine printed at startup"
            )
        if response.status_code >= 400:
            raise EngineError(
                f"{method} {path} failed ({response.status_code}): {_detail(response)}"
            )
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            return response.content

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, **kwargs: Any) -> Any:
        return self.request("POST", path, **kwargs)

    def delete(self, path: str, **kwargs: Any) -> Any:
        return self.request("DELETE", path, **kwargs)

    def download(self, path: str, destination: Path) -> int:
        """Stream a route to a file. Returns bytes written.

        Streamed rather than buffered because the thing on the other end is a
        rendered video: reading a 300 MB export into memory to write it back
        out is avoidable, and on a small CI box it is fatal.
        """
        try:
            with self._client.stream("GET", path) as response:
                if response.status_code >= 400:
                    response.read()
                    raise EngineError(
                        f"GET {path} failed ({response.status_code}): {_detail(response)}"
                    )
                # Write to a neighbour and rename: an interrupted download
                # must not leave a truncated file wearing the name of a
                # finished export, which is exactly what a later step in the
                # same script would pick up.
                partial = destination.with_name(destination.name + ".part")
                written = 0
                with partial.open("wb") as sink:
                    for chunk in response.iter_bytes():
                        sink.write(chunk)
                        written += len(chunk)
                partial.replace(destination)
                return written
        except httpx.HTTPError as exc:
            raise EngineError(f"could not reach {self.url}: {exc}", unreachable=True) from exc


def _detail(response: httpx.Response) -> str:
    """The engine's own explanation, or the body, or the status."""
    try:
        payload = response.json()
    except ValueError:
        return (response.text or response.reason_phrase or "no detail")[:500]
    if isinstance(payload, dict) and "detail" in payload:
        return str(payload["detail"])[:500]
    return str(payload)[:500]


# -- waiting on work ---------------------------------------------------------


def active_jobs(client: EngineClient, project_id: str) -> list[dict]:
    """Jobs still to finish for a project."""
    jobs = client.get("/jobs", params={"project_id": project_id}) or []
    return [job for job in jobs if str(job.get("status")) not in _TERMINAL]


def wait_for_render(
    client: EngineClient,
    project_id: str,
    *,
    timeout_s: float,
    on_progress=None,
) -> list[dict]:
    """Block until nothing is queued or rendering. Returns the failed jobs.

    Returning the failures rather than raising: a render where three scenes
    landed and one did not is a partial success the caller may well want to
    report node by node, and an exception would flatten that to a string.

    A timeout raises, because a script that silently proceeds past an
    unfinished render will do something worse a step later.
    """
    deadline = time.monotonic() + timeout_s
    while True:
        jobs = client.get("/jobs", params={"project_id": project_id}) or []
        pending = [job for job in jobs if str(job.get("status")) not in _TERMINAL]
        if on_progress is not None:
            on_progress(jobs, pending)
        if not pending:
            return [job for job in jobs if str(job.get("status")) == "failed"]
        if time.monotonic() >= deadline:
            raise EngineError(
                f"still rendering after {timeout_s:.0f}s ({len(pending)} job(s) outstanding) - "
                "raise --timeout, or check the engine logs"
            )
        # Sleep no longer than the time actually left, so --timeout means
        # what it says rather than "the first poll after it elapsed".
        time.sleep(min(_POLL_INTERVAL_S, max(0.0, deadline - time.monotonic())))


def export_hash(board: dict) -> str | None:
    """The finished cut's artifact hash, if the export node has produced one."""
    export = (board.get("aux") or {}).get("export") or {}
    artifact = export.get("artifact_hash")
    return str(artifact) if artifact else None


def render_summary(jobs: list[dict]) -> dict[str, int]:
    """Job counts by status, for a one-line report."""
    counts: dict[str, int] = {}
    for job in jobs:
        counts[str(job.get("status"))] = counts.get(str(job.get("status")), 0) + 1
    return counts


def emit(payload: Any, *, as_json: bool, lines: list[str] | None = None) -> None:
    """Write a result for whichever audience asked.

    `--json` is the machine contract and prints the document unchanged;
    without it, the caller's own summary lines are printed instead. Never
    both: a script parsing stdout must not have to skip prose.
    """
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    for line in lines or []:
        print(line)


def read_json_file(path: Path, *, what: str) -> Any:
    """A JSON document from disk, with the failure named."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise EngineError(f"could not read {what} at {path}: {exc}") from exc
    try:
        return json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise EngineError(f"{path} is not valid JSON: {exc}") from exc


def write_json_file(path: Path, payload: Any, *, what: str) -> None:
    try:
        path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    except OSError as exc:
        raise EngineError(f"could not write {what} to {path}: {exc}") from exc


def fail(message: str, *, unreachable: bool = False) -> int:
    """Report an error the way a shell expects, and hand back the status."""
    print(f"error: {message}", file=sys.stderr)
    return EXIT_UNREACHABLE if unreachable else EXIT_FAILED
