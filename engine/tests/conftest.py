"""Shared test factories."""

import asyncio
import contextlib
import socket
import threading
import time

from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import NodeKind


# The bound both loop tests assert `LoopWatch.stalled` against. It is loose
# on purpose, because it only has to land in a very wide gap: work genuinely
# off the loop gives it back a block at a time (measured ~0.09, noisy to
# ~0.24 under GC), while a single C call holding the GIL keeps it for
# essentially the whole span (~0.7 in a thread, 1.0 inline). Tightening it
# buys no sensitivity and costs flakes.
MAX_STALLED = 0.4


class LoopWatch:
    """How long the event loop went without a turn, at its worst."""

    def __init__(self) -> None:
        self.worst = 0.0
        self.elapsed = 0.0
        self._last = 0.0

    def start(self, now: float) -> None:
        self._last = now

    def turn(self, now: float) -> None:
        """Close the gap that ended at `now`."""
        self.worst = max(self.worst, now - self._last)
        self._last = now

    @property
    def stalled(self) -> float:
        """The worst stall as a fraction of the watched span."""
        return self.worst / self.elapsed if self.elapsed else 1.0

    def __str__(self) -> str:
        return f"the loop stopped for {self.worst * 1e3:.0f}ms of {self.elapsed * 1e3:.0f}ms"


@contextlib.asynccontextmanager
async def watch_the_loop():
    """Watches the loop across a block, for a test proving work was really
    moved off it.

    Here rather than copied into each suite (it was, twice) for free_port's
    reason, and because the obvious spelling is wrong in a way that is easy
    to miss: counting ticks and asserting the count rose passes for code
    that yields once and then blocks the loop for the rest of the block. What
    holds the line is a bound on the WORST gap between turns, which is why
    this hands back `stalled` rather than a tally.

    The closing `turn()` is the other half of that, and is why the gap is
    not left for the ticker to notice: a block that never yields again ends
    with the ticker still parked at the last turn before the stall, so
    without it the longest stall of all — the one covering the entire block
    — would go unrecorded and the test would pass on exactly the code it
    exists to fail. The ticker is torn down in a `finally` and awaited, so a
    failing assertion inside the block cannot leak a spinning task into the
    rest of the session.
    """
    watch = LoopWatch()

    async def ticker() -> None:
        while True:
            await asyncio.sleep(0)
            watch.turn(time.perf_counter())

    beat = asyncio.create_task(ticker())
    await asyncio.sleep(0)  # let the ticker take its first turn
    started = time.perf_counter()
    watch.start(started)
    try:
        yield watch
    finally:
        ended = time.perf_counter()
        watch.turn(ended)
        watch.elapsed = ended - started
        beat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await beat


def free_port() -> int:
    """A port nothing is listening on, for a test that needs a real socket.

    Here rather than copied into each suite: the known weakness of this
    pattern is the race between the probe closing and the real bind, and a
    fix for it should not have to be found twice.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@contextlib.contextmanager
def serve_engine(tmp_path, token: str, backend: str = "mock"):
    """A live engine on loopback, with the scheduler actually running
    (uvicorn drives the lifespan, which is what starts it). Yields the url.

    Here rather than copied into each suite (it was, once) for free_port's
    reason: this pattern has three subtle parts — the startup poll, which
    must also notice the server DYING rather than sleep out its deadline;
    the bounded teardown join; and the assertion that the join worked, so a
    hung lifespan shutdown fails the test that caused it instead of leaking
    a live engine into the rest of the session.
    """
    import uvicorn

    from localcut_engine.api.app import create_app
    from localcut_engine.config import EngineConfig

    config = EngineConfig(data_dir=tmp_path, token=token, backend=backend)
    server = uvicorn.Server(
        uvicorn.Config(create_app(config), host="127.0.0.1", port=free_port(), log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started, (
        "the test engine never came up" if thread.is_alive() else "the test engine died on startup"
    )
    try:
        yield f"http://127.0.0.1:{server.config.port}"
    finally:
        server.should_exit = True
        thread.join(timeout=20)
        assert not thread.is_alive(), "the test engine did not shut down"


def make_spec(
    kind: NodeKind,
    params: dict | None = None,
    *,
    node_id: str | None = None,
    seed: int = 0,
    output_hash: str = "a" * 64,
    input_hashes: dict[str, str] | None = None,
    quality: str = "draft",
    model: str | None = None,
) -> JobSpec:
    return JobSpec(
        node_id=node_id or kind.value,
        kind=kind,
        output_hash=output_hash,
        params=params or {},
        model=model,
        seed=seed,
        input_hashes=input_hashes or {},
        quality=quality,
    )
