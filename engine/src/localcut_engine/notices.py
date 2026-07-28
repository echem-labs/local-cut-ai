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
"""

from __future__ import annotations

from pydantic import BaseModel, field_validator

# The script model could not reach target_duration_s and the longest attempt
# was rendered instead. data: target_s, estimated_s, words.
SCRIPT_SHORT_OF_TARGET = "script.short_of_target"

NOTICE_CODES = frozenset({SCRIPT_SHORT_OF_TARGET})


class Notice(BaseModel):
    code: str
    data: dict[str, str | int | float] = {}

    @field_validator("code")
    @classmethod
    def _registered(cls, code: str) -> str:
        # An unregistered code has no catalog entry anywhere, so it would
        # cross the wire and render as nothing on every UI. Refusing it here
        # turns that silent nothing into a test failure at the emit site.
        if code not in NOTICE_CODES:
            raise ValueError(f"unregistered notice code: {code!r}")
        return code
