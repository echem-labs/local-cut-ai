/**
 * What this build knows about Quick Tool sessions.
 *
 * Here rather than in `screens/Home` because a component needs it too: the
 * palette lists every session on the machine and so is the surface most
 * likely to meet a kind a newer engine minted, and importing a screen from a
 * component closed a Palette -> Home -> Palette module cycle. `project.mode`
 * is a free string the engine chose; everything below exists to keep an
 * unrecognised one from reaching a catalog lookup.
 */
import { Aperture, FileText, Film, Image as ImageIcon, Mic, Music } from "lucide-react";

import type { Project, ToolKind } from "../api/types";
import { m } from "../i18n";

/** The kinds this build has copy and an icon for, in the order Home offers
 * them. `satisfies` only proves each entry IS a ToolKind — never that all of
 * them are here — so the assertion below is what makes dropping one a
 * compile error instead of a shipped tool that silently lists as unknown. */
export const TOOL_KINDS = [
  "script",
  "thumbnail",
  "voiceover",
  "image",
  "music",
  "clip",
] as const satisfies readonly ToolKind[];

/** Fails to compile the moment a ToolKind exists that TOOL_KINDS omits. */
const _everyKindIsListed: ToolKind extends (typeof TOOL_KINDS)[number] ? true : never = true;
void _everyKindIsListed;

/** Icons only — display copy resolves from the catalog. Here rather than on
 * Home because the palette needs the same six: it kept its own copy and
 * derived its "create a tool" list from that copy's keys, so the two screens
 * could offer different tools while the contract test (which reads
 * TOOL_KINDS) stayed green. Typed as a full Record, so a kind added to the
 * wire type must get an icon. */
export const TOOL_ICONS: Record<ToolKind, typeof FileText> = {
  script: FileText,
  thumbnail: ImageIcon,
  voiceover: Mic,
  image: Aperture,
  music: Music,
  clip: Film,
};

/** The engine node kinds a tool session renders — what its readiness
 * preflight covers. `clip` is two: the keyframe is generated first and the
 * clip is conditioned on it (graph/templates.py builds the pair). A drift
 * here only mis-scopes a warning; the render itself never reads this. */
export const TOOL_ENGINE_KINDS: Record<ToolKind, string[]> = {
  script: ["script"],
  thumbnail: ["thumbnail"],
  voiceover: ["narration"],
  image: ["keyframe"],
  music: ["music"],
  clip: ["keyframe", "clip"],
};

/** What a kind is MADE OF — the tile tag's tint groups by this rather than
 * giving six tools six hues. The tag carries the exact word, so the color
 * is there to group, not to identify. A video project is `motion` too: a
 * clip and a finished video are the same medium. Typed as a full Record so
 * a new kind must declare its medium. */
export type KindMedium = "motion" | "text" | "audio" | "still";

export const TOOL_MEDIUM: Record<ToolKind, KindMedium> = {
  script: "text",
  thumbnail: "still",
  voiceover: "audio",
  image: "still",
  music: "audio",
  clip: "motion",
};

const KNOWN_TOOLS = new Set<string>(TOOL_KINDS);

/** Every `tool:` project, whether or not this build knows the kind. A session
 * made by a newer engine is still history: it must still be listed, opened
 * and deleted, so membership is deliberately looser than `toolKindOf`. */
export const isToolSession = (project: Project): boolean => project.mode.startsWith("tool:");

/** The kind, only when there is copy and an icon for it. An unknown kind
 * resolves to null rather than indexing the catalog with a key it does not
 * have — `m().tools[kind].label` THROWS on a miss, which takes the app down
 * through the error boundary rather than degrading. */
export const toolKindOf = (project: Project): ToolKind | null => {
  const kind = isToolSession(project) ? project.mode.slice(5) : "";
  return KNOWN_TOOLS.has(kind) ? (kind as ToolKind) : null;
};

/** A tool kind's display name, for the surfaces that hold the raw wire
 * string rather than a checked `ToolKind`. The kind itself is the fallback:
 * it is the engine's own word for the thing and reads as a name, which is a
 * better answer than a crash and than blank. */
export const toolLabel = (kind: string): string =>
  (m().tools as Record<string, { label: string } | undefined>)[kind]?.label ?? kind;

/** The voiceover panel's preview swatches. `brief` is what travels as the
 * `voice` param — the engine's kokoro backend resolves it by keyword — and
 * `voice` is the speaker that brief provably picks, which is also the name
 * of the bundled sample the swatch plays. Mirrored from kokoro.py's
 * _VOICE_MAP, so asserted by test_ui_contract.py: a brief that stops
 * resolving to its sample's speaker previews one voice and renders another. */
export const VOICE_SWATCHES = [
  { brief: "female", voice: "af_sarah" },
  { brief: "male", voice: "am_michael" },
  { brief: "british", voice: "bf_emma" },
  { brief: "deep", voice: "am_onyx" },
  { brief: "energetic", voice: "af_bella" },
] as const;

/** Motion preset chips for the clip panel — the v3 set. Keys only: the
 * label and the phrase a chip writes into the motion field both live in
 * i18n (home.motionPresets), because the phrase reaches the engine as
 * prompt text and is as user-visible as any other string. */
export const MOTION_PRESETS = ["pushIn", "orbit", "handheld", "static"] as const;

/** Tone and platform chips for the script panel. Same shape as
 * MOTION_PRESETS: keys here, copy in i18n (home.scriptPresets). A chip
 * scaffolds the prompt — the text lands in the textarea, visible and
 * editable, rather than as hidden request state. */
export const SCRIPT_PRESETS = ["youtube", "shorts", "tiktok", "explainer", "casual"] as const;
