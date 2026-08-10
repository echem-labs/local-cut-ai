"""The picture a scene will actually be built from.

The board described only `{sid}.keyframe`, the node the template generates.
Conditioning a scene on an uploaded image rewires the clip's keyframe port to
the asset and leaves the generated node orphaned — so the board went on
describing a node that fed nothing, handing the card the artifact hash of the
picture that node had rendered earlier. The card showed the model's image
while the clip rendered from the user's, and nothing on screen said so.

`still` names whatever is on the clip's keyframe port when that is not the
generated node. Added beside `keyframe` rather than replacing it, because
both nodes still matter to different readers: the card draws the picture the
clip will use, while the flowchart indexes node status out of these same
slots and would otherwise lose the generated node's "not needed".
"""

import pytest

from localcut_engine.events import EventBus
from localcut_engine.graph.model import KEYFRAME_PORT
from localcut_engine.graph.patch import PatchOp
from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import ProjectStore
from localcut_engine.schema import Scene, Screenplay
from localcut_engine.service import ProjectService


@pytest.fixture
def service_and_project(tmp_path) -> tuple[ProjectService, str]:
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus())
    screenplay = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=4.0, narration="line", visual="v", motion="m")],
    )
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)
    project = store.create(title="t", graph=graph)
    return service, project.id


def _scene(service: ProjectService, project_id: str) -> dict:
    return service.scene_board(project_id)["scenes"][0]


def test_an_ordinary_scene_carries_no_still_of_its_own(service_and_project):
    # The generated keyframe IS the still in the ordinary case, and the board
    # is re-fetched through every render — so the common case must not ship a
    # second copy of the state directly above it.
    service, project_id = service_and_project
    scene = _scene(service, project_id)

    assert scene["keyframe"]["node_id"] == "s1.keyframe"
    assert "still" not in scene


def test_a_conditioned_scene_reports_the_users_image_as_its_still(service_and_project):
    # The card reads this to decide what picture to draw. With only the
    # orphaned generated node to go on, it drew the model's image over a clip
    # rendering from the user's.
    service, project_id = service_and_project
    asset = service.add_asset(project_id, "shot.png", b"\x89PNG\r\n\x1a\n" + b"x" * 32)

    service.patch(
        project_id,
        [PatchOp(op="connect", node_id="s1.clip", src=asset["node_id"], port=KEYFRAME_PORT)],
    )

    scene = _scene(service, project_id)
    assert scene["still"]["node_id"] == asset["node_id"]
    # Born cached, so it is fetchable the moment it lands — there is nothing
    # to render and nothing to wait for.
    assert scene["still"]["artifact_hash"] == asset["hash"]
    # And the generated node is still described, because the flowchart reads
    # its status from here and it is the thing now marked "not needed".
    assert scene["keyframe"]["node_id"] == "s1.keyframe"
    assert scene["keyframe"]["status"] == "skipped"


def test_an_uploaded_image_is_final_rather_than_a_draft(service_and_project):
    # "Draft" means a cheap first pass that a final render will replace. A
    # picture the user supplied is neither: it is the finished article and
    # will never be re-rendered, so the pill has to stop offering it as a
    # provisional version of something.
    service, project_id = service_and_project
    asset = service.add_asset(project_id, "shot.png", b"\x89PNG\r\n\x1a\n" + b"x" * 32)

    service.patch(
        project_id,
        [PatchOp(op="connect", node_id="s1.clip", src=asset["node_id"], port=KEYFRAME_PORT)],
    )

    assert _scene(service, project_id)["still"]["status"] == "final"


def test_a_scene_whose_keyframe_was_removed_still_reports_a_card(service_and_project):
    # `remove_node` on the generated keyframe leaves the clip with nothing on
    # that port. The slot is null rather than absent, which is the shape the
    # card already handles.
    service, project_id = service_and_project

    service.patch(project_id, [PatchOp(op="remove_node", node_id="s1.keyframe")])

    assert _scene(service, project_id)["keyframe"] is None
