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
import type { Project, ToolKind } from "../api/types";
import { m } from "../i18n";

/** The kinds this build has copy and an icon for, in the order Home offers
 * them. Typed as ToolKind, so dropping one the catalog still defines is a
 * compile error at the icon map rather than a session that lists as
 * unknown. */
export const TOOL_KINDS = [
  "script",
  "thumbnail",
  "voiceover",
  "image",
  "music",
  "clip",
] as const satisfies readonly ToolKind[];

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
