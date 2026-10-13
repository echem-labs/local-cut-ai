"""What the script backend asks the local LLM server for, and when it lets go.

A 60s script job on qwen3:8b took eight minutes over three completions. Two
things made it slow, and both show up in the requests themselves:

- qwen3 thinks before it answers, on Ollama's OpenAI-compatible endpoint as
  well as its native one, and the thinking is generated output. It counts
  against `max_tokens` (Ollama hands that to the runner as num_predict)
  while none of it reaches `content`. One re-ask stopped at the 4096-token
  cap with no screenplay at all; another spent 3845 tokens to return 470
  tokens of JSON.
- `complete` released the model (`keep_alive: 0`) after every call, so each
  re-ask inside one job loaded the weights again.

The fake server here records every request, so a test reads what the engine
actually sent rather than what a helper says it would send.
"""

from __future__ import annotations

import httpx
import pytest

from localcut_engine.backends.base import ExecutionContext, GenerationError
from localcut_engine.backends.llm import LLMScriptBackend, script_max_tokens
from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import NodeKind
from localcut_engine.schema import Scene, Screenplay


def _screenplay(words: int) -> str:
    return Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=6.0, narration=" ".join(["bloom"] * words), visual="v")],
    ).model_dump_json()


SHORT = _screenplay(20)  # a few seconds against 60
ON_TARGET = _screenplay(150)  # inside the window for 60


class FakeServer:
    """Ollama, as far as the backend can tell: a chat endpoint answering from
    a queue, `/api/show` answering with `show`, and `/api/generate` (the
    unload) answering anything."""

    def __init__(self, replies: list[dict], show: dict | int | None = None) -> None:
        self.replies = list(replies)
        self.show = show
        self.calls: list[tuple[str, dict]] = []

    # Patched over httpx.AsyncClient.post as a bound method, which a class
    # attribute lookup does not rebind: the client is never passed in.
    async def post(self, url: str, json=None, **kwargs) -> httpx.Response:
        self.calls.append((url, json or {}))
        request = httpx.Request("POST", url)
        if url.endswith("/chat/completions"):
            reply = self.replies.pop(0)
            return httpx.Response(200, json={"choices": [reply]}, request=request)
        if url.endswith("/api/show"):
            if self.show is None:
                raise httpx.ConnectError("no native API here")
            if isinstance(self.show, int):
                return httpx.Response(self.show, json={}, request=request)
            return httpx.Response(200, json=self.show, request=request)
        return httpx.Response(200, json={}, request=request)

    def paths(self) -> list[str]:
        return [httpx.URL(url).path for url, _ in self.calls]

    def completions(self) -> list[dict]:
        return [body for url, body in self.calls if url.endswith("/chat/completions")]

    def unloads(self) -> list[dict]:
        return [body for url, body in self.calls if url.endswith("/api/generate")]


def _answer(content: str) -> dict:
    return {"message": {"content": content}, "finish_reason": "stop"}


# What a thinking model sends when the cap runs out mid-thought.
CUT_OFF = {"message": {"content": ""}, "finish_reason": "length"}


def _spec() -> JobSpec:
    return JobSpec(
        node_id="script",
        kind=NodeKind.SCRIPT,
        output_hash="d" * 64,
        params={"prompt": "how bees find flowers", "target_duration_s": 60},
        model=None,
        seed=0,
        input_hashes={},
    )


async def _run_script_job(monkeypatch, server: FakeServer) -> None:
    monkeypatch.setattr(httpx.AsyncClient, "post", server.post)
    ctx = ExecutionContext(output_dir=None)  # type: ignore[arg-type]
    monkeypatch.setattr(ctx, "publish_text", lambda *a, **k: None)
    await LLMScriptBackend(model="qwen3:8b").execute(_spec(), ctx)


# -- keeping the model loaded across one job's re-asks --------------------------


async def test_a_script_job_keeps_the_model_loaded_across_its_re_asks(monkeypatch):
    """The real job: a short draft, a re-ask, then one on target. The model
    is released once, after the last answer, not between them."""
    server = FakeServer([_answer(SHORT), _answer(ON_TARGET)])

    await _run_script_job(monkeypatch, server)

    assert len(server.completions()) == 2
    assert server.unloads() == [{"model": "qwen3:8b", "keep_alive": 0}]
    # Yielded at the end, so ComfyUI gets the VRAM before the next job.
    assert server.paths()[-1] == "/api/generate"


async def test_a_re_ask_cut_off_mid_thought_does_not_unload_between_asks(monkeypatch):
    server = FakeServer([_answer(SHORT), CUT_OFF, _answer(ON_TARGET)])

    await _run_script_job(monkeypatch, server)

    assert len(server.completions()) == 3
    assert len(server.unloads()) == 1
    assert server.paths()[-1] == "/api/generate"


async def test_a_failed_script_job_still_yields_the_model(monkeypatch):
    """ComfyUI runs next on the same GPU. A job that failed with the model
    loaded used to leave it resident until Ollama's own keep-alive ran out."""
    server = FakeServer([CUT_OFF])

    with pytest.raises(GenerationError, match="output cap"):
        await _run_script_job(monkeypatch, server)

    assert server.unloads() == [{"model": "qwen3:8b", "keep_alive": 0}]


async def test_a_single_completion_still_yields_when_it_fails(monkeypatch):
    """The publish kit and the natural-language editor go through `complete`,
    one call each, and are held to the same discipline on the way out."""
    server = FakeServer([CUT_OFF])
    monkeypatch.setattr(httpx.AsyncClient, "post", server.post)

    with pytest.raises(GenerationError):
        await LLMScriptBackend(model="qwen3:8b").complete("p", system="s", max_tokens=1024)

    assert len(server.unloads()) == 1


# -- thinking ---------------------------------------------------------------------


async def _one_completion(monkeypatch, show) -> dict:
    server = FakeServer([_answer(ON_TARGET)], show=show)
    monkeypatch.setattr(httpx.AsyncClient, "post", server.post)
    backend = LLMScriptBackend(model="qwen3:8b", unload_after=False)
    await backend.complete("p", system="s", max_tokens=4096)
    (body,) = server.completions()
    return body


async def test_a_model_that_can_stop_thinking_is_asked_not_to(monkeypatch):
    """Ollama 0.34.3 and later say so in `/api/show`; qwen3's template takes
    both. `reasoning_effort: "none"` is the OpenAI-compatible way to ask,
    and Ollama maps it to think=false."""
    body = await _one_completion(
        monkeypatch,
        {"capabilities": ["completion", "thinking"], "thinking": {"values": [False, True]}},
    )

    assert body["reasoning_effort"] == "none"
    assert body["max_tokens"] == 4096


@pytest.mark.parametrize(
    "show",
    [
        # Thinks, and says it cannot be turned off (the older qwen3 template).
        {"capabilities": ["completion", "thinking"], "thinking": {"values": [True]}},
        # Named levels only.
        {"capabilities": ["thinking"], "thinking": {"values": ["low", "medium", "high"]}},
        # An Ollama from before the `thinking` field: it thinks, and whether
        # "none" would be accepted depends on a version this cannot see.
        {"capabilities": ["completion", "thinking"]},
    ],
    ids=["always-thinks", "levels-only", "older-ollama"],
)
async def test_a_model_that_thinks_regardless_gets_room_to_answer(monkeypatch, show):
    from localcut_engine.backends.llm import THINKING_TOKENS

    body = await _one_completion(monkeypatch, show)

    assert "reasoning_effort" not in body
    assert body["max_tokens"] == 4096 + THINKING_TOKENS


@pytest.mark.parametrize(
    "show",
    [
        pytest.param(None, id="llama.cpp-no-native-api"),
        pytest.param(404, id="unknown-route"),
        pytest.param({"capabilities": ["completion"]}, id="does-not-think"),
    ],
)
async def test_a_request_stays_plain_where_thinking_is_not_in_play(monkeypatch, show):
    """llama.cpp and other OpenAI-compatible servers serve no `/api/show`,
    and a field they do not know is a field some of them refuse. A model
    that does not think needs nothing either."""
    body = await _one_completion(monkeypatch, show)

    assert "reasoning_effort" not in body
    assert body["max_tokens"] == 4096


async def test_every_screenplay_ask_turns_thinking_off(monkeypatch):
    """Through the job as well as `complete`: the screenplay call is the one
    that was cut off."""
    server = FakeServer(
        [_answer(SHORT), _answer(ON_TARGET)],
        show={"capabilities": ["thinking"], "thinking": {"values": [False, True]}},
    )

    await _run_script_job(monkeypatch, server)

    for body in server.completions():
        assert body["reasoning_effort"] == "none"
        assert body["max_tokens"] == script_max_tokens(_spec().params)
