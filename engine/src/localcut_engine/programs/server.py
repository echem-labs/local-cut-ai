"""LocalCut's own copy of a program that runs as a server (Ollama, and
ComfyUI next), started and stopped with the engine.

One `ManagedServer` per program supervises one child process:

- It starts the copy when the engine starts, if there is one and nothing
  already answers at the program's address. A server of the user's own that
  answers there wins, and is left alone: LocalCut uses it. Something else at
  that address (a port another program holds) is reported as `port_in_use`,
  and LocalCut does not try to take it.
- The child is bound to loopback, gets no window on Windows, and writes
  everything it prints to <data_dir>/logs/<program>.log, which GET
  /programs/{id}/log serves for the support bundle.
- It is restarted when it stops by itself, a few times and with a pause that
  doubles each time. After that it is `crashed`, with the reason, until
  someone starts it again. A copy that exits because it was asked to (exit
  status 0, or SIGINT or SIGTERM from outside) is `stopped`, not restarted:
  that is a terminal's Ctrl+C or the desktop stopping the engine's process
  group, which the child shares on POSIX so it goes with the engine.
- It is stopped, with every process it started, when the engine shuts down
  (the app lifespan).
- What it is running is written to <data_dir>/run/<program>.json (the pid,
  the process's start time and its binary). An engine that died without
  stopping its child leaves that file behind, and the next engine stops the
  child it names before it looks for a server at the address, so LocalCut's
  orphan is never taken for the user's own install.

What is particular to one program (the command line, where its copy lives,
how to tell it is answering) is a `ServerProgram`, which that program's
installer in setup.py provides. Everything here is the same for every
server.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import socket
import subprocess
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

import psutil

from ..config import EngineConfig
from ..events import EventBus
from ..project.store import _write_atomic

logger = logging.getLogger(__name__)

#: How long a started copy has to answer before it counts as a failed start.
#: Ollama looks at every GPU the first time, which takes a few seconds.
START_TIMEOUT_S = 60.0
_ASK_EVERY_S = 0.25
# Restarts allowed within the window before the copy is left `crashed`, and
# the first pause before one (doubled for each after).
_MAX_RESTARTS = 3
_RESTART_WINDOW_S = 600.0
_RESTART_PAUSE_S = 1.0
# How long a stop waits for the child to exit by itself before killing it.
_STOP_GRACE_S = 10.0
# The log is started over when a new run would find it larger than this; the
# run before is kept beside it as <program>.log.1.
_LOG_LIMIT = 5 << 20
#: The most of a log GET /programs/{id}/log hands out: its end.
LOG_TAIL_BYTES = 128 << 10
# What a server says when its address is taken, on POSIX and on Windows.
_PORT_TAKEN = ("address already in use", "only one usage of each socket address")
# Exits that mean the child was asked to stop: a clean exit, or the signals a
# terminal or a process manager sends.
_ASKED_TO_STOP = {0, -signal.SIGINT, -signal.SIGTERM}

Identity = Literal["self", "other"] | None


@dataclass(frozen=True)
class ServerLaunch:
    """How to run one program's copy, and where it will answer."""

    argv: list[str]
    #: Set on top of the engine's own environment.
    env: dict[str, str]
    cwd: Path
    #: Where it answers, as `http://host:port`.
    url: str
    host: str
    port: int


class ServerProgram(Protocol):
    """What the supervisor needs to know about one program."""

    program: str

    def launch(self, config: EngineConfig) -> ServerLaunch | None:
        """How to run LocalCut's copy, or None when there is no copy to run
        or its address is not one a copy on this machine can take."""

    async def identify(self, url: str) -> Identity:
        """Who answers at `url`: "self" when it is this program (any copy of
        it), "other" when something else answers, None when nothing does."""


@dataclass
class _Run:
    """One child process and what is known about it."""

    process: asyncio.subprocess.Process
    started: float
    log_start: int


@dataclass
class ManagedServer:
    """Supervises LocalCut's copy of one server program. Create it once per
    engine; `start()` and `stop()` may be called any number of times."""

    config: EngineConfig
    program: ServerProgram
    events: EventBus
    #: Called each time the copy answers after a start, for whoever caches a
    #: liveness verdict about the address (the script backend's probe).
    on_ready: Callable[[], None] = lambda: None
    state: str = "stopped"
    reason: str | None = None
    error: str | None = None
    url: str | None = None
    _run: _Run | None = None
    _task: asyncio.Task | None = None
    _stopping: bool = False
    _restarts: deque = field(default_factory=deque)
    _changed: asyncio.Event | None = None
    _stop_asked: asyncio.Event | None = None

    @property
    def id(self) -> str:
        return self.program.program

    @property
    def log_path(self) -> Path:
        return self.config.data_dir / "logs" / f"{self.id}.log"

    @property
    def run_path(self) -> Path:
        return self.config.data_dir / "run" / f"{self.id}.json"

    def describe(self) -> dict:
        """The copy's state, as GET /programs reports it under `managed`."""
        process = self._run.process if self._run is not None else None
        return {
            "state": self.state,
            "reason": self.reason,
            "error": self.error,
            "pid": process.pid if process is not None and process.returncode is None else None,
            "url": self.url,
            "restarts": len(self._restarts),
            "log": str(self.log_path.resolve()),
        }

    @property
    def serving(self) -> bool:
        """Whether LocalCut's copy is the server at its address, or about to
        be."""
        return self.state in ("starting", "running")

    # -- control ---------------------------------------------------------------

    def start(self) -> bool:
        """Begin running the copy, unless it is running or starting already.
        Returns False when there is no copy to run (no launch). A copy that
        crashed gets its full count of restarts again."""
        if self._task is not None and not self._task.done():
            return True
        if self.program.launch(self.config) is None:
            return False
        self._stopping = False
        self._stop_asked = asyncio.Event()
        self._restarts.clear()
        self._set("starting")
        self._task = asyncio.get_running_loop().create_task(
            self._supervise(), name=f"server-{self.id}"
        )
        return True

    async def stop(self, *, reason: str | None = "stopped") -> None:
        """Stop the copy and every process it started, and wait until they
        are gone. `reason` is what the state says afterwards; None at engine
        shutdown, where there is nobody left to tell."""
        self._stopping = True
        if self._stop_asked is not None:
            self._stop_asked.set()
        task = self._task
        run = self._run
        if run is not None:
            await stop_child(run.process)
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._task = None
        if self.state != "stopped" or self.reason != reason:
            self._set("stopped", reason)

    async def settled(self, timeout_s: float = START_TIMEOUT_S + 5) -> str:
        """Wait while the copy is starting, and return the state it reaches."""
        deadline = time.monotonic() + timeout_s
        while self.state == "starting" and time.monotonic() < deadline:
            event = self._changed_event()
            event.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(event.wait(), timeout=deadline - time.monotonic())
        return self.state

    # -- bookkeeping -------------------------------------------------------------

    def _changed_event(self) -> asyncio.Event:
        if self._changed is None:
            self._changed = asyncio.Event()
        return self._changed

    def _set(self, state: str, reason: str | None = None, error: str | None = None) -> None:
        changed = (state, reason) != (self.state, self.reason)
        self.state, self.reason, self.error = state, reason, error
        self._changed_event().set()
        if changed:
            self.events.publish("program.server", program=self.id, state=state, reason=reason)

    # -- the supervisor ----------------------------------------------------------

    async def _supervise(self) -> None:
        try:
            await self._keep_running()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - the supervisor reports, never dies silent
            logger.exception("supervising LocalCut's %s failed", self.id)
            self._set("crashed", "cannot_start", str(exc) or type(exc).__name__)
        finally:
            if self._run is not None and self._run.process.returncode is None:
                await stop_child(self._run.process)
            self._run = None
            await asyncio.to_thread(self._forget_run)

    async def _keep_running(self) -> None:
        while not self._stopping:
            launch = self.program.launch(self.config)
            if launch is None:
                self._set("stopped")
                return
            self.url = launch.url
            await asyncio.to_thread(self._stop_orphan, launch)
            found = await self.program.identify(launch.url)
            if found == "self":
                # The user's own server: LocalCut uses it and leaves it be.
                self._set("stopped", "own_server")
                return
            if found == "other" or await asyncio.to_thread(_port_taken, launch.host, launch.port):
                self._set(
                    "crashed",
                    "port_in_use",
                    f"something that is not {self.id} answers at {launch.host}:{launch.port}",
                )
                return
            try:
                run = await self._spawn(launch)
            except OSError as exc:
                self._set("crashed", "cannot_start", str(exc))
                return
            self._run = run
            self._set("starting")
            answered = await self._wait_until_answering(run, launch)
            timed_out = not answered and run.process.returncode is None
            if answered:
                self._set("running")
                self.on_ready()
            elif timed_out and not self._stopping:
                logger.warning("LocalCut's %s did not answer in %gs", self.id, START_TIMEOUT_S)
            if not answered:
                await stop_child(run.process)
            code = await run.process.wait()
            self._run = None
            await asyncio.to_thread(self._forget_run)
            if self._stopping:
                return
            if answered and code in _ASKED_TO_STOP:
                logger.info("LocalCut's %s was stopped from outside (exit %s)", self.id, code)
                self._set("stopped", "stopped")
                return
            tail = await asyncio.to_thread(self._log_since, run.log_start)
            if any(phrase in tail.lower() for phrase in _PORT_TAKEN):
                self._set(
                    "crashed",
                    "port_in_use",
                    f"{launch.host}:{launch.port} was taken before {self.id} could listen there",
                )
                return
            reason = "no_answer" if timed_out else "exited"
            error = _last_lines(tail) or f"exit status {code}"
            now = time.monotonic()
            while self._restarts and now - self._restarts[0] > _RESTART_WINDOW_S:
                self._restarts.popleft()
            if len(self._restarts) >= _MAX_RESTARTS:
                logger.warning("LocalCut's %s stopped again (%s); giving up", self.id, error)
                self._set("crashed", reason, error)
                return
            pause = _RESTART_PAUSE_S * 2 ** len(self._restarts)
            self._restarts.append(now)
            logger.warning(
                "LocalCut's %s stopped (%s); starting it again in %gs", self.id, error, pause
            )
            self._set("starting", reason, error)
            # A stop during the pause ends it at once.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop_asked.wait(), timeout=pause)

    async def _spawn(self, launch: ServerLaunch) -> _Run:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(self._roll_log)
        options: dict = {}
        if os.name == "nt":
            # No console window for a program the user never started.
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        with self.log_path.open("ab") as log:
            log_start = log.tell()
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            log.write(f"\n-- LocalCut started {self.id} at {stamp}: {launch.url}\n".encode())
            log.flush()
            process = await asyncio.create_subprocess_exec(
                *launch.argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=log,
                stderr=asyncio.subprocess.STDOUT,
                cwd=launch.cwd,
                env={**os.environ, **launch.env},
                **options,
            )
        logger.info("started LocalCut's %s (pid %d) at %s", self.id, process.pid, launch.url)
        await asyncio.to_thread(self._remember_run, process.pid, launch)
        return _Run(process=process, started=time.monotonic(), log_start=log_start)

    async def _wait_until_answering(self, run: _Run, launch: ServerLaunch) -> bool:
        deadline = time.monotonic() + START_TIMEOUT_S
        while time.monotonic() < deadline and not self._stopping:
            if run.process.returncode is not None:
                return False
            if await self.program.identify(launch.url) == "self":
                return run.process.returncode is None
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(run.process.wait(), timeout=_ASK_EVERY_S)
        return False

    # -- files ---------------------------------------------------------------

    def _roll_log(self) -> None:
        try:
            if self.log_path.stat().st_size > _LOG_LIMIT:
                os.replace(self.log_path, self.log_path.with_name(f"{self.id}.log.1"))
        except OSError:
            pass

    def _log_since(self, offset: int) -> str:
        try:
            with self.log_path.open("rb") as log:
                log.seek(offset)
                return log.read(LOG_TAIL_BYTES).decode("utf-8", "replace")
        except OSError:
            return ""

    def log_tail(self) -> str:
        """The end of the log, for the support bundle: what the copy printed
        last, which is what explains a crash."""
        try:
            with self.log_path.open("rb") as log:
                log.seek(0, os.SEEK_END)
                size = log.tell()
                log.seek(max(0, size - LOG_TAIL_BYTES))
                return log.read().decode("utf-8", "replace")
        except OSError:
            return ""

    def _remember_run(self, pid: int, launch: ServerLaunch) -> None:
        try:
            created = psutil.Process(pid).create_time()
        except psutil.Error:
            return
        record = {"format": 1, "pid": pid, "create_time": created, "binary": launch.argv[0]}
        self.run_path.parent.mkdir(parents=True, exist_ok=True)
        _write_atomic(self.run_path, json.dumps(record))

    def _forget_run(self) -> None:
        with contextlib.suppress(FileNotFoundError):
            self.run_path.unlink()

    def _stop_orphan(self, launch: ServerLaunch) -> None:
        """Stop a copy an earlier engine started and did not stop. It is ours
        only if the process the run file names is still the one that was
        started (same start time) and runs this program's binary; a pid the
        system has since given to something else is left alone."""
        try:
            record = json.loads(self.run_path.read_text(encoding="utf-8"))
            pid, created = int(record["pid"]), float(record["create_time"])
            binary = str(record["binary"])
        except (OSError, ValueError, KeyError, TypeError):
            self._forget_run()
            return
        try:
            process = psutil.Process(pid)
            ours = abs(process.create_time() - created) < 1.0 and _same_binary(
                process.exe(), binary
            )
        except psutil.Error:
            ours = False
        if ours:
            logger.info(
                "stopping LocalCut's %s (pid %d), left running by an engine before", self.id, pid
            )
            _stop_tree(pid)
        self._forget_run()


def _same_binary(running: str, recorded: str) -> bool:
    try:
        return os.path.samefile(running, recorded)
    except OSError:
        return os.path.normcase(os.path.abspath(running)) == os.path.normcase(
            os.path.abspath(recorded)
        )


def _stop_tree(pid: int) -> None:
    """Stop a process this engine did not start (an orphan an earlier one
    left) and everything it started. On POSIX it is asked first (SIGTERM),
    which lets a server unload what it holds, and killed if it is still
    there after the grace period. Windows has no such request for a process
    without a console, so there the tree is ended outright."""
    try:
        root = psutil.Process(pid)
        children = root.children(recursive=True)
    except psutil.Error:
        return
    if os.name == "nt":
        _kill(children)
        _kill([root])
        return
    with contextlib.suppress(psutil.Error):
        root.terminate()
    _, alive = psutil.wait_procs([root], timeout=_STOP_GRACE_S)
    _kill([*alive, *children])


async def stop_child(process: asyncio.subprocess.Process) -> None:
    """Stop a process this engine started, and everything it started. The
    same as `_stop_tree`, except that the process itself is waited for
    through asyncio, which reaps it: psutil waiting on a child of this
    process would reap it first, and asyncio's wait would then never end."""
    if process.returncode is not None:
        return
    try:
        children = await asyncio.to_thread(
            lambda: psutil.Process(process.pid).children(recursive=True)
        )
    except psutil.Error:
        children = []
    if os.name == "nt":
        await asyncio.to_thread(_kill, children)
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        await process.wait()
        return
    with contextlib.suppress(ProcessLookupError):
        process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=_STOP_GRACE_S)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        await process.wait()
    # Whatever it started and did not stop on its way out.
    await asyncio.to_thread(_kill, children)


def _kill(processes: list) -> None:
    """Kill these processes, none of them a child of this one, and wait for
    them to go."""
    alive = []
    for process in processes:
        with contextlib.suppress(psutil.Error):
            if process.is_running():
                process.kill()
                alive.append(process)
    psutil.wait_procs(alive, timeout=_STOP_GRACE_S)


def _port_taken(host: str, port: int) -> bool:
    """Whether something accepts connections at the address. Asked only
    after nothing there answered as the program, so a yes is a port that
    something else holds."""
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


def _last_lines(text: str, count: int = 3) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return " | ".join(lines[-count:])


# -- one registry per engine -----------------------------------------------------


class ManagedServers:
    """The engine's managed servers, by program. Registered under its data
    dir while the engine runs, so an installer asked whether LocalCut's copy
    is in use can find out (`find`)."""

    def __init__(
        self,
        config: EngineConfig,
        events: EventBus,
        programs: dict[str, ServerProgram],
        *,
        on_ready: dict[str, Callable[[], None]] | None = None,
    ) -> None:
        self.config = config
        self.servers = {
            program_id: ManagedServer(
                config, program, events, on_ready=(on_ready or {}).get(program_id, lambda: None)
            )
            for program_id, program in programs.items()
        }

    def get(self, program_id: str) -> ManagedServer | None:
        return self.servers.get(program_id)

    def start_all(self) -> bool:
        """At engine start: run each program LocalCut has a copy of. Returns
        whether any of them is starting."""
        _REGISTRIES[_key(self.config)] = self
        return any([server.start() for server in self.servers.values()])

    async def settled(self) -> None:
        """Wait until none of them is starting any more."""
        await asyncio.gather(*(server.settled() for server in self.servers.values()))

    async def stop_all(self) -> None:
        await asyncio.gather(*(server.stop(reason=None) for server in self.servers.values()))
        if _REGISTRIES.get(_key(self.config)) is self:
            del _REGISTRIES[_key(self.config)]


_REGISTRIES: dict[str, ManagedServers] = {}


def _key(config: EngineConfig) -> str:
    return str(Path(config.data_dir).resolve())


def find(config: EngineConfig, program_id: str) -> ManagedServer | None:
    """The managed server of the engine running on this data dir, if one is."""
    registry = _REGISTRIES.get(_key(config))
    return registry.get(program_id) if registry is not None else None
