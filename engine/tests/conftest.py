"""Shared test factories."""

import socket

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
