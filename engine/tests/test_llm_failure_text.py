"""What a failed job says happened.

A publish-kit job sat on a wedged Ollama for the full 600s timeout and was
recorded as `failed` with `error: ""`. Every surface that reads a failure
reads that field, so the app had a node marked failed and not one word about
why — indistinguishable, on screen, from a job still running.

Two holes, and both are the same shape: a message that comes from an
exception nobody wrote a sentence for. `httpx`'s timeouts carry an empty
`str()` (the message lives in the type name), and the scheduler stores
`str(exc)` for anything a backend raises. So the backend names the timeout
it chose, and the scheduler refuses to record an empty reason from any
backend — the second is the backstop for the exception type nobody has met
yet.
"""

from __future__ import annotations

import httpx
import pytest

from localcut_engine.backends.base import GenerationError
from localcut_engine.backends.llm import LLMScriptBackend
from localcut_engine.jobs.scheduler import failure_text


def test_a_timeout_names_itself_rather_than_failing_blank(monkeypatch):
    """The real one: Ollama accepted the connection and never answered."""

    async def hang(self_client, url, **kwargs):
        raise httpx.ReadTimeout("")

    monkeypatch.setattr(httpx.AsyncClient, "post", hang)
    backend = LLMScriptBackend(model="llama3.2", timeout_s=600, unload_after=False)

    with pytest.raises(GenerationError) as raised:
        import asyncio

        asyncio.run(backend.complete("write a title", system="be brief"))

    message = str(raised.value)
    assert message.strip(), "a failure with no message is what this exists to prevent"
    assert "600" in message  # the ceiling it actually waited on
    assert "llama3.2" in message  # which model did not answer


def test_a_server_that_is_not_there_says_so(monkeypatch):
    """The same hole, one connection earlier: httpx.ConnectError's str() is
    the address at best and empty at worst."""

    async def refused(self_client, url, **kwargs):
        raise httpx.ConnectError("")

    monkeypatch.setattr(httpx.AsyncClient, "post", refused)
    backend = LLMScriptBackend(model="llama3.2", unload_after=False)

    with pytest.raises(GenerationError) as raised:
        import asyncio

        asyncio.run(backend.complete("write a title", system="be brief"))

    assert str(raised.value).strip()


def test_the_scheduler_never_records_a_blank_reason():
    """The backstop. Whatever a backend raises, the recorded failure has to
    say something a person can act on — the type name is a poorer answer
    than a sentence, and a far better one than "".
    """
    assert failure_text(httpx.ReadTimeout("")) == "ReadTimeout"
    assert failure_text(ValueError("   ")) == "ValueError"
    # A message that says something is left exactly as it is.
    assert failure_text(GenerationError("local LLM error: model not found")) == (
        "local LLM error: model not found"
    )
