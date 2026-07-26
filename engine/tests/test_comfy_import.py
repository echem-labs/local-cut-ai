"""The gate on imported ComfyUI workflows (doc 07 risk 9).

A custom node is arbitrary Python running inside the ComfyUI process, which
holds the user's models, their disk and the network. So an imported workflow
is a code-execution vector, and the tests here are about the gate rather than
the plumbing: what gets in, what does not, and — the part that is easy to get
wrong — that a pack is inert until somebody says otherwise.
"""

from __future__ import annotations

import json

import pytest

from localcut_engine.comfy import allowlist, workflows

# The smallest thing that is recognisably an API-format workflow: node ids
# mapping to {class_type, inputs}.
_BUILTIN_WORKFLOW = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd.safetensors"}},
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "%%PROMPT%%", "clip": ["1", 1]}},
    "3": {"class_type": "KSampler", "inputs": {"seed": "%%SEED%%", "model": ["1", 0]}},
    "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
}

_PACK_NODE = "VHS_VideoCombine"  # from the catalogued VideoHelperSuite pack


def _with_pack() -> dict:
    return {
        **_BUILTIN_WORKFLOW,
        "5": {"class_type": _PACK_NODE, "inputs": {"images": ["4", 0]}},
    }


# -- the allowlist itself ----------------------------------------------------


def test_the_packaged_templates_are_all_within_the_builtin_set():
    """The seed list is only defensible because the workflows this app ships
    already run on it. If a packaged template used a class_type the allowlist
    rejects, the allowlist would be refusing our own output — and every claim
    about it being 'stock ComfyUI' would be unfounded."""
    import glob
    import pathlib

    builtin, _ = allowlist.load_catalog()
    root = pathlib.Path(workflows.__file__).parent.parent / "comfy_templates"
    seen: set[str] = set()
    for path in glob.glob(str(root / "*.json")):
        seen |= set(workflows.class_types(json.loads(pathlib.Path(path).read_text())))

    assert seen, "no packaged templates were read — this test would pass on nothing"
    assert seen <= builtin, (
        f"packaged templates use non-allowlisted nodes: {sorted(seen - builtin)}"
    )


def test_a_catalogued_pack_grants_nothing_until_it_is_enabled(tmp_path):
    """The whole point. A pack being *described* by this build is not the
    operator agreeing to run its code."""
    current = allowlist.current(tmp_path)

    assert current.pack_for(_PACK_NODE) is not None, "the pack should be catalogued"
    assert not current.allows(_PACK_NODE), "a catalogued pack must not be allowed by default"
    assert current.grants == {}


def test_enabling_a_pack_needs_the_acknowledgement_and_a_version(tmp_path):
    """Risk 9 asks for an explicit opt-in with a code-execution warning, and
    for the set to be pinned. Neither is inferable from the request."""
    with pytest.raises(ValueError, match="third-party Python"):
        allowlist.enable_pack(tmp_path, "video-helper-suite", "1.2.3", acknowledged=False)
    with pytest.raises(ValueError, match="version of the pack"):
        allowlist.enable_pack(tmp_path, "video-helper-suite", "", acknowledged=True)

    # And nothing was recorded on the way through either refusal.
    assert allowlist.load_grants(tmp_path) == {}


def test_an_enabled_pack_is_allowed_and_records_what_is_installed(tmp_path):
    grant = allowlist.enable_pack(tmp_path, "video-helper-suite", "1.2.3", acknowledged=True)

    assert grant.version == "1.2.3"
    assert allowlist.current(tmp_path).allows(_PACK_NODE)
    # Survives a reload: the grant is engine state, not process state.
    assert allowlist.load_grants(tmp_path) == {"video-helper-suite": "1.2.3"}


def test_disabling_a_pack_revokes_it(tmp_path):
    allowlist.enable_pack(tmp_path, "video-helper-suite", "1.2.3", acknowledged=True)

    assert allowlist.disable_pack(tmp_path, "video-helper-suite") is True
    assert not allowlist.current(tmp_path).allows(_PACK_NODE)
    assert allowlist.disable_pack(tmp_path, "video-helper-suite") is False  # already gone


def test_an_uncatalogued_pack_cannot_be_enabled(tmp_path):
    """Otherwise the catalog is decoration: anyone could name a pack id and
    have it recorded as granted."""
    with pytest.raises(KeyError, match="unknown node pack"):
        allowlist.enable_pack(tmp_path, "whatever-i-typed", "1.0", acknowledged=True)


def test_a_corrupt_grants_file_reads_as_nothing_enabled(tmp_path):
    """The failure direction has to be losing a grant the operator can re-make,
    never inheriting one they never gave."""
    (tmp_path / "comfy-node-packs.json").write_text("{ this is not json", encoding="utf-8")

    assert allowlist.load_grants(tmp_path) == {}
    assert not allowlist.current(tmp_path).allows(_PACK_NODE)


def test_a_grant_with_a_junk_version_is_dropped(tmp_path):
    """The state file is on disk and hand-editable; a version that is not
    version-shaped is a sign of tampering or corruption, not a pin."""
    (tmp_path / "comfy-node-packs.json").write_text(
        json.dumps({"enabled": {"video-helper-suite": "../../etc/passwd"}}), encoding="utf-8"
    )

    assert allowlist.load_grants(tmp_path) == {}


# -- reviewing a workflow ----------------------------------------------------


def test_a_builtin_only_workflow_passes(tmp_path):
    verdict = workflows.review(_BUILTIN_WORKFLOW, allowlist.current(tmp_path))

    assert verdict.ok
    assert verdict.unknown_nodes == []
    assert verdict.placeholders == ["%%SEED%%", "%%PROMPT%%"]
    assert verdict.warnings == []


def test_a_workflow_needing_a_disabled_pack_is_rejected_by_name(tmp_path):
    """'Node VHS_VideoCombine is not allowed' sends someone hunting. Naming
    the pack — and its repo — is the difference between a dead end and a
    decision."""
    current = allowlist.current(tmp_path)
    verdict = workflows.review(_with_pack(), current)

    assert not verdict.ok
    assert verdict.packs_missing == ["video-helper-suite"]
    message = workflows.rejection(verdict, current)
    assert "ComfyUI-VideoHelperSuite" in message
    assert "github.com" in message


def test_the_same_workflow_passes_once_the_pack_is_enabled(tmp_path):
    allowlist.enable_pack(tmp_path, "video-helper-suite", "1.2.3", acknowledged=True)

    verdict = workflows.review(_with_pack(), allowlist.current(tmp_path))

    assert verdict.ok
    assert verdict.packs_required == ["video-helper-suite"]


def test_a_node_from_no_known_pack_is_rejected_as_unknown(tmp_path):
    """Distinct from the pack case: there is nothing to enable, so the message
    must not imply there is."""
    hostile = {**_BUILTIN_WORKFLOW, "9": {"class_type": "RunArbitraryPython", "inputs": {}}}
    current = allowlist.current(tmp_path)

    verdict = workflows.review(hostile, current)

    assert verdict.unknown_nodes == ["RunArbitraryPython"]
    assert "not in any catalogued pack" in workflows.rejection(verdict, current)


def test_a_workflow_with_no_placeholders_imports_with_a_warning(tmp_path):
    """Not an error — a fixed workflow is a legitimate thing to import. But
    it renders the same frame every time, which is worth saying once at
    import rather than leaving someone to notice across four scenes."""
    fixed = {"1": {"class_type": "SaveImage", "inputs": {}}}

    verdict = workflows.review(fixed, allowlist.current(tmp_path))

    assert verdict.ok
    assert verdict.placeholders == []
    assert any("%%PLACEHOLDER%%" in w for w in verdict.warnings)


# -- parsing -----------------------------------------------------------------


def test_the_editor_save_format_is_named_rather_than_called_invalid():
    """ComfyUI exports two shapes and its own API rejects one of them. This is
    the most common import failure there is, and 'invalid workflow' leaves the
    user with no idea that a different menu item fixes it."""
    ui_export = {"last_node_id": 9, "nodes": [{"type": "KSampler"}], "links": []}

    with pytest.raises(workflows.WorkflowError, match="Export \\(API\\)"):
        workflows.parse_workflow(ui_export)


def test_junk_is_refused_with_a_reason():
    with pytest.raises(workflows.WorkflowError, match="not valid JSON"):
        workflows.parse_workflow("{{{")
    with pytest.raises(workflows.WorkflowError, match="JSON object"):
        workflows.parse_workflow("[]")
    with pytest.raises(workflows.WorkflowError, match="empty"):
        workflows.parse_workflow({})


def test_a_node_with_no_class_type_cannot_slip_past_the_allowlist():
    """A node the allowlist has nothing to check is not a node that passes."""
    with pytest.raises(workflows.WorkflowError, match="no usable class_type"):
        workflows.class_types({"1": {"inputs": {}}})
    with pytest.raises(workflows.WorkflowError, match="no usable class_type"):
        workflows.class_types({"1": {"class_type": {"nested": "object"}}})
    with pytest.raises(workflows.WorkflowError, match="not an object"):
        workflows.class_types({"1": "CheckpointLoaderSimple"})


def test_a_class_type_shaped_like_a_path_is_refused():
    """It is compared against the allowlist and echoed into messages; nothing
    downstream should ever see a separator in it."""
    with pytest.raises(workflows.WorkflowError, match="no usable class_type"):
        workflows.class_types({"1": {"class_type": "../../etc/passwd"}})


# -- storage -----------------------------------------------------------------


def test_an_imported_workflow_lands_where_the_backend_looks(tmp_path):
    """The ComfyUI backend prefers <data_dir>/comfy-templates over its
    packaged defaults. Writing anywhere else would import a workflow that is
    never used, with nothing to say so."""
    path = workflows.store(tmp_path, "my-clip", _BUILTIN_WORKFLOW)

    assert path == tmp_path / "comfy-templates" / "my-clip.json"
    assert json.loads(path.read_text(encoding="utf-8")) == _BUILTIN_WORKFLOW


def test_a_workflow_name_can_never_be_a_path(tmp_path):
    """It becomes a filename in a directory the render path reads."""
    for hostile in ("../escape", "a/b", "C:\\evil", "", "UPPER", "with space"):
        with pytest.raises(workflows.WorkflowError):
            workflows.store(tmp_path, hostile, _BUILTIN_WORKFLOW)


def test_listing_says_what_each_workflow_can_be_driven_by(tmp_path):
    workflows.store(tmp_path, "driven", _BUILTIN_WORKFLOW)
    workflows.store(tmp_path, "fixed", {"1": {"class_type": "SaveImage", "inputs": {}}})

    rows = {row["name"]: row for row in workflows.installed(tmp_path)}

    assert rows["driven"]["placeholders"] == ["%%SEED%%", "%%PROMPT%%"]
    assert rows["fixed"]["placeholders"] == []
    assert rows["driven"]["nodes"] == 4


def test_an_unreadable_workflow_is_still_listed(tmp_path):
    """It is on disk and it shadows a packaged template of the same name.
    Hiding it would make that shadowing invisible — the template stops
    working and nothing in the UI shows why."""
    directory = workflows.templates_dir(tmp_path)
    directory.mkdir(parents=True)
    (directory / "clip_default.json").write_text("truncated{", encoding="utf-8")

    rows = workflows.installed(tmp_path)

    assert rows == [{"name": "clip_default", "nodes": 0, "placeholders": [], "readable": False}]


def test_removing_a_workflow_reports_whether_there_was_one(tmp_path):
    workflows.store(tmp_path, "temporary", _BUILTIN_WORKFLOW)

    assert workflows.remove(tmp_path, "temporary") is True
    assert workflows.remove(tmp_path, "temporary") is False
    assert workflows.installed(tmp_path) == []


def test_listing_an_engine_that_never_imported_anything_is_empty(tmp_path):
    assert workflows.installed(tmp_path) == []


def test_the_size_cap_applies_to_a_parsed_workflow_too():
    """The API route takes a dict (FastAPI already parsed the body) and the
    CLI parses the file before posting it, so a cap that only measured
    `str | bytes` never ran in production. The node count does not catch it:
    four nodes whose inputs are megabytes of text pass it, and the document is
    then written into the templates directory, where the ComfyUI backend
    re-reads it on every render."""
    fat = {
        **_BUILTIN_WORKFLOW,
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "x" * (1 << 20)}},
    }

    with pytest.raises(workflows.WorkflowError, match="larger than"):
        workflows.parse_workflow(fat)

    # The same document as a string was always refused; the point is that the
    # two answers now agree.
    with pytest.raises(workflows.WorkflowError, match="larger than"):
        workflows.parse_workflow(json.dumps(fat))
