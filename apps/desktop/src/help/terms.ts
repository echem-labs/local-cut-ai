/** Node-id → human-name mapping (design review 3, §5).
 *
 * Node ids and kind strings are the ENGINE'S WIRE CONTRACT — the labels here
 * are display-side only; identifiers on the wire never change. The words
 * themselves live in the i18n catalog (i18n/en/terms.json) so tooltips, the
 * glossary, panel help and queue labels all read from one place and can be
 * translated. Call t("terms.tips.<x>") for a tooltip and m().terms.glossary
 * for the glossary array; this module only does the id parsing.
 */
import { m, t } from "../i18n";

const SCENE_NODE = /^s(\d+)\.([a-z]+?)(\d*)$/;

const auxLabels = (): Record<string, string> => m().terms.aux;
const kindLabels = (): Record<string, string> => m().terms.kinds;

/** "s2.clip" → "Scene 2 video" · "s5.keyframe" → "Scene 5 still image" ·
 * "timeline" → "Timeline". Raw ids never reach the UI. */
export function nodeLabel(nodeId: string): string {
  const aux = auxLabels()[nodeId];
  if (aux) return aux;
  const match = SCENE_NODE.exec(nodeId);
  if (match) {
    const [, scene, kind, take] = match;
    const base = t("terms.nodeSceneKind", { scene, kind: kindLabels()[kind] ?? kind });
    // The engine names take 1 `s1.clip` and take N `s1.clipN`, so the
    // trailing digit is the take number rather than an index.
    return take ? base + t("terms.nodeTake", { take: Number(take) }) : base;
  }
  return nodeId;
}

/** Scene number from any scene-member node id, or null for aux nodes. */
export function sceneNumber(nodeId: string): string | null {
  return SCENE_NODE.exec(nodeId)?.[1] ?? null;
}

/** Short title for the inspector: "Scene 5" / "Music". */
export function inspectorTitle(nodeId: string): string {
  const scene = sceneNumber(nodeId);
  if (scene) return t("terms.inspectorScene", { scene });
  return auxLabels()[nodeId] ?? nodeId;
}
