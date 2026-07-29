"""The model a job actually rendered with, stamped onto the job record.

`spec.model` is the *request* (usually None — "whatever the backend is
configured with"), and config can change between runs. The only honest
source for "which model produced this artifact" is the backend at execute
time, so it records the name on the ExecutionContext and the scheduler
persists it with the finished job — the same trip notices make.
"""

import asyncio


from localcut_engine.backends.base import (
    BackendRegistry,
    ExecutionBackend,
    ExecutionContext,
)
from localcut_engine.events import EventBus
from localcut_engine.graph.model import NodeKind
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.jobs.scheduler import Scheduler
from localcut_engine.project.store import ProjectStore
from localcut_engine.service import ProjectService


def test_record_model_lands_on_the_context():
    ctx = ExecutionContext(output_dir=None)  # type: ignore[arg-type]
    assert ctx.model_used is None
    ctx.record_model("llama3.2")
    assert ctx.model_used == "llama3.2"


async def test_scheduler_persists_the_recorded_model(tmp_path):
    """A finished job carries the model its backend reported; /jobs already
    serializes the whole record, so this is all the API needs."""

    class Recording(ExecutionBackend):
        name = "recording-stub"

        def supports(self, kind):
            return True

        async def execute(self, spec, ctx):
            ctx.record_model("stub-model-9b")
            return ctx.publish_text(spec.output_hash, ".screenplay.json", "{}")

    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)
    backends = BackendRegistry()
    backends.register(Recording())
    scheduler = Scheduler(
        queue=queue,
        backends=backends,
        events=events,
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
        on_job_done=service.on_job_done,
    )
    service.scheduler = scheduler
    scheduler.start()
    try:
        project = service.create_tool("script", {"prompt": "stamp me"})
        for _ in range(400):
            jobs = queue.list(project.id, 10)
            done = [j for j in jobs if j.spec.node_id == "script" and j.status.value == "done"]
            if done:
                assert done[0].model == "stub-model-9b"
                break
            await asyncio.sleep(0.02)
        else:
            raise AssertionError("script job never finished")
    finally:
        await scheduler.stop()


async def test_llm_backend_records_the_model_it_completed_with(monkeypatch):
    """The local script backend reports the resolved Ollama model name —
    the config default when the node does not override it."""
    import httpx

    from localcut_engine.backends.llm import LLMScriptBackend
    from localcut_engine.graph.compiler import JobSpec
    from localcut_engine.schema import Scene, Screenplay

    body = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=6.0, narration=" ".join(["w"] * 230), visual="v")],
    ).model_dump_json()

    calls: list[dict] = []

    async def fake_post(self, url, json=None, **kwargs):
        calls.append({"url": url, "json": json})
        if url.endswith("/chat/completions"):
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": body}, "finish_reason": "stop"}]},
                request=httpx.Request("POST", url),
            )
        return httpx.Response(200, json={}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    backend = LLMScriptBackend(model="llama3.2")
    spec = JobSpec(
        node_id="script",
        kind=NodeKind.SCRIPT,
        output_hash="c" * 64,
        params={"prompt": "p", "target_duration_s": 60},
        model=None,
        seed=0,
        input_hashes={},
    )
    ctx = ExecutionContext(output_dir=None)  # type: ignore[arg-type]

    async def publish(output_hash, suffix, text):
        return None

    monkeypatch.setattr(ctx, "publish_text", lambda *a, **k: None)
    await backend.execute(spec, ctx)
    assert ctx.model_used == "llama3.2"
    assert calls[0]["json"]["model"] == "llama3.2"


# -- script model selection ---------------------------------------------------


def test_resolve_model_prefers_the_nodes_choice():
    from localcut_engine.backends.llm import LLMScriptBackend

    backend = LLMScriptBackend(model="qwen3:14b")
    assert backend.resolve_model(None) == "qwen3:14b"
    assert backend.resolve_model("") == "qwen3:14b"
    # The `local:` routing prefix never reaches the server — it knows only
    # bare names.
    assert backend.resolve_model("local:phi4") == "phi4"
    assert backend.resolve_model("llama3.2:latest") == "llama3.2:latest"


async def test_execute_completes_with_the_nodes_model(monkeypatch):
    import httpx

    from localcut_engine.backends.llm import LLMScriptBackend
    from localcut_engine.graph.compiler import JobSpec
    from localcut_engine.schema import Scene, Screenplay

    body = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=6.0, narration=" ".join(["w"] * 230), visual="v")],
    ).model_dump_json()
    calls: list[dict] = []

    async def fake_post(self, url, json=None, **kwargs):
        calls.append({"url": url, "json": json})
        if url.endswith("/chat/completions"):
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": body}, "finish_reason": "stop"}]},
                request=httpx.Request("POST", url),
            )
        return httpx.Response(200, json={}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    backend = LLMScriptBackend(model="qwen3:14b")
    spec = JobSpec(
        node_id="script",
        kind=NodeKind.SCRIPT,
        output_hash="d" * 64,
        params={"prompt": "p", "target_duration_s": 60},
        model="local:phi4",
        seed=0,
        input_hashes={},
    )
    ctx = ExecutionContext(output_dir=None)  # type: ignore[arg-type]
    monkeypatch.setattr(ctx, "publish_text", lambda *a, **k: None)
    await backend.execute(spec, ctx)

    assert ctx.model_used == "phi4"
    completion = next(c for c in calls if c["url"].endswith("/chat/completions"))
    assert completion["json"]["model"] == "phi4"
    # The VRAM yield must release the model that was actually loaded.
    unload = next(c for c in calls if c["url"].endswith("/api/generate"))
    assert unload["json"]["model"] == "phi4"


async def test_list_models_reads_the_openai_compat_surface(monkeypatch):
    import httpx

    from localcut_engine.backends.llm import LLMScriptBackend

    async def fake_get(self, url, **kwargs):
        assert url.endswith("/v1/models")
        return httpx.Response(
            200,
            json={"data": [{"id": "llama3.2:latest"}, {"id": "phi4"}, {"object": "junk"}]},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    backend = LLMScriptBackend(base_url="http://127.0.0.1:11434")
    assert await backend.list_models() == ["llama3.2:latest", "phi4"]
