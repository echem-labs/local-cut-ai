"""Non-fatal notices — the single home for their vocabulary.

`error` on a job means it did not finish; a notice means it finished with
something the user should know. The first one: a screenplay that stays short
of its target after every re-ask renders anyway (see
backends/llm.py::screenplay_within_target), and without a channel to the UI
the only trace was a server log.

A notice crosses the wire as a code plus data, never as English: the desktop
translates the code through its i18n catalog with the data as parameters,
which is the same discipline as board statuses (the raw wire value is an id).
Every code here must have a catalog entry in the desktop's notices.json —
test_ui_contract.py compares the two, so adding a code is a two-file change
that cannot silently render as nothing.

The registry is checked where a notice is *emitted* (ExecutionContext.notify),
never where one is read. `Notice` itself stays permissive on purpose: job
payloads carry notices, and JobQueue._hydrate skips any payload this build
cannot parse — so refusing an unknown code on read would make one notice from
a newer build delete a finished job from the board, taking its status and
progress with it. The desktop makes the same call, skipping a code it has no
message for rather than failing the screen.
"""

from __future__ import annotations

from pydantic import BaseModel

# The script model could not reach target_duration_s and the longest attempt
# was rendered instead. data: target_s, estimated_s, words.
SCRIPT_SHORT_OF_TARGET = "script.short_of_target"

# The export was handed a music input it could not decode — in practice a
# placeholder from a machine with no music model — and rendered without a
# bed rather than failing the cut. The video is fine; the missing music is
# not self-explanatory, so the skip must not stay silent. data: none.
EXPORT_MUSIC_BED_DROPPED = "export.music_bed_dropped"

NOTICE_CODES = frozenset({SCRIPT_SHORT_OF_TARGET, EXPORT_MUSIC_BED_DROPPED})


class Notice(BaseModel):
    code: str
    # bool before int: bool is a subclass of int, and a union without it
    # coerces True to 1 — which a catalog sentence then renders as "1".
    data: dict[str, bool | int | float | str] = {}
