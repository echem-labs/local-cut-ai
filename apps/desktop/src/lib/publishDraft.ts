import type { PublishKit } from "../api/types";

/**
 * Hand edits to the publish kit, per project, in localStorage.
 *
 * The engine has no home for these. `metadata` is a graph node whose ARTIFACT
 * is what the model wrote; its params are the prompt that produced it, so
 * there is no `set_params` that means "keep my title instead". Writing one
 * would be inventing an override the engine does not have.
 *
 * localStorage rather than the project directory, and deliberately: this text
 * is a staging area for a paste into someone else's upload form, not part of
 * the video. The same shape `editlog` already uses for the same reason — and
 * like it, every accessor swallows storage errors, because a full origin
 * store must degrade to "no draft", never break the dialog.
 */

const draftKey = (projectId: string) => `localcut.publishDraft.${projectId}`;

/** A field is only remembered once it DIFFERS from what the engine wrote, so
 * a regenerated kit is not shadowed forever by a draft that agreed with the
 * old one. */
export function loadDraft(projectId: string): Partial<PublishKit> {
  try {
    const raw = localStorage.getItem(draftKey(projectId));
    const parsed = raw ? (JSON.parse(raw) as Partial<PublishKit>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveDraft(projectId: string, draft: Partial<PublishKit>): void {
  try {
    if (Object.keys(draft).length === 0) localStorage.removeItem(draftKey(projectId));
    else localStorage.setItem(draftKey(projectId), JSON.stringify(draft));
  } catch {
    /* storage full — edits just won't survive a restart */
  }
}

/** Drop a deleted project's draft. Per-project keys accumulate for the life
 * of the install otherwise, and once the origin quota is reached EVERY
 * setItem starts throwing — the workspace quietly stops surviving a restart
 * with no error anywhere. The lesson `forgetEditLog` records. */
export function forgetPublishDraft(projectId: string): void {
  try {
    localStorage.removeItem(draftKey(projectId));
  } catch {
    /* nothing to clean up if the store is unavailable */
  }
}

/** What the dialog shows: the engine's kit with any hand edits over it. */
export function mergeDraft(kit: PublishKit, draft: Partial<PublishKit>): PublishKit {
  return {
    title: draft.title ?? kit.title,
    description: draft.description ?? kit.description,
    hashtags: draft.hashtags ?? kit.hashtags,
  };
}
