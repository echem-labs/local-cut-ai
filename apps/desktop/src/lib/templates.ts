import type { ProjectTemplate } from "../api/types";

/**
 * Saved templates live in this profile, not in the engine: the engine only
 * exports and imports the document (`GET /projects/{id}/template`,
 * `POST /projects/from-template`) and keeps no list of its own. Keeping them
 * here also keeps the desktop's promise — it talks to the engine over HTTP
 * and nothing else, so a remote engine on a GPU box behaves identically.
 */
export interface TemplateEntry {
  id: string;
  name: string;
  savedAt: number;
  doc: ProjectTemplate;
}

const KEY = "localcut.templates.v1";
/** Bounded on both axes: this shares a ~5 MB origin quota with the draft,
 * the layout and the defaults, and one 500-node graph is not small. */
export const TEMPLATE_LIMIT = 20;
export const TEMPLATE_MAX_BYTES = 512 * 1024;

export function loadTemplates(): TemplateEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TemplateEntry =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as TemplateEntry).id === "string" &&
        typeof (entry as TemplateEntry).name === "string" &&
        !!(entry as TemplateEntry).doc,
    );
  } catch {
    return [];
  }
}

/** Newest first, so "Start from a template…" opens on what was just saved. */
export function saveTemplates(entries: TemplateEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* storage full — the list just won't survive the restart */
  }
}

/** Why a document cannot be kept, or null when it can. Size is measured on
 * the encoded document, which is what the quota actually counts. */
export function refuseReason(doc: ProjectTemplate, existing: TemplateEntry[]): string | null {
  if (existing.length >= TEMPLATE_LIMIT) return "limit";
  if (JSON.stringify(doc).length > TEMPLATE_MAX_BYTES) return "size";
  return null;
}
