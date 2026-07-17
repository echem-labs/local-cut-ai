"""Shared test factories."""

from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import NodeKind


def make_spec(
    kind: NodeKind,
    params: dict | None = None,
    *,
    node_id: str | None = None,
    seed: int = 0,
    output_hash: str = "a" * 64,
    input_hashes: dict[str, str] | None = None,
    quality: str = "draft",
) -> JobSpec:
    return JobSpec(
        node_id=node_id or kind.value,
        kind=kind,
        output_hash=output_hash,
        params=params or {},
        model=None,
        seed=seed,
        input_hashes=input_hashes or {},
        quality=quality,
    )
