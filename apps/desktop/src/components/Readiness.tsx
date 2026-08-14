import { useRef, useState, type ReactNode } from "react";
import type { ReadinessRow } from "../api/types";
import { m, t, type MessageKey } from "../i18n";
import { distinctGaps, noteworthyGaps } from "../lib/readiness";
import { useApp } from "../store";
import { formatSize, ModelLibrary } from "./ModelLibrary";
import { Modal } from "./Modal";
import { Tip } from "./Tooltip";

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
  // The kind is the fallback, and it has to be reachable: an assembly row
  // carries no task at all, and "No model is installed for ." is the one
  // sentence worse than naming the raw kind.
  const task = typeof row.data.task === "string" ? row.data.task : "";
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

/** Gap sentences, deduped and translated, ready to render. */
function gapLines(rows: readonly ReadinessRow[]): { row: ReadinessRow; text: string }[] {
  return distinctGaps(rows)
    .map((row) => ({ row, text: describeGap(row) }))
    .filter((line): line is { row: ReadinessRow; text: string } => line.text !== null);
}

/** Non-blocking facts strip for the workspace (project board and tool
 * sessions): what will not render properly, and the shortest path to
 * fixing it. Never suppressed — dismissing the DIALOG must not take the
 * facts off the screen — and it clears itself the moment a download lands,
 * because the store refetches readiness on every terminal download event.
 *
 * Unlike the gate, this states `degraded` too: "no video model, so your
 * scenes will be stills" is a fact worth having, even though it is never
 * worth a dialog. */
export function ReadinessBanner() {
  const projectReadiness = useApp((state) => state.projectReadiness);
  const models = useApp((state) => state.models);
  const startDownload = useApp((state) => state.startDownload);
  const openSettings = useApp((state) => state.openSettings);
  const gaps = noteworthyGaps(projectReadiness);
  if (gaps.length === 0) return null;

  const lines = gapLines(gaps);
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
            {directFix.size_bytes > 0
              ? t("readiness.banner.download", {
                  model: directFix.model_id,
                  size: formatSize(directFix.size_bytes),
                })
              : t("readiness.banner.downloadPlain", { model: directFix.model_id })}
          </button>
        )}
        <button className="btn-outline" onClick={() => openSettings("models")}>
          {t("readiness.banner.setup")}
        </button>
      </div>
      {lines.map(({ row, text }) => (
        <p key={`${row.kind}:${row.model ?? ""}:${row.reason}`}>{text}</p>
      ))}
    </div>
  );
}

/** The gate at the moment of spend. Fires only from an explicit
 * render-starting click (never from implicit re-renders — doc 09 P5), lists
 * each gap in plain words, embeds the model library filtered to the
 * downloadable fixes, and always leaves "Render anyway" on the table —
 * warning, not paywall. The scope control decides how long this exact set
 * of problems stays quiet. */
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
  const [scope, setScope] = useState<"session" | "project" | "always">("session");
  const setupRef = useRef<HTMLButtonElement>(null);
  const downloadIds = new Set(
    rows.flatMap((row) => (row.fix?.type === "download" ? [row.fix.model_id] : [])),
  );
  const lines = gapLines(rows);
  // A segmented toggle, not a checkbox plus a dropdown: that pairing put a
  // button inside a <label> (which then absorbed the menu's value into the
  // checkbox's accessible name), and Modal's capture-phase Escape closed
  // the whole dialog out from under the open menu. This is also the app's
  // standard control for a small enum.
  const scopes = [
    { id: "session", label: t("readiness.dialog.scopeSession") },
    { id: "project", label: t("readiness.dialog.scopeProject") },
    { id: "always", label: t("readiness.dialog.scopeAlways") },
  ] as const;

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
              suppressReadiness(scopeKey, rows, scope);
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
          <li key={`${row.kind}:${row.model ?? ""}:${row.reason}`}>{text}</li>
        ))}
      </ul>
      {downloadIds.size > 0 && <ModelLibrary showActions filterIds={downloadIds} />}
      <div className="setting-row">
        <div className="st">{t("readiness.dialog.skip")}</div>
        <div className="sc">
          <div className="seg-toggle" role="group" aria-label={t("readiness.dialog.skip")}>
            {scopes.map((option) => (
              <Tip
                key={option.id}
                label={option.label}
                hint={t(`readiness.dialog.scopeHint.${option.id}` as MessageKey)}
              >
                <button
                  className={scope === option.id ? "active" : ""}
                  onClick={() => setScope(option.id)}
                >
                  {option.label}
                </button>
              </Tip>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** One hook per surface that starts renders: `guard(run)` either runs the
 * action straight away (no gaps, or warned-and-dismissed already) or holds
 * it behind the dialog, whose "Render anyway" releases it. `dialog` is the
 * element the host must render — and it must be rendered OUTSIDE anything
 * that can unmount while it is open, or the held action is silently lost.
 *
 * The in-flight lock is load-bearing: the preflight is a network round trip
 * that probes Ollama and ComfyUI, and without it a second click during that
 * second starts a second render — on the most expensive button in the app.
 */
export function useReadinessGuard(scopeKey: string): {
  guard: (run: () => void | Promise<void>, kinds?: string[]) => Promise<void>;
  dialog: ReactNode;
} {
  const readinessGaps = useApp((state) => state.readinessGaps);
  const [pending, setPending] = useState<{
    rows: ReadinessRow[];
    proceed: () => void;
  } | null>(null);
  const busy = useRef(false);

  const guard = async (run: () => void | Promise<void>, kinds?: string[]) => {
    if (busy.current) return;
    busy.current = true;
    let rows: ReadinessRow[] | null = null;
    try {
      rows = await readinessGaps(scopeKey, kinds);
    } finally {
      // Held open only while a dialog is up — that IS the re-entry guard
      // until the user answers it.
      busy.current = rows !== null;
    }
    if (!rows) {
      await run();
      return;
    }
    setPending({ rows, proceed: () => void run() });
  };

  const release = () => {
    busy.current = false;
    setPending(null);
  };

  const dialog = pending ? (
    <ReadinessDialog
      scopeKey={scopeKey}
      rows={pending.rows}
      onProceed={() => {
        const held = pending;
        release();
        held.proceed();
      }}
      onClose={release}
    />
  ) : null;

  return { guard, dialog };
}
