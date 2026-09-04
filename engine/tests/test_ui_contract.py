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

import ast
import json
import re
import typing
from pathlib import Path

import pytest

import localcut_engine
from conftest import ci_engine_paths_by_trigger, hook_files_pattern, matches_a_path_filter

_DESKTOP = Path(__file__).resolve().parents[2] / "apps" / "desktop"
_FORMATS = _DESKTOP / "src" / "lib" / "formats.ts"
_TOOLS_TS = _DESKTOP / "src" / "lib" / "tools.ts"
_ETA = _DESKTOP / "src" / "lib" / "eta.ts"
_OOM = _DESKTOP / "src" / "lib" / "oom.ts"
_CLIENT = _DESKTOP / "src" / "api" / "client.ts"
_TYPES = _DESKTOP / "src" / "api" / "types.ts"
_HOME = _DESKTOP / "src" / "screens" / "Home.tsx"
_SETTINGS = _DESKTOP / "src" / "screens" / "Settings.tsx"
_APP_CSS = _DESKTOP / "src" / "styles" / "app.css"
_TOKENS_CSS = _DESKTOP / "src" / "styles" / "tokens.css"
_ENGINE_TS = _DESKTOP / "electron" / "engine.ts"
_U7 = _DESKTOP / "scripts" / "rig" / "u7.mjs"
_TERMS_TS = _DESKTOP / "src" / "help" / "terms.ts"
_NEW_SCENE = _DESKTOP / "src" / "components" / "NewSceneDialog.tsx"
_TIMELINE_STRIP = _DESKTOP / "src" / "components" / "TimelineStrip.tsx"
_I18N = _DESKTOP / "src" / "i18n" / "en"
_VOICE_ASSETS = _DESKTOP / "src" / "assets" / "voices"

# The desktop label catalogs this module reconciles against engine ids.
_CATALOGS = (
    "canvas.json",
    "failure.json",
    "models.json",
    "notices.json",
    "project.json",
    "readiness.json",
    "status.json",
    "timeline.json",
    "tools.json",
    "voices.json",
)

# Every desktop file this module reads, in one place, because the guard at the
# foot of this file derives from it: ci-engine.yml's path filters and the
# pre-push hook are held to naming all of them, so a read added above extends
# that check by construction. A second list kept in step by hand is exactly
# the drift the rest of this module exists to catch, and it is what let this
# guard fall behind to three of them.
_DESKTOP_READS: tuple[Path, ...] = (
    _FORMATS,
    _TOOLS_TS,
    _ETA,
    _OOM,
    _CLIENT,
    _TYPES,
    _HOME,
    _SETTINGS,
    _APP_CSS,
    _TOKENS_CSS,
    _TERMS_TS,
    _NEW_SCENE,
    _TIMELINE_STRIP,
    _ENGINE_TS,
    _U7,
    *(_I18N / name for name in _CATALOGS),
)

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


def _ts_source(*parts: str) -> str:
    """A TypeScript file with BOTH comment styles stripped.

    Every union check below reads to the first `;`, and a semicolon inside
    a comment ends that match early — leaving the test comparing against a
    partial member list and passing for the wrong reason. Line comments
    were already stripped for exactly this; a doc comment does it too.
    """
    source = _FORMATS.parent.parent.joinpath(*parts).read_text(encoding="utf-8")
    return re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", source, flags=re.S))


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

    client = _CLIENT
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
    from localcut_engine.service import SCENE_NODE_STATUSES

    text = _ts_source("api", "types.ts")
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

    catalog = json.loads((_I18N / "status.json").read_text(encoding="utf-8"))
    missing = [s for s in SCENE_NODE_STATUSES if s not in catalog]
    assert not missing, f"no label in status.json for: {missing}"


def test_notice_codes_match_the_desktop_catalog():
    """Every notice code the engine can emit must have a message in the
    desktop's notices.json, or it renders as nothing; every catalog entry
    must be an emittable code, or it is dead copy no engine ever triggers."""
    import json

    from localcut_engine.notices import NOTICE_CODES

    catalog_path = _I18N / "notices.json"
    assert catalog_path.exists(), "the desktop has no notices.json catalog"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))

    def leaves(node: object, prefix: str = "") -> set[str]:
        if isinstance(node, dict):
            return {
                key for name, child in node.items() for key in leaves(child, f"{prefix}{name}.")
            }
        return {prefix.rstrip(".")}

    assert leaves(catalog) == set(NOTICE_CODES)


def test_readiness_vocabulary_matches_the_desktop():
    """Verdicts, reasons and fix types cross the wire as codes the desktop
    switches on and translates. A value only the engine knows renders as a
    silent skip (the reason catalog) or falls through a verdict branch —
    the same drift the status and notice contracts exist to catch."""
    import json

    from localcut_engine.readiness import (
        READINESS_FIX_TYPES,
        READINESS_REASONS,
        READINESS_VERDICTS,
    )

    text = _ts_source("api", "types.ts")

    def union(name: str) -> set[str]:
        match = re.search(rf"export type {name} =(.*?);", text, re.S)
        assert match, f"types.ts no longer declares {name}"
        return set(re.findall(r'"([^"]+)"', match.group(1)))

    assert union("ReadinessVerdict") == set(READINESS_VERDICTS)
    assert union("ReadinessReason") == set(READINESS_REASONS)
    # The fix union is a discriminated one: each member names its type.
    # Read to the next declaration, not to the next `;` — every member
    # carries semicolons INSIDE its braces, so a non-greedy match to `;`
    # stops after the first one and compares against a partial set.
    fix = re.search(r"export type ReadinessFix =(.*?)\nexport ", text, re.S)
    assert fix, "types.ts no longer declares ReadinessFix"
    assert set(re.findall(r'type: "([^"]+)"', fix.group(1))) == set(READINESS_FIX_TYPES)

    # Every reason needs a sentence, or the row renders as nothing. "ok" is
    # the exception: a ready row is never described to anyone.
    catalog = json.loads((_I18N / "readiness.json").read_text("utf-8"))
    described = set(catalog["reasons"])
    assert described == set(READINESS_REASONS) - {"ok"}, (
        f"readiness.json and READINESS_REASONS disagree: "
        f"only in catalog {sorted(described - set(READINESS_REASONS))}, "
        f"only in engine {sorted(set(READINESS_REASONS) - described - {'ok'})}"
    )

    # The reason says the cause once; the effect phrase says what it costs
    # each stage. A verdict with no phrase renders a stage with a blank
    # beside it — a row that raises a problem and declines to say what it
    # is. "ready" is the exception, for the same reason "ok" was: a ready
    # row is never listed.
    effects = set(catalog["effects"])
    missing = set(READINESS_VERDICTS) - {"ready"} - effects
    assert not missing, f"readiness.json has no effect phrase for {sorted(missing)}"


def test_the_video_kinds_home_warns_about_match_the_pipeline():
    """Home scopes its pre-generate warning to what a video renders, so a
    thumbnail model it will never touch cannot interrupt one. That list is
    the engine's PIPELINE_KINDS written again in TypeScript — if the
    pipeline grows a stage, the warning has to grow with it."""
    from localcut_engine.readiness import PIPELINE_KINDS

    text = _ts_source("screens", "Home.tsx")
    match = re.search(r"const VIDEO_KINDS = \[(.*?)\];", text, re.S)
    assert match, "Home.tsx no longer declares VIDEO_KINDS"
    declared = set(re.findall(r'"([^"]+)"', match.group(1)))
    assert declared == {kind.value for kind in PIPELINE_KINDS}


def test_each_quick_tools_engine_kinds_match_its_graph():
    """The tool panels scope their readiness note to the kinds that tool
    renders. The truth is the graph the engine builds for it, and the two
    are written on opposite sides of the wire."""
    import json

    from localcut_engine.graph.templates import tool_graph

    text = _ts_source("lib", "tools.ts")
    match = re.search(r"TOOL_ENGINE_KINDS: Record<ToolKind, string\[\]> = \{(.*?)\n\};", text, re.S)
    assert match, "tools.ts no longer declares TOOL_ENGINE_KINDS"
    declared = {
        tool: set(json.loads(kinds.replace("'", '"')))
        for tool, kinds in re.findall(r"(\w+):\s*(\[[^\]]*\])", match.group(1))
    }
    from localcut_engine.graph.template_io import TOOL_KINDS

    # Or a regex that stopped matching entries would pass by looping over
    # nothing — the failure mode this whole file exists to prevent.
    assert declared.keys() == set(TOOL_KINDS)
    params = {
        "prompt": "a lighthouse",
        "text": "spoken words",
        "target_duration_s": 60,
        "duration_s": 5.0,
        "aspect": "16:9",
        "voice": "narrator",
        "style_preset": "cinematic",
        "motion": "",
    }
    for tool, kinds in declared.items():
        graph = tool_graph(tool, params)
        actual = {node.kind.value for node in graph.nodes.values()}
        assert kinds == actual, (
            f"{tool}: UI says {sorted(kinds)}, the graph builds {sorted(actual)}"
        )


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

    text = _ts_source("api", "types.ts")
    union = re.search(r"export type ToolKind =(.*?);", text, re.S)
    assert union, "types.ts no longer declares ToolKind"
    declared = set(re.findall(r'"([^"]+)"', union.group(1)))
    assert declared == set(TOOL_KINDS), (
        f"ToolKind and TOOL_KINDS disagree: "
        f"only in UI {sorted(declared - set(TOOL_KINDS))}, "
        f"only in engine {sorted(set(TOOL_KINDS) - declared)}"
    )

    catalog = json.loads((_I18N / "tools.json").read_text(encoding="utf-8"))
    assert set(catalog) == set(TOOL_KINDS), (
        f"tools.json and TOOL_KINDS disagree: "
        f"only in the catalog {sorted(set(catalog) - set(TOOL_KINDS))}, "
        f"only in engine {sorted(set(TOOL_KINDS) - set(catalog))}"
    )

    # Every kind needs the mid-sentence noun the delete confirmation uses
    # ("Removes this voiceover"). `toolNoun` falls back to the generic word
    # so an UNKNOWN kind from a newer engine still reads — which is exactly
    # what would hide a known kind that shipped without one, back to the
    # "quick tool output" this replaced.
    missing = sorted(kind for kind, entry in catalog.items() if not entry.get("noun"))
    assert not missing, f"tools.json entries with no `noun`: {missing}"

    # The fifth source, and the one TypeScript cannot check: lib/tools.ts's
    # TOOL_KINDS decides whether a session resolves to a labelled kind (Home's
    # picker and its icon map derive from it, and the palette asks the same
    # helper). TS proves each entry IS a ToolKind but never that all of them
    # are there, so dropping one would silently leave a shipped tool with no
    # card, no label and no icon -- every existing test still green.
    lib = _TOOLS_TS.read_text(encoding="utf-8")
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

    catalog = json.loads((_I18N / "project.json").read_text(encoding="utf-8"))
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


def _voice_swatches() -> list[tuple[str, str]]:
    """The (brief, voice) pairs lib/tools.ts offers, parsed once.

    Through `_ts_source`, so a doc comment carrying `] as const` cannot end
    the block match early and leave a caller asserting over a truncated
    list. One parse, because two copies of this regex drift apart under a
    reformat and the one that stops matching returns nothing rather than
    failing.
    """
    block = re.search(
        r"const VOICE_SWATCHES\s*=\s*\[(.*?)\]\s*as const", _ts_source("lib", "tools.ts"), re.S
    )
    assert block, "lib/tools.ts no longer declares VOICE_SWATCHES — update this test with it"
    swatches = re.findall(r'\{\s*brief:\s*"([^"]+)",\s*voice:\s*"([^"]+)"', block.group(1))
    assert swatches, "VOICE_SWATCHES entries no longer match — update this test with it"
    return swatches


def test_voice_swatches_match_the_kokoro_voice_map():
    """The voiceover panel's swatches are briefs the engine's keyword map
    resolves — lib/tools.ts VOICE_SWATCHES mirrors kokoro's _VOICE_MAP. A
    swatch whose brief no longer picks its voice plays one speaker in the
    preview and renders another; a voice the map gained stays unofferable
    until the mirror moves with it."""
    from localcut_engine.backends.kokoro import DEFAULT_VOICE, _VOICE_MAP, pick_voice

    swatches = _voice_swatches()
    for brief, voice in swatches:
        assert pick_voice(brief) == voice, (
            f"the brief {brief!r} resolves to {pick_voice(brief)!r} engine-side, "
            f"but the swatch promises {voice!r}"
        )
    # Every distinct engine voice is offered: a voice only reachable by
    # guessing the right keyword is not a picker.
    offered = {voice for _, voice in swatches}
    engine_voices = {voice for _, voice in _VOICE_MAP} | {DEFAULT_VOICE}
    assert offered == engine_voices, (
        f"swatches and kokoro disagree: only in UI {sorted(offered - engine_voices)}, "
        f"only in engine {sorted(engine_voices - offered)}"
    )


def test_every_swatch_has_a_preview_the_app_can_play():
    """`VOICE_SAMPLES` builds a URL per swatch from `assets/voices/<id>.wav`,
    so a swatch with no committed file is a 404 on press with nothing in the
    suite to say so. The bytes themselves come from
    engine/scripts/make-voice-samples.py, which renders them through the
    same backend a project renders with — a preview that no longer matches
    the render is what these files exist to rule out, and only committed
    bytes ship."""
    import wave

    assets = _VOICE_ASSETS
    for _, voice in _voice_swatches():
        sample = assets / f"{voice}.wav"
        assert sample.exists(), f"the {voice} swatch has no preview at {sample}"
        with wave.open(str(sample)) as wav:
            # What the engine writes: mono 24 kHz 16-bit. A preview in another
            # format plays at the wrong pitch or not at all.
            assert (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) == (1, 24000, 2)
            assert wav.getnframes() > 0, f"{voice} preview is silent"


def test_voice_language_codes_match_the_desktop_catalog():
    """The wire carries espeak codes; the English for them lives in the
    desktop's voices.json. A code the catalog lacks renders as a raw
    `pt-br` in the picker, and a catalog entry no voice id can produce is
    dead copy — this is the boundary no build step reconciles."""
    import json

    from localcut_engine.backends.kokoro import _GENDERS, _VOICE_LANGUAGES

    catalog_path = _I18N / "voices.json"
    assert catalog_path.exists(), "the desktop has no voices.json catalog"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))

    assert set(catalog["languages"]) == set(_VOICE_LANGUAGES.values()), (
        f"catalog and engine disagree on language codes: "
        f"only in UI {sorted(set(catalog['languages']) - set(_VOICE_LANGUAGES.values()))}, "
        f"only in engine {sorted(set(_VOICE_LANGUAGES.values()) - set(catalog['languages']))}"
    )
    assert set(catalog["genders"]) == set(_GENDERS.values())
    # An id outside the scheme reports null for both, which the picker has
    # to have words for — otherwise the row renders blank.
    assert catalog["unknownLanguage"] and catalog["unknownGender"]


def test_the_engine_sends_no_display_copy_with_the_voices():
    """Everything in a voice record is an id the client labels. A field of
    English here would be the one string in the app with no `t()` key —
    the reason status words cross the wire as `skipped` and read "not
    needed" only in the UI."""
    from localcut_engine.backends.kokoro import _GENDERS, _VOICE_LANGUAGES, describe_voice

    assert set(describe_voice("af_sarah")) == {"id", "name", "language_code", "gender"}
    # Read off the engine's own table rather than repeated: a fourth copy of
    # the code list, bound by nothing, would go stale on the next language
    # the pack gains and leave this passing without checking it.
    for voice_id in ("af_sarah", "bm_george", "zf_xiaobei", "jenny", ""):
        described = describe_voice(voice_id)
        assert described["language_code"] in (None, *_VOICE_LANGUAGES.values()), described
        assert described["gender"] in (None, *_GENDERS.values()), described


def test_swatch_voice_names_match_what_the_engine_derives():
    """`voices.names` labels the five swatches, and `describe_voice`
    derives a name for all fifty-four. Both reach the same user, so a
    rename on one side shows one speaker under two names — the drift the
    contract tests in this file exist for."""
    import json

    from localcut_engine.backends.kokoro import describe_voice

    catalog = json.loads((_I18N / "voices.json").read_text(encoding="utf-8"))
    for voice_id, label in catalog["names"].items():
        assert describe_voice(voice_id)["name"] == label, (
            f"voices.json calls {voice_id} {label!r}, the engine derives "
            f"{describe_voice(voice_id)['name']!r}"
        )


def _ts_union(text: str, declaration: str) -> set[str]:
    """The string literals of a TypeScript union, given the text that opens it.

    Unions here are hand-mirrored from an engine enum, so the interesting
    failure is one side gaining a member. Reading the literals back is the
    only way this side can see that happen.
    """
    start = text.index(declaration) + len(declaration)
    end = text.index(";", start)
    return set(re.findall(r'"([a-z0-9_.-]+)"', text[start:end]))


def test_job_statuses_match_the_desktop_union():
    """`Job.status` is the engine's JobStatus retyped by hand. A status the
    desktop does not know is not a type error there — it falls through every
    branch, so the queue row renders as neither running nor finished."""
    from localcut_engine.jobs.models import JobStatus

    text = _TYPES.read_text(encoding="utf-8")
    interface = text[text.index("export interface Job {") :]
    union = _ts_union(interface, "  status:")
    assert union == {status.value for status in JobStatus}


def test_license_verdicts_match_the_desktop_union():
    """The verdict drives what the model library tells a user they may do
    with a model's output. `ModelLibrary` falls back to "conditions" for an
    unknown verdict, so a new engine verdict does not fail loudly here — it
    silently reports the wrong licence."""
    from localcut_engine.manifest.model import Verdict

    union = _ts_union(_TYPES.read_text(encoding="utf-8"), "export type LicenseVerdict =")
    assert union == set(typing.get_args(Verdict))


def test_every_event_the_engine_publishes_is_in_the_desktop_union():
    """The WS stream is how the board learns anything changed. An event the
    desktop's union does not carry is dropped by the dispatcher's exhaustive
    switch, and the surface it should have refreshed simply goes stale —
    with nothing on screen and nothing in the log to say so.

    The engine side is read from the syntax tree rather than by grep: these
    calls pass the name positionally and their keyword arguments span lines,
    which a regex over the source reads wrongly."""
    published = set()
    for path in (Path(localcut_engine.__file__).parent).rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "publish"
            ):
                assert node.args, f"{path.name}:{node.lineno} publishes without a literal name"
                name = node.args[0]
                assert isinstance(name, ast.Constant) and isinstance(name.value, str), (
                    f"{path.name}:{node.lineno} publishes a computed event name — "
                    "this test can only see literals"
                )
                published.add(name.value)

    assert published, "no publish() calls found — update this test with the engine"
    declared = set(re.findall(r'type: "([a-z0-9_.]+)"', _TYPES.read_text(encoding="utf-8")))
    assert published <= declared, (
        f"the engine publishes {sorted(published - declared)}, which the desktop's "
        "EngineEvent union does not carry"
    )


def test_the_aspect_picker_offers_the_engines_aspects():
    """Home's prompt row and Settings → Defaults share one aspect list. An
    aspect the engine has no resolution for compiles to a graph the render
    then fails on, and one it has that the UI omits is simply unreachable."""
    from localcut_engine.aspects import (
        EXPORT_RESOLUTIONS,
        IMAGE_RESOLUTIONS,
        VIDEO_RESOLUTIONS,
    )

    block = re.search(r"export const ASPECTS = \[(.*?)\] as const;", _source(), re.S)
    assert block, "formats.ts no longer declares ASPECTS — update this test with it"
    offered = set(re.findall(r'value: "([0-9:]+)"', block.group(1)))

    for stage, table in (
        ("image", IMAGE_RESOLUTIONS),
        ("video", VIDEO_RESOLUTIONS),
        ("export", EXPORT_RESOLUTIONS),
    ):
        assert offered == set(table), (
            f"the picker offers {sorted(offered)} but the engine's {stage} table "
            f"covers {sorted(table)}"
        )


def test_transition_vocabulary_agrees_across_the_boundary():
    """Four copies: the NL-edit whitelist, the assembly branches, the
    timeline's popover and the label catalog. A transition the UI offers
    that the whitelist refuses is a rejected patch; one the assembly does
    not branch on renders as a plain cut, which looks like nothing
    happened."""
    from localcut_engine.graph.editor import _TRANSITIONS

    offered = set(re.findall(r'\{ id: "([a-z]+)" \}', _TIMELINE_STRIP.read_text(encoding="utf-8")))
    assert offered == _TRANSITIONS, (
        f"the timeline offers {sorted(offered)}, the engine accepts {sorted(_TRANSITIONS)}"
    )

    catalog = json.loads((_I18N / "timeline.json").read_text(encoding="utf-8"))
    labelled = set(catalog.get("transitions", {}))
    assert _TRANSITIONS <= labelled, (
        f"timeline.json has no label for {sorted(_TRANSITIONS - labelled)} — "
        "the popover would show the raw wire id"
    )


def test_the_canvas_catalog_names_every_node_kind_and_port():
    """The flowchart draws engine ids, and its catalog is the only thing
    standing between a user and a raw `voice_ref`. A kind or port added to
    the engine renders untranslated until this catalog carries it."""
    from localcut_engine.graph import model as graph_model
    from localcut_engine.graph.model import NodeKind

    catalog = json.loads((_I18N / "canvas.json").read_text(encoding="utf-8"))

    kinds = set(catalog["kinds"])
    assert kinds == {kind.value for kind in NodeKind}, (
        f"canvas.json labels {sorted(kinds)}, the engine has "
        f"{sorted(kind.value for kind in NodeKind)}"
    )

    ports = {
        value
        for name, value in vars(graph_model).items()
        if name.endswith("_PORT") and isinstance(value, str)
    }
    assert ports <= set(catalog["ports"]), (
        f"canvas.json has no label for port {sorted(ports - set(catalog['ports']))}"
    )


def test_take_numbers_match_the_engines_naming():
    """`expand_screenplay` names the first take `s1.clip` and the rest
    `s1.clip<n>`, so the trailing digit IS the take number. Adding one to it
    numbers every take one too high, and the queue, the inspector and the
    canvas all read this label."""
    from localcut_engine.graph.templates import take_node_id

    source = _TERMS_TS.read_text(encoding="utf-8")
    match = re.search(r'terms\.nodeTake", \{ take: ([^}]+) \}', source)
    assert match, "terms.ts no longer builds a take number — update this test with it"
    expression = match.group(1).strip()
    assert expression == "Number(take)", (
        f"terms.ts derives its take number as `{expression}`; the engine names "
        f"take 2 `{take_node_id('s1.clip', 2)}`, so the trailing digit is the take"
    )


def test_the_new_scene_dialog_reads_the_shared_speech_rate():
    """A third copy of the words-per-second rate, inline in a runtime
    readout, gives one engine rule two answers on two surfaces. The dialog
    must import the constant the rest of the app shares."""
    source = _NEW_SCENE.read_text(encoding="utf-8")
    assert "SPEECH_WORDS_PER_S" in source, (
        "NewSceneDialog computes a runtime without the shared speech rate"
    )
    assert not re.search(r"words \* [\d.]+", source), (
        "NewSceneDialog still multiplies a word count by an inline rate"
    )


def test_the_custom_model_id_pattern_matches_the_route():
    """A custom model's id becomes a path parameter. If the two patterns
    disagree, `add_custom_model` mints an id every route for it then 404s —
    and the id is only checked with `match`, which stops at the first
    newline and would accept one the route refuses."""
    from localcut_engine.manifest.custom import _ID_OK

    route = re.search(
        r'ModelId = Annotated\[str, PathParam\(pattern=r"([^"]+)"\)\]',
        (Path(localcut_engine.__file__).parent / "api" / "app.py").read_text(encoding="utf-8"),
    )
    assert route, "app.py no longer declares ModelId — update this test with it"
    assert _ID_OK.pattern == route.group(1)
    # `$` also matches before a trailing newline, so the shared pattern only
    # agrees with the route when the id is checked whole. Asserting the call
    # site, not just the trap: `match` here would mint an id the route 404s.
    assert _ID_OK.match("ok\n") is not None
    assert _ID_OK.fullmatch("ok\n") is None
    source = (Path(localcut_engine.__file__).parent / "manifest" / "custom.py").read_text(
        encoding="utf-8"
    )
    assert "_ID_OK.match(" not in source, "the custom-model id is checked with match, not fullmatch"


def test_ci_runs_this_module_for_the_desktop_files_it_reads():
    """A contract test that cannot fire is not a contract.

    The assertions above read the desktop's source, its label catalogs and
    its committed voice previews, and a PR touching only those matches
    `apps/desktop/**` — ci-desktop, which runs vitest and tsc, neither of
    which can execute pytest. So ci-engine's path filter and the pre-push
    hook have to name them. Both are checked: the hook is what catches it
    before the push, and the workflow is what catches a PR opened from a
    machine without the hook installed — and both of the workflow's
    triggers, which carry the list separately.

    The list checked is `_DESKTOP_READS` itself, not a copy of it. A guard
    over a hand-written subset only ever proves the subset, and says nothing
    about the read added next to it.
    """
    root = _DESKTOP.parents[1]
    reads = [path.relative_to(root).as_posix() for path in _DESKTOP_READS]
    # The committed previews are read as a directory, so name one concrete
    # file: a glob proves nothing about whether the filter reaches a .wav.
    reads.append(f"apps/desktop/src/assets/voices/{_voice_swatches()[0][1]}.wav")

    filters = ci_engine_paths_by_trigger()
    for trigger in ("push", "pull_request"):
        assert filters.get(trigger), (
            f"ci-engine.yml no longer lists quoted paths under {trigger} — update this test with it"
        )

    hook = hook_files_pattern("ui-contract")

    for path in reads:
        for trigger, globs in filters.items():
            assert matches_a_path_filter(path, globs), (
                f"ci-engine.yml's {trigger} path filter does not name {path}, which this "
                "module reads — a change to it would run no suite that can check this contract"
            )
        assert hook.match(path), f"the ui-contract pre-push hook does not name {path}"


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

    eta = _ETA.read_text(encoding="utf-8")
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

    oom = _OOM.read_text(encoding="utf-8")
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

    catalog = json.loads((_I18N / "failure.json").read_text(encoding="utf-8"))
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
    return _APP_CSS.read_text(encoding="utf-8")


def _tokens() -> str:
    return _TOKENS_CSS.read_text(encoding="utf-8")


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

    catalog = json.loads((_I18N / "models.json").read_text(encoding="utf-8"))
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

    settings = _SETTINGS.read_text(encoding="utf-8")
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

    client = _CLIENT.read_text(encoding="utf-8")
    match = re.search(r"VISION_TIMEOUT_MS = ([\d_]+)", client)
    assert match, "client.ts no longer declares VISION_TIMEOUT_MS — update this test with it"
    assert int(match.group(1).replace("_", "")) == EngineConfig().llm_timeout_s * 1000, (
        "the renderer's vision budget drifted from the engine's llm_timeout_s"
    )
