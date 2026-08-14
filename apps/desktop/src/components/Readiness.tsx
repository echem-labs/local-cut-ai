import { useRef, useState, type ReactNode } from "react";
import type { ReadinessRow } from "../api/types";
import { m, t, type MessageKey } from "../i18n";
import { useApp } from "../store";
import { Dropdown } from "./Dropdown";
import { formatSize, ModelLibrary } from "./ModelLibrary";
import { Modal } from "./Modal";

/** The sentence for one readiness gap: the reason (from the catalog, keyed
 * by the wire code — the NoticeBar discipline, so a code from a newer
 * engine renders as nothing rather than as a raw id) plus what it means
 * for the render. Music gets its own consequence: a placeholder bed is not
 * a placeholder in the finished video, it is silence. */
export function describeGap(row: ReadinessRow): string | null {
  const reasons = m().readiness.reasons as Record<string, string>;
  if (typeof reasons[row.reason] !== "string") {
    if (import.meta.env.DEV) console.warn(`[readiness] unknown reason: ${row.reason}`);
    return null;
  }
  const taskLabels = m().models.taskLabels as Record<string, string>;
  const task = String(row.data.task ?? "");
  const sentence = t(`readiness.reasons.${row.reason}` as MessageKey, {
    task: taskLabels[task] ?? task ?? row.kind,
    model: String(row.data.model ?? row.model ?? ""),
    provider: String(row.data.provider ?? ""),
  });
  if (row.verdict === "placeholder" && row.kind === "music") {
    return `${sentence} ${t("readiness.consequences.placeholderMusic")}`;
  }
  const consequences = m().readiness.consequences as Record<string, string>;
  const consequence = consequences[row.verdict];
  return typeof consequence === "string" ? `${sentence} ${consequence}` : sentence;
}

/** The gaps worth interrupting for. `degraded` (the still-clip tier) is a
 * supported mode on low-VRAM machines — never a banner, never a dialog. */
export function hardGaps(rows: ReadinessRow[] | null): ReadinessRow[] {
  return (rows ?? []).filter(
    (row) => row.verdict === "placeholder" || row.verdict === "will_fail",
  );
}

/** Non-blocking facts strip for the workspace (project board and tool
 * sessions): what will not render properly, and the shortest path to
 * fixing it. Never suppressed — dismissing the DIALOG must not take the
 * facts off the screen — and it clears itself the moment a download lands,
 * because the store refetches readiness on every terminal download event. */
export function ReadinessBanner() {
  const projectReadiness = useApp((state) => state.projectReadiness);
  const models = useApp((state) => state.models);
  const startDownload = useApp((state) => state.startDownload);
  const openSettings = useApp((state) => state.openSettings);
  const gaps = hardGaps(projectReadiness);
  if (gaps.length === 0) return null;

  const lines = gaps
    .map((row) => ({ row, text: describeGap(row) }))
    .filter((line): line is { row: ReadinessRow; text: string } => line.text !== null);
  if (lines.length === 0) return null;
  // One direct shortcut at most: with a single downloadable gap the fix is
  // one click; anything wider belongs in Settings → Models, whole.
  const downloads = gaps.filter((row) => row.fix?.type === "download");
  const direct = downloads.length === 1 ? downloads[0] : null;
  const directFix = direct?.fix?.type === "download" ? direct.fix : null;
  const downloading =
    directFix != null && models.some((row) => row.id === directFix.model_id && row.downloading);

  return (
    <div role="status" className="banner warning">
      <div className="row">
        <b>{t("readiness.banner.title")}</b>
        <span className="spacer" />
        {directFix && (
          <button
            className="btn-outline"
            disabled={downloading}
            onClick={() => void startDownload(directFix.model_id)}
          >
            {t("readiness.banner.download", {
              model: directFix.model_id,
              size: formatSize(directFix.size_bytes),
            })}
          </button>
        )}
        <button className="btn-outline" onClick={() => openSettings("models")}>
          {t("readiness.banner.setup")}
        </button>
      </div>
      {lines.map(({ row, text }) => (
        <p key={`${row.kind}:${row.model ?? ""}`}>{text}</p>
      ))}
    </div>
  );
}

/** The gate at the moment of spend. Fires only from an explicit
 * render-starting click (never from implicit re-renders — doc 09 P5), lists
 * each gap in plain words, embeds the model library filtered to the
 * downloadable fixes, and always leaves "Render anyway" on the table —
 * warning, not paywall. Proceeding quiets this exact gap set for the
 * session; the checkbox escalates to the project or to the master switch. */
export function ReadinessDialog({
  scopeKey,
  rows,
  onProceed,
  onClose,
}: {
  scopeKey: string;
  rows: ReadinessRow[];
  onProceed: () => void;
  onClose: () => void;
}) {
  const suppressReadiness = useApp((state) => state.suppressReadiness);
  const openSettings = useApp((state) => state.openSettings);
  const [skip, setSkip] = useState(false);
  const [scope, setScope] = useState<"project" | "always">("project");
  const setupRef = useRef<HTMLButtonElement>(null);
  const downloadIds = new Set(
    rows.flatMap((row) => (row.fix?.type === "download" ? [row.fix.model_id] : [])),
  );
  const lines = rows
    .map((row) => ({ row, text: describeGap(row) }))
    .filter((line): line is { row: ReadinessRow; text: string } => line.text !== null);

  return (
    <Modal
      title={t("readiness.dialog.title")}
      role="alertdialog"
      size="m"
      onClose={onClose}
      initialFocus={setupRef}
      footer={
        <>
          <button
            className="btn-ghost"
            ref={setupRef}
            onClick={() => {
              onClose();
              openSettings("models");
            }}
          >
            {t("readiness.dialog.setup")}
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              suppressReadiness(scopeKey, rows, skip ? scope : "session");
              onProceed();
            }}
          >
            {t("readiness.dialog.renderAnyway")}
          </button>
        </>
      }
    >
      <p>{t("readiness.dialog.intro")}</p>
      <ul>
        {lines.map(({ row, text }) => (
          <li key={`${row.kind}:${row.model ?? ""}`}>{text}</li>
        ))}
      </ul>
      {downloadIds.size > 0 && <ModelLibrary showActions filterIds={downloadIds} />}
      <label className="row">
        <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
        <span>{t("readiness.dialog.skip")}</span>
        {skip && (
          <Dropdown
            value={scope}
            variant="field"
            ariaLabel={t("readiness.dialog.skip")}
            options={[
              { value: "project", label: t("readiness.dialog.scopeProject") },
              { value: "always", label: t("readiness.dialog.scopeAlways") },
            ]}
            onChange={(value) => setScope(value === "always" ? "always" : "project")}
          />
        )}
      </label>
    </Modal>
  );
}

/** One hook per surface that starts renders: `guard(run)` either runs the
 * action straight away (no gaps, or warned-and-dismissed already) or holds
 * it behind the dialog, whose "Render anyway" releases it. `dialog` is the
 * element the host must render. */
export function useReadinessGuard(scopeKey: string): {
  guard: (run: () => void | Promise<void>, kinds?: string[]) => Promise<void>;
  dialog: ReactNode;
} {
  const readinessGaps = useApp((state) => state.readinessGaps);
  const [pending, setPending] = useState<{
    rows: ReadinessRow[];
    proceed: () => void;
  } | null>(null);

  const guard = async (run: () => void | Promise<void>, kinds?: string[]) => {
    const rows = await readinessGaps(scopeKey, kinds);
    if (!rows) {
      await run();
      return;
    }
    setPending({ rows, proceed: () => void run() });
  };

  const dialog = pending ? (
    <ReadinessDialog
      scopeKey={scopeKey}
      rows={pending.rows}
      onProceed={() => {
        const held = pending;
        setPending(null);
        held.proceed();
      }}
      onClose={() => setPending(null)}
    />
  ) : null;

  return { guard, dialog };
}
