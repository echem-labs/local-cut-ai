"""Shared test factories."""

import contextlib
import socket
import threading
import time

from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import NodeKind


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
