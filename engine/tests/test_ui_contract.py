"""Bounds the desktop UI mirrors from the engine.

The desktop has its own suite now, but it runs against the TypeScript alone —
nothing there can know what the engine actually sends. Values duplicated
across the boundary therefore still have nothing asserting they agree, and
DURATION_BOUNDS has already drifted once. These tests parse the TypeScript
source and compare it against the Python constants, which costs nothing and
fails loudly on the next drift.

Skipped when the desktop app is not checked out beside the engine (an
engine-only deployment is a supported layout).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_DESKTOP = Path(__file__).resolve().parents[2] / "apps" / "desktop"
_FORMATS = _DESKTOP / "src" / "lib" / "formats.ts"
_ENGINE_TS = _DESKTOP / "electron" / "engine.ts"
_U7 = _DESKTOP / "scripts" / "rig" / "u7.mjs"

# Every file this module reads, not just the first one it happened to need: a
# checkout carrying the app source without the rig scripts raises
# FileNotFoundError out of a contract test, which says nothing about the
# contract. The promise here is to stand aside when the desktop is not present.
pytestmark = pytest.mark.skipif(
    not all(path.exists() for path in (_FORMATS, _ENGINE_TS, _U7)),
    reason="desktop app not present beside the engine",
)


def _source() -> str:
    return _FORMATS.read_text(encoding="utf-8")


def _number(pattern: str) -> float:
    match = re.search(pattern, _source())
    assert match, f"{_FORMATS.name} no longer matches {pattern!r} — update this test with it"
    return float(match.group(1))


def test_target_duration_bounds_match_the_api():
    """DURATION_BOUNDS mirrors CreateProject.target_duration_s. A UI maximum
    above the API's produces a 422 the user cannot act on; below it, a length
    the engine would happily accept is unreachable."""
    import inspect

    from localcut_engine.api import app as app_module

    source = inspect.getsource(app_module)
    api = re.search(r"target_duration_s: int = Field\(default=\d+, ge=(\d+), le=(\d+)\)", source)
    assert api, "the target_duration_s Field no longer matches — update this test with it"

    bounds = re.search(r"DURATION_BOUNDS = \{ min: (\d+), max: (\d+) \}", _source())
    assert bounds, "DURATION_BOUNDS no longer matches — update this test with it"
    assert bounds.group(1) == api.group(1), "UI minimum duration drifted from the API"
    assert bounds.group(2) == api.group(2), "UI maximum duration drifted from the API"


def test_clip_duration_bounds_match_the_editor():
    """The Inspector clamps duration_s to these before sending. Drift means
    either a value the engine silently re-clamps (so the UI lies about what
    was saved) or one it rejects outright."""
    from localcut_engine.graph.editor import _CLIP_MAX_S, _CLIP_MIN_S

    assert _number(r"export const CLIP_MIN_S = ([\d.]+)") == _CLIP_MIN_S
    assert _number(r"export const CLIP_MAX_S = ([\d.]+)") == _CLIP_MAX_S


def test_speed_bounds_match_the_editor():
    from localcut_engine.graph.editor import _SPEED_MAX, _SPEED_MIN

    assert _number(r"export const SPEED_MIN = ([\d.]+)") == _SPEED_MIN
    assert _number(r"export const SPEED_MAX = ([\d.]+)") == _SPEED_MAX


def test_the_ws_token_subprotocol_matches_on_both_sides():
    """The client offers this marker and the server must echo it back; a
    mismatch fails every WebSocket handshake, so the app connects and then
    never receives a progress event again."""
    from localcut_engine.api.app import WS_TOKEN_SUBPROTOCOL

    client = _FORMATS.parent.parent / "api" / "client.ts"
    match = re.search(r'const WS_TOKEN_SUBPROTOCOL = "([^"]+)"', client.read_text(encoding="utf-8"))
    assert match, "client.ts no longer declares WS_TOKEN_SUBPROTOCOL"
    assert match.group(1) == WS_TOKEN_SUBPROTOCOL


def test_the_desktop_can_recognise_a_bind_the_engine_refused():
    """The one line that separates two failures the app must answer opposite
    ways: a port whose last socket has not been released (wait ~60s and the
    engine comes back on its own) and an engine that fell over at startup for
    its own reasons (say so now). The desktop reads it off stderr, so a
    reworded message would silently turn the first into the second — the app
    would report a crashed engine as unrecoverable a minute too early."""
    from localcut_engine.cli import BIND_REFUSED

    # All three copies, not just the desktop's. u7.mjs greps the app log for
    # this to prove the restart it measured actually outlived a held port; a
    # reworded message would leave that gate counting nothing and reporting
    # success, which is the opposite of what a contract test is for.
    for path, pattern in (
        (_ENGINE_TS, r'export const BIND_REFUSED = "([^"]+)"'),
        (_U7, r'const BIND_REFUSED = "([^"]+)"'),
    ):
        match = re.search(pattern, path.read_text(encoding="utf-8"))
        assert match, f"{path.name} no longer declares BIND_REFUSED"
        assert match.group(1) == BIND_REFUSED, f"{path.name} disagrees with cli.py"


def test_the_u7_gate_can_recognise_the_wait_it_measures():
    """u7 proves the restart it timed actually outlived a held port by
    grepping the app log for the sentence engine.ts writes when it recognises
    one. That is a second value written down on both sides of a boundary no
    build step reconciles — and the failure it hides is the nastier direction:
    a reworded sentence fails the gate against an app doing exactly the right
    thing, which reads as the fix having regressed."""
    said = {}
    for path, pattern in (
        (_ENGINE_TS, r'export const PORT_HELD_BY_SOCKET = "([^"]+)"'),
        (_U7, r'const PORT_HELD_BY_SOCKET = "([^"]+)"'),
    ):
        match = re.search(pattern, path.read_text(encoding="utf-8"))
        assert match, f"{path.name} no longer declares PORT_HELD_BY_SOCKET"
        said[path.name] = match.group(1)
    assert len(set(said.values())) == 1, f"the two spellings disagree: {said}"


def test_every_board_status_has_a_ui_case_and_a_label():
    """A status the desktop does not know renders with no colour and no
    label — the tile silently loses its meaning rather than failing. Three
    places have to agree: the engine's set, the `NodeStatus` union, and the
    status catalog the pill reads its word from."""
    import json

    from localcut_engine.service import SCENE_NODE_STATUSES

    src = _FORMATS.parent.parent / "api" / "types.ts"
    # Comments go first: the union carries several, and a single `;` inside
    # one would truncate the non-greedy match to a partial member list — the
    # test would then pass by comparing against nothing.
    text = re.sub(r"//[^\n]*", "", src.read_text(encoding="utf-8"))
    union = re.search(r"export type NodeStatus =(.*?);", text, re.S)
    assert union, "types.ts no longer declares NodeStatus"
    # Not `[a-z]+`: a status carrying a digit, dash or capital would be
    # dropped silently, which is exactly the drift this test exists to catch.
    declared = set(re.findall(r'"([^"]+)"', union.group(1)))
    assert declared == set(SCENE_NODE_STATUSES), (
        f"NodeStatus and SCENE_NODE_STATUSES disagree: "
        f"only in UI {sorted(declared - set(SCENE_NODE_STATUSES))}, "
        f"only in engine {sorted(set(SCENE_NODE_STATUSES) - declared)}"
    )

    catalog = json.loads(
        (_FORMATS.parent.parent / "i18n" / "en" / "status.json").read_text(encoding="utf-8")
    )
    missing = [s for s in SCENE_NODE_STATUSES if s not in catalog]
    assert not missing, f"no label in status.json for: {missing}"


def test_notice_codes_match_the_desktop_catalog():
    """Every notice code the engine can emit must have a message in the
    desktop's notices.json, or it renders as nothing; every catalog entry
    must be an emittable code, or it is dead copy no engine ever triggers."""
    import json

    from localcut_engine.notices import NOTICE_CODES

    catalog_path = _FORMATS.parents[1] / "i18n" / "en" / "notices.json"
    assert catalog_path.exists(), "the desktop has no notices.json catalog"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))

    def leaves(node: object, prefix: str = "") -> set[str]:
        if isinstance(node, dict):
            return {
                key for name, child in node.items() for key in leaves(child, f"{prefix}{name}.")
            }
        return {prefix.rstrip(".")}

    assert leaves(catalog) == set(NOTICE_CODES)


def test_speech_timing_matches_the_narration_authority():
    """ToolSession shows per-scene lengths computed from narration words —
    the script model's own duration_s is a claim nothing downstream reads.
    The UI's copy of the words-per-second rate and the per-scene pad must be
    the assembly's, or the preview quietly disagrees with the cut."""
    from localcut_engine.backends.ffmpeg import NARRATION_PAD_S
    from localcut_engine.backends.llm import SPEECH_WORDS_PER_S

    assert _number(r"export const SPEECH_WORDS_PER_S = ([\d.]+)") == SPEECH_WORDS_PER_S
    assert _number(r"export const NARRATION_PAD_S = ([\d.]+)") == NARRATION_PAD_S


def test_quick_tool_kinds_agree_across_the_boundary():
    """A quick tool kind is spelled out in four places, and each one fails
    differently when it drifts: the route rejects the kind with a 422, the
    template importer refuses a `tool:` mode it should accept, the desktop's
    union stops narrowing, and the tile renders `undefined` where its label
    should be. Nothing bound the four together."""
    import json

    from localcut_engine.graph.template_io import TOOL_KINDS

    app_src = (
        Path(__file__).resolve().parents[1] / "src" / "localcut_engine" / "api" / "app.py"
    ).read_text(encoding="utf-8")
    route = re.search(r"tool: Literal\[([^\]]+)\]", app_src)
    assert route, "app.py no longer declares the quick tool Literal"
    accepted = set(re.findall(r'"([^"]+)"', route.group(1)))
    assert accepted == set(TOOL_KINDS), (
        f"POST /tools and TOOL_KINDS disagree: "
        f"only on the route {sorted(accepted - set(TOOL_KINDS))}, "
        f"only in TOOL_KINDS {sorted(set(TOOL_KINDS) - accepted)}"
    )

    # Comments first: a `;` inside one would truncate the non-greedy match to
    # a partial member list, and the test would pass against nothing.
    text = re.sub(r"//[^\n]*", "", (_FORMATS.parent.parent / "api" / "types.ts").read_text("utf-8"))
    union = re.search(r"export type ToolKind =(.*?);", text, re.S)
    assert union, "types.ts no longer declares ToolKind"
    declared = set(re.findall(r'"([^"]+)"', union.group(1)))
    assert declared == set(TOOL_KINDS), (
        f"ToolKind and TOOL_KINDS disagree: "
        f"only in UI {sorted(declared - set(TOOL_KINDS))}, "
        f"only in engine {sorted(set(TOOL_KINDS) - declared)}"
    )

    catalog = json.loads(
        (_FORMATS.parent.parent / "i18n" / "en" / "tools.json").read_text(encoding="utf-8")
    )
    assert set(catalog) == set(TOOL_KINDS), (
        f"tools.json and TOOL_KINDS disagree: "
        f"only in the catalog {sorted(set(catalog) - set(TOOL_KINDS))}, "
        f"only in engine {sorted(set(TOOL_KINDS) - set(catalog))}"
    )

    # The fifth source, and the one TypeScript cannot check: lib/tools.ts's
    # TOOL_KINDS decides whether a session resolves to a labelled kind (Home's
    # picker and its icon map derive from it, and the palette asks the same
    # helper). TS proves each entry IS a ToolKind but never that all of them
    # are there, so dropping one would silently leave a shipped tool with no
    # card, no label and no icon -- every existing test still green.
    lib = (_FORMATS.parent / "tools.ts").read_text(encoding="utf-8")
    array = re.search(r"const TOOL_KINDS\s*=\s*\[(.*?)\]", lib, re.S)
    assert array, "lib/tools.ts no longer declares the TOOL_KINDS array"
    listed = set(re.findall(r'"([^"]+)"', array.group(1)))
    assert listed == set(TOOL_KINDS), (
        f"lib/tools.ts TOOL_KINDS and the engine disagree: "
        f"only in the UI {sorted(listed - set(TOOL_KINDS))}, "
        f"only in engine {sorted(set(TOOL_KINDS) - listed)}"
    )


def test_history_kinds_have_labels_in_the_desktop_catalog():
    """Every snapshot kind the engine records must have a word in the
    desktop's historyKinds catalog (the undo/redo menu rows and tooltips
    read it), and every catalog entry must be a kind the engine can
    record — a stale one is dead copy."""
    import json

    from localcut_engine.project.store import SNAPSHOT_KINDS

    catalog = json.loads(
        (_FORMATS.parent.parent / "i18n" / "en" / "project.json").read_text(encoding="utf-8")
    )
    labels = set(catalog.get("historyKinds", {}))
    assert labels == set(SNAPSHOT_KINDS), (
        f"historyKinds and SNAPSHOT_KINDS disagree: "
        f"only in UI {sorted(labels - set(SNAPSHOT_KINDS))}, "
        f"only in engine {sorted(set(SNAPSHOT_KINDS) - labels)}"
    )


def test_export_encode_choices_match_the_engine():
    """The export node refuses off-menu fps/resolution values, so the UI
    must offer exactly the engine's closed sets."""
    from localcut_engine.aspects import EXPORT_FPS_CHOICES, EXPORT_SHORT_SIDE_CHOICES

    def _list(name: str) -> tuple[int, ...]:
        match = re.search(rf"export const {name} = \[([\d, ]+)\]", _source())
        assert match, f"formats.ts no longer declares {name} — update this test with it"
        return tuple(int(v) for v in match.group(1).split(","))

    assert _list("EXPORT_FPS_CHOICES") == EXPORT_FPS_CHOICES
    assert _list("EXPORT_SHORT_SIDE_CHOICES") == EXPORT_SHORT_SIDE_CHOICES


def test_tool_clip_seconds_match_the_tool_route():
    """TOOL_CLIP_SECONDS mirrors ToolRequest.duration_s. The clip panel
    clamps to these before sending; drift means either a 422 the user
    cannot act on or a length the engine accepts that the UI refuses."""
    import inspect

    from localcut_engine.api import app as app_module

    source = inspect.getsource(app_module)
    api = re.search(
        r"duration_s: float = Field\(default=[\d.]+, ge=([\d.]+), le=([\d.]+)\)", source
    )
    assert api, "the ToolRequest duration_s Field no longer matches — update this test with it"

    bounds = re.search(r"TOOL_CLIP_SECONDS = \{ min: (\d+), max: (\d+) \}", _source())
    assert bounds, "TOOL_CLIP_SECONDS no longer matches — update this test with it"
    assert float(bounds.group(1)) == float(api.group(1)), "UI clip minimum drifted from the API"
    assert float(bounds.group(2)) == float(api.group(2)), "UI clip maximum drifted from the API"


def test_voice_swatches_match_the_kokoro_voice_map():
    """The voiceover panel's swatches are briefs the engine's keyword map
    resolves — lib/tools.ts VOICE_SWATCHES mirrors kokoro's _VOICE_MAP. A
    swatch whose brief no longer picks its voice plays one speaker in the
    preview and renders another; a voice the map gained stays unofferable
    until the mirror moves with it."""
    from localcut_engine.backends.kokoro import _DEFAULT_VOICE, _VOICE_MAP, pick_voice

    lib = (_FORMATS.parent / "tools.ts").read_text(encoding="utf-8")
    block = re.search(r"const VOICE_SWATCHES\s*=\s*\[(.*?)\]\s*as const", lib, re.S)
    assert block, "lib/tools.ts no longer declares VOICE_SWATCHES — update this test with it"
    swatches = re.findall(r'\{\s*brief:\s*"([^"]+)",\s*voice:\s*"([^"]+)"', block.group(1))
    assert swatches, "VOICE_SWATCHES entries no longer match — update this test with it"

    for brief, voice in swatches:
        assert pick_voice(brief) == voice, (
            f"the brief {brief!r} resolves to {pick_voice(brief)!r} engine-side, "
            f"but the swatch promises {voice!r}"
        )
    # Every distinct engine voice is offered: a voice only reachable by
    # guessing the right keyword is not a picker.
    offered = {voice for _, voice in swatches}
    engine_voices = {voice for _, voice in _VOICE_MAP} | {_DEFAULT_VOICE}
    assert offered == engine_voices, (
        f"swatches and kokoro disagree: only in UI {sorted(offered - engine_voices)}, "
        f"only in engine {sorted(engine_voices - offered)}"
    )


def test_eta_reads_node_kinds_and_qualities_the_engine_actually_reports():
    """lib/eta.ts asks /system/etas for specific kinds ("clip", "timeline",
    "export") at specific qualities ("draft"/"final"). Those keys are
    NodeKind values and the compiler's quality strings — mirrored across the
    boundary with nothing on the TypeScript side able to check them.

    Drift here fails SILENTLY and in the worst direction: an unknown key
    reads as "no data", so the estimate simply disappears and the CTA goes
    back to saying nothing. That is indistinguishable from a fresh install,
    which is the one state the whole route exists to fix."""
    from localcut_engine.graph.compiler import JobSpec
    from localcut_engine.graph.model import NodeKind

    eta = (_FORMATS.parent / "eta.ts").read_text(encoding="utf-8")
    kinds = set(re.findall(r'engineMedian\("([a-z_]+)",', eta))
    assert kinds, "lib/eta.ts no longer calls engineMedian — update this test with it"
    known = {kind.value for kind in NodeKind}
    assert kinds <= known, f"eta.ts reads kinds the engine has no NodeKind for: {kinds - known}"

    qualities = set(re.findall(r'engineMedian\("[a-z_]+",\s*"([a-z]+)"\)', eta))
    assert qualities, "eta.ts no longer names a quality — update this test with it"
    # The default is one of the two the engine plans with; `final` is what
    # service.finalize enqueues. Both are spelled here, so both are pinned.
    assert qualities == {"draft", "final"}, f"eta.ts asks for unknown qualities: {qualities}"
    assert JobSpec.model_fields["quality"].default == "draft"


def test_the_smaller_model_chip_offers_tasks_the_engine_can_actually_serve():
    """lib/oom.ts mirrors the engine's COMFY_TASKS to decide which models can
    replace a node's after an out-of-memory failure. The desktop derives the
    kind from the node id (NodeState carries no kind), so the mirror is a
    table of id patterns -> manifest task ids.

    Drift is silent in the direction that matters: a task string the manifest
    no longer uses matches no model row, so the chip finds no candidate and
    renders as "nothing smaller is installed" — advice that is wrong rather
    than missing."""
    from localcut_engine.graph.model import NodeKind
    from localcut_engine.manifest.capability import COMFY_TASKS

    oom = (_FORMATS.parent / "oom.ts").read_text(encoding="utf-8")
    body = re.search(r"export function tasksForNode\(.*?\n}", oom, re.S)
    assert body, "lib/oom.ts no longer declares tasksForNode — update this test with it"
    returns = re.findall(r"if \((.+?)\) return \[(.*?)\];", body.group(0))
    assert returns, "tasksForNode's branches no longer match — update this test with it"

    # Which engine kind each UI guard is about. The guards are id patterns
    # because that is the only kind signal the board gives the desktop.
    kind_of_guard = {
        r"/\.clip\d*$/.test(nodeId)": NodeKind.CLIP,
        'nodeId.endsWith(".keyframe")': NodeKind.KEYFRAME,
        'nodeId === "thumbnail"': NodeKind.THUMBNAIL,
        'nodeId === "music"': NodeKind.MUSIC,
    }
    mirrored = {}
    for guard, tasks in returns:
        kind = kind_of_guard.get(guard.strip())
        assert kind is not None, f"unrecognised tasksForNode guard {guard!r} — update this test"
        mirrored[kind] = tuple(re.findall(r'"([^"]+)"', tasks))

    assert mirrored == COMFY_TASKS, (
        f"the UI's kind->task mirror drifted from the engine's COMFY_TASKS: "
        f"UI {mirrored}, engine {COMFY_TASKS}"
    )


def test_every_oom_suggestion_the_scheduler_sends_has_a_chip_that_acts_on_it():
    """The exhausted OOM ladder publishes suggestion CODES, under the
    comment "the UI renders this as choices, not an error code". Each one is
    an id the desktop turns into a chip that does the thing it names.

    Drift here is mislabelling, not silence. The card has an arm per code and
    a disabled "needs a newer app" chip for anything else, so a code the
    engine renames or adds still renders — as the fallback, which is a way
    out the user cannot take. The hint catalog is the tighter of the two
    checks: it holds exactly the codes the app can ACT on, so a UI-only entry
    cannot paper over a missing arm."""
    import inspect
    import json

    from localcut_engine.jobs import scheduler

    source = inspect.getsource(scheduler)
    match = re.search(r"suggestions=\[(.*?)\]", source, re.S)
    assert match, "scheduler.py no longer publishes `suggestions=[...]` — update this test with it"
    codes = set(re.findall(r'"([^"]+)"', match.group(1)))
    assert codes, "the scheduler's suggestion list is empty — update this test with it"

    catalog = json.loads(
        (_FORMATS.parent.parent / "i18n" / "en" / "failure.json").read_text(encoding="utf-8")
    )
    assert codes <= set(catalog["suggestion"]), (
        f"no chip label in failure.json for: {sorted(codes - set(catalog['suggestion']))}"
    )
    # Every code the engine sends must be one the card has an arm for, and
    # `suggestionHint` holds exactly those — an unknown code gets the shared
    # `unknownSuggestion` line instead, so it cannot satisfy this.
    assert codes == set(catalog["suggestionHint"]), (
        f"failure.json's actionable suggestions disagree with the scheduler's: "
        f"engine {sorted(codes)}, UI {sorted(catalog['suggestionHint'])}"
    )


def test_the_code_execution_warning_has_no_second_copy_in_the_desktop():
    """The sentence lives in allowlist.py and travels on every
    /comfy/node-packs response, so that a desktop, the CLI and a script all
    show the same words. A copy in the UI is how those drift apart - and
    the direction it drifts is toward whichever wording reads more softly
    next to a button someone wants people to press.

    Asserted against the CATALOG and the components, not against the test
    fixtures: a fixture quoting the real sentence is realism, and it is the
    shipped strings that reach a user.
    """
    from localcut_engine.comfy.allowlist import CODE_EXECUTION_WARNING

    src = Path(__file__).resolve().parents[2] / "apps" / "desktop" / "src"
    # A distinctive fragment rather than the whole sentence: a paraphrase
    # that keeps the shape is exactly what this is meant to catch, and the
    # phrase below is the load-bearing claim in it.
    needle = "does not sandbox or review pack code"
    offenders = [
        path.relative_to(src).as_posix()
        for path in [*src.rglob("*.json"), *src.rglob("*.tsx"), *src.rglob("*.ts")]
        if not path.name.endswith((".test.tsx", ".test.ts"))
        and needle in path.read_text(encoding="utf-8")
    ]
    assert offenders == [], (
        "the code-execution warning is duplicated in the desktop; render the "
        f"`warning` field the engine sends instead: {offenders}"
    )
    assert needle in CODE_EXECUTION_WARNING, "the fragment this test looks for moved"


def _stylesheet() -> str:
    return (
        Path(__file__).resolve().parents[2] / "apps" / "desktop" / "src" / "styles" / "app.css"
    ).read_text(encoding="utf-8")


def _tokens() -> str:
    return (
        Path(__file__).resolve().parents[2] / "apps" / "desktop" / "src" / "styles" / "tokens.css"
    ).read_text(encoding="utf-8")


def test_every_custom_property_the_stylesheet_reads_is_one_that_exists():
    """A `var(--name)` naming a property that was never defined is not a
    fallback - the whole DECLARATION is invalid at computed-value time and
    the browser drops it. Nothing announces that: no build error, no console
    warning, and the desktop suite cannot see it either (vitest stubs CSS
    imports to an empty string, and jsdom loads no stylesheet). Three dialog
    paddings were written against a `--space-5` the scale has never had, and
    each one silently became no padding at all.

    Lives here rather than in vitest for the same reason the code-execution
    check does: this side can read the file.
    """
    css, tokens = _stylesheet(), _tokens()
    defined = set(re.findall(r"^\s*(--[\w-]+)\s*:", tokens, re.MULTILINE))
    # Properties app.css defines for itself and reads nearby - the tooltip's
    # --tip-x, the dockview theme's --dv-*. They never reach tokens.css.
    local = set(re.findall(r"^\s*(--[\w-]+)\s*:", css, re.MULTILINE))
    used = set(re.findall(r"var\(\s*(--[\w-]+)", css))
    missing = sorted(used - defined - local)
    assert missing == [], (
        f"app.css reads custom properties nothing defines, so those "
        f"declarations are dropped: {missing}"
    )


def test_no_dialog_picks_its_own_width():
    """Dialog width is `size="s|m|l"` on the shared shell (components/Modal),
    which is what stops a set of dialogs from looking like a set of
    one-offs. Before that there were four hand-picked max-widths - 400, 460,
    520 and 560 - one per dialog, each arrived at on its own.
    """
    rogue = [
        block.split("{")[0].strip()
        for block in re.findall(
            r"^\.[\w-]*modal[\w-]*\s*\{[^}]*max-width[^}]*\}",
            _stylesheet(),
            re.MULTILINE,
        )
        if not block.split("{")[0].strip().endswith(("modal-s", "modal-m", "modal-l"))
    ]
    assert rogue == [], (
        f"these selectors size a dialog themselves; use the shell's size prop instead: {rogue}"
    )


def test_every_defaultable_task_has_a_label_and_a_hint():
    """The Settings picker renders one row per task the engine says it
    honors, and titles each from the models catalog. A task added to
    DEFAULTABLE_TASKS without a catalog entry therefore renders a row with a
    blank name and a blank explanation — a knob for something unnamed. The
    reverse is dead copy: a label for a task the engine will not accept.
    """
    import json

    from localcut_engine.manifest.defaults import DEFAULTABLE_TASKS

    catalog = json.loads(
        (_FORMATS.parent.parent / "i18n" / "en" / "models.json").read_text(encoding="utf-8")
    )
    tasks = set(DEFAULTABLE_TASKS)
    labels = set(catalog.get("taskLabels", {}))
    hints = set(catalog.get("taskHints", {}))
    # The catalog also names tasks that are not user-defaultable (speech.tts,
    # transcribe) because the same labels title the model library, so it may
    # be a superset — but never a subset.
    assert tasks <= labels, f"defaultable tasks with no label: {sorted(tasks - labels)}"
    assert tasks <= hints, f"defaultable tasks with no hint: {sorted(tasks - hints)}"
    assert labels == hints, (
        f"taskLabels and taskHints disagree: only labelled {sorted(labels - hints)}, "
        f"only hinted {sorted(hints - labels)}"
    )


def test_the_settings_picker_agrees_on_which_tasks_the_llm_server_serves():
    """Two kinds of default live in one list. Most name a manifest entry with
    weights on disk; `text.llm` and `vision.llm` name a model on the LLM
    server, so their choices come from the server rather than from what has
    been downloaded.

    The desktop keeps its own copy of that split to build the picker. Drift
    is silent and one-directional: a server task missing from the UI's list
    is offered as a list of installed manifest models — which is empty for it
    — so the row filters itself out and the knob simply never appears.
    """
    from localcut_engine.manifest.defaults import _SERVER_TASKS

    settings = (_FORMATS.parent.parent / "screens" / "Settings.tsx").read_text(encoding="utf-8")
    match = re.search(r"const SERVER_TASKS = \[(.*?)\]", settings, re.S)
    assert match, "Settings.tsx no longer declares SERVER_TASKS — update this test with it"
    mirrored = tuple(re.findall(r'"([^"]+)"', match.group(1)))
    assert mirrored == _SERVER_TASKS, (
        f"the picker's server-task list drifted from the engine's: "
        f"UI {mirrored}, engine {_SERVER_TASKS}"
    )


def test_the_vision_timeout_matches_the_engines():
    """`/suggest-scene` is the one interactive route that waits on a vision
    model, and a model that is not resident yet loads several GB before it
    answers — minutes, on a contended GPU.

    The renderer bounds every request at 120s, which is generous for a route
    that only touches disk and far too short for this one. A client budget
    below the engine's makes the app give up on work the engine then finishes
    anyway: the user is told it failed, nothing is shown, and the read they
    paid the wait for is discarded at the moment it was about to land. Above
    the engine's it is dead patience — the engine has already given up.
    """
    from localcut_engine.config import EngineConfig

    client = (_FORMATS.parent.parent / "api" / "client.ts").read_text(encoding="utf-8")
    match = re.search(r"VISION_TIMEOUT_MS = ([\d_]+)", client)
    assert match, "client.ts no longer declares VISION_TIMEOUT_MS — update this test with it"
    assert int(match.group(1).replace("_", "")) == EngineConfig().llm_timeout_s * 1000, (
        "the renderer's vision budget drifted from the engine's llm_timeout_s"
    )
