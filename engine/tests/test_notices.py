"""The non-fatal notice channel: node -> job record -> scene board.

`error` already flows that way, but an error is a job that did not finish.
A notice is a job that finished with something the user should know — the
first one: a screenplay that stays short of its target after every re-ask
now *renders* instead of failing, and before this channel existed the only
trace was a server log no desktop user ever sees.
"""

from conftest import make_spec

from localcut_engine.backends.base import ExecutionContext
from localcut_engine.graph.model import NodeKind
from localcut_engine.notices import SCRIPT_SHORT_OF_TARGET, Notice


def test_an_unregistered_code_is_dropped_not_raised():
    """An advisory must never break the thing it is advising about. The
    registry is a *write*-side guard: emitting a code with no catalog entry
    is a bug, but failing the user's render over it trades a missing sentence
    for a missing video."""
    ctx = ExecutionContext(output_dir=None)  # type: ignore[arg-type]
    ctx.notify("script.totally_new_code", target_s=60)
    assert ctx.notices == []


def test_a_code_from_a_newer_build_still_reads():
    """The read side must be forward-compatible. Job payloads carry notices,
    and a payload this build cannot parse is skipped whole by
    JobQueue._hydrate — so a strict read would make one unknown code delete a
    finished job from the board, losing its status and progress with it."""
    notice = Notice.model_validate({"code": "clip.some_future_code", "data": {"n": 1}})
    assert notice.code == "clip.some_future_code"


def test_notice_data_keeps_a_bool_a_bool():
    """bool is a subclass of int, so a union without it silently renders
    True as "1" in a catalog sentence."""
    assert Notice(code=SCRIPT_SHORT_OF_TARGET, data={"ok": True}).data["ok"] is True


def test_notice_data_survives_a_json_round_trip():
    notice = Notice(code=SCRIPT_SHORT_OF_TARGET, data={"target_s": 60, "estimated_s": 45})
    assert Notice.model_validate_json(notice.model_dump_json()) == notice


def test_context_notify_accumulates_in_order():
    ctx = ExecutionContext(output_dir=None)  # type: ignore[arg-type]
    ctx.notify(SCRIPT_SHORT_OF_TARGET, target_s=60, estimated_s=45, words=148)
    assert [n.code for n in ctx.notices] == [SCRIPT_SHORT_OF_TARGET]
    assert ctx.notices[0].data == {"target_s": 60, "estimated_s": 45, "words": 148}


def test_job_record_carries_notices(tmp_path):
    """Jobs persist as whole JSON payloads, so the field rides along with no
    migration — but only if the model actually declares it."""
    from localcut_engine.jobs.models import Job
    from localcut_engine.jobs.queue import JobQueue

    queue = JobQueue(tmp_path / "queue.db")
    job = Job(
        project_id="p1",
        spec=make_spec(NodeKind.SCRIPT),
        notices=[Notice(code=SCRIPT_SHORT_OF_TARGET, data={"target_s": 60})],
    )
    queue.put(job)
    stored = queue.list("p1")[0]
    assert stored.notices[0].code == SCRIPT_SHORT_OF_TARGET
    assert stored.notices[0].data == {"target_s": 60}


def test_board_surfaces_a_done_jobs_notices(tmp_path):
    """The board cell mirrors `error`'s path: the notice of the job that
    produced the node's current output rides the cell to the UI."""
    from conftest import make_spec as _  # noqa: F401  (harness import kept close)

    from localcut_engine.events import EventBus
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.jobs.models import Job, JobStatus
    from localcut_engine.jobs.queue import JobQueue
    from localcut_engine.project.store import ProjectStore
    from localcut_engine.schema import Scene, Screenplay
    from localcut_engine.service import ProjectService

    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, EventBus())
    screenplay = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
    )
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)
    project = store.create(title="t", graph=graph)

    script_hash = graph.output_hash("script", {})
    queue.put(
        Job(
            project_id=project.id,
            spec=make_spec(NodeKind.SCRIPT, node_id="script", output_hash=script_hash),
            status=JobStatus.DONE,
            notices=[
                Notice(
                    code=SCRIPT_SHORT_OF_TARGET,
                    data={"target_s": 60, "estimated_s": 45, "words": 148},
                )
            ],
        )
    )
    cell = service.scene_board(project.id)["aux"]["script"]
    assert cell["notices"] == [
        {
            "code": SCRIPT_SHORT_OF_TARGET,
            "data": {"target_s": 60, "estimated_s": 45, "words": 148},
        }
    ]


async def test_short_settle_reaches_notify():
    """The emit site: settling short must hand the numbers to notify, so the
    scene board can explain the length instead of a server log."""
    from localcut_engine.backends.llm import screenplay_within_target
    from localcut_engine.schema import Scene, Screenplay

    def scenes(words: int) -> str:
        return Screenplay(
            title="t",
            scenes=[Scene(id="s1", duration_s=6.0, narration=" ".join(["w"] * words), visual="v")],
        ).model_dump_json()

    async def ask(prompt: str) -> str:
        return scenes(50)  # ~15s: never reaches a 60s target

    seen: list[tuple[str, dict]] = []
    await screenplay_within_target(
        {"target_duration_s": 60},
        ask,
        notify=lambda code, **data: seen.append((code, data)),
    )
    assert [code for code, _ in seen] == [SCRIPT_SHORT_OF_TARGET]
    assert seen[0][1]["target_s"] == 60
    assert seen[0][1]["words"] == 50
    assert 0 < seen[0][1]["estimated_s"] < 60


async def test_a_screenplay_on_target_emits_no_notice():
    from localcut_engine.backends.llm import screenplay_within_target
    from localcut_engine.schema import Scene, Screenplay

    async def ask(prompt: str) -> str:
        return Screenplay(
            title="t",
            scenes=[Scene(id="s1", duration_s=6.0, narration=" ".join(["w"] * 230), visual="v")],
        ).model_dump_json()

    seen: list[str] = []
    await screenplay_within_target(
        {"target_duration_s": 60}, ask, notify=lambda code, **data: seen.append(code)
    )
    assert seen == []
