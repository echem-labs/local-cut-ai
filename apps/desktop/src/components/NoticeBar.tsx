import type { Board, NodeNotice } from "../api/types";
import { m, t, type MessageKey } from "../i18n";
import { useApp } from "../store";

/** Every notice on the board, in board order: aux nodes first (the script
 * shortfall lives there), then scene cells. Deduped by code+data so a
 * re-render that re-emits the same fact does not stack copies. */
export function collectNotices(board: Board): NodeNotice[] {
  const cells = [
    ...Object.values(board.aux),
    ...board.scenes.flatMap((scene) => [
      scene.keyframe,
      scene.clip,
      scene.narration,
      ...(scene.clip_takes ?? []),
    ]),
  ];
  const seen = new Set<string>();
  const out: NodeNotice[] = [];
  for (const cell of cells) {
    for (const notice of cell?.notices ?? []) {
      const key = `${notice.code}:${JSON.stringify(notice.data)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(notice);
      }
    }
  }
  return out;
}

/** The catalog message for a notice, or null for a code this build does not
 * know — a newer engine behind an older desktop. Skipping is deliberate:
 * rendering the raw code would put an untranslated id on screen. */
export function noticeText(notice: NodeNotice): string | null {
  const known = notice.code
    .split(".")
    .reduce<unknown>(
      (acc, part) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined,
      m().notices,
    );
  if (typeof known !== "string") {
    if (import.meta.env.DEV) console.warn(`[notices] unknown code: ${notice.code}`);
    return null;
  }
  return t(`notices.${notice.code}` as MessageKey, notice.data);
}

/** Soft-warning bar above the scene board: everything a finished render
 * wants the user to know, one line per notice. Non-blocking by design —
 * unlike CheckpointBanner it asks for nothing, so it carries no accent and
 * no button, and it disappears when a re-render clears the notice. */
export function NoticeBar() {
  const { board } = useApp();
  if (!board) return null;
  const lines = collectNotices(board)
    .map((notice) => ({ notice, text: noticeText(notice) }))
    .filter((line): line is { notice: NodeNotice; text: string } => line.text !== null);
  if (lines.length === 0) return null;

  return (
    <div className="banner notice-bar" role="note" aria-label={t("project.noticesAria")}>
      {lines.map(({ notice, text }) => (
        <div className="row" key={`${notice.code}:${JSON.stringify(notice.data)}`}>
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}
