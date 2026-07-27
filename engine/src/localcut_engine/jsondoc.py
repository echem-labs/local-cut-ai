"""Size and shape guards for the untrusted JSON documents the engine accepts.

Two routes take a whole document written by someone else — a shared story
template (graph/template_io.py) and an imported ComfyUI workflow
(comfy/workflows.py). Both need the same question answered before any of it
is turned into models: is this thing even plausibly what it claims to be?

The guard lives here rather than in either caller because it was a
byte-for-byte copy in both, and the correctness of the encoder it drives is
not obvious enough to maintain twice.
"""

from __future__ import annotations

import json
from typing import Any, Literal

# Refusal reasons, so the caller can say which limit the document broke
# without re-deriving it.
Refusal = Literal["size", "depth"]


def refuse_reason(document: Any, limit: int) -> Refusal | None:
    """Why `document` is not worth parsing, or None if it is fine.

    Size is measured incrementally, so an oversized document is never encoded
    in full just to be rejected.

    Depth matters as much as size and is the less obvious of the two: passing
    `default=` to JSONEncoder rules out the C encoder, so `iterencode` runs
    CPython's pure-Python fallback, which recurses once per level of nesting.
    `json.loads` (C, iterative) happily parses far deeper than that, so a
    10 KB document of 3000 nested arrays parses, reaches this guard, and
    raises RecursionError — which is a RuntimeError, so neither TemplateError
    nor WorkflowError catches it and the route answers 500 with a traceback
    to a document its size guard exists to refuse with a reason.
    """
    size = 0
    try:
        for chunk in json.JSONEncoder(separators=(",", ":"), default=str).iterencode(document):
            size += len(chunk)
            if size > limit:
                return "size"
    except RecursionError:
        return "depth"
    return None
