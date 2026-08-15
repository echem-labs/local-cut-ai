import {
  Boxes,
  Clapperboard,
  CircleSlash,
  Download,
  HardDriveDownload,
  PlugZap,
  ServerOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { ReadinessRow } from "../api/types";
import { m, plural, t, type MessageKey } from "../i18n";
import { distinctGaps, noteworthyGaps } from "../lib/readiness";
import { useApp } from "../store";
import { formatSize, ModelLibrary } from "./ModelLibrary";
import { Modal } from "./Modal";
import { Tip } from "./Tooltip";

/** The stage a row is about, in the words the rest of the app uses for it. */
function stageOf(row: ReadinessRow): string {
  const taskLabels = m().models.taskLabels as Record<string, string>;
  // An assembly row carries no task at all, so it falls through to the
  // KIND — which must go through the aux catalog, not onto the screen as
  // the wire id: "export" is a word this app never says ("Final video"
  // everywhere else), and a raw lowercase token in a list of catalog
  // labels reads as a bug. The bare kind stays as the last resort for a
  // kind a newer engine invented.
  const kindLabels = m().terms.aux as Record<string, string>;
  const task = typeof row.data.task === "string" ? row.data.task : "";
  return taskLabels[task] || task || kindLabels[row.kind] || row.kind;
}

/** Why the row is not ready — the CAUSE alone, carrying no consequence and
 * naming no stage. Both of those belong to the row rather than to the
 * cause, and folding them in here is what made one stopped ComfyUI print
 * "The image and video server is not running." three times in one banner.
 *
 * Null for a code this build has no catalog entry for (the NoticeBar
 * discipline: a newer engine's reason renders as nothing, never as a raw
 * id). */
function causeOf(row: ReadinessRow): string | null {
  const reasons = m().readiness.reasons as Record<string, string>;
  if (typeof reasons[row.reason] !== "string") {
    if (import.meta.env.DEV) console.warn(`[readiness] unknown reason: ${row.reason}`);
    return null;
  }
  return t(`readiness.reasons.${row.reason}` as MessageKey, {
    model: String(row.data.model ?? row.model ?? ""),
    provider: String(row.data.provider ?? ""),
  });
}

/** What the gap costs THIS stage, as a phrase that completes "Music: …".
 *
 * Three kinds carry their own, because the generic word for their verdict
 * is wrong about them: a placeholder music bed is not a placeholder in the
 * finished video, it is silence; a clip on the still tier is a real render,
 * not a lower-quality one; and an ignored model still renders, just not the
 * one that was asked for. Empty for a verdict this build does not know,
 * which renders as the stage alone. */
function effectOf(row: ReadinessRow): string {
  const effects = m().readiness.effects as Record<string, string>;
  if (row.kind === "music" && row.verdict === "placeholder") return effects.silentMusic;
  if (row.kind === "clip" && row.verdict === "degraded") return effects.stillClip;
  if (row.reason === "model_ignored") return effects.otherModel;
  const effect = effects[row.verdict];
  return typeof effect === "string" ? effect : "";
}

/** How loud a row is, and in what order its group should be read. Higher
 * is worse; the number is also the sort key, so "worst first" is one
 * comparison rather than a table of cases. */
const SEVERITY: Record<string, number> = { degraded: 1, placeholder: 2, will_fail: 3 };

/** The light a row shows. Placeholder is a RING rather than a fill: the
 * output it describes is hollow — a file that exists and contains nothing
 * anyone asked for — and the shape says that before the sentence does. */
const DOT: Record<string, string> = { degraded: "deg", placeholder: "ph", will_fail: "fail" };

/** The glyph for a cause, by what would fix it: a program to start, a
 * model to fetch, a provider to connect, or nothing (it is a
 * configuration, not an absence). Grouped deliberately by REMEDY rather
 * than by reason code, so two causes that want the same action from the
 * user carry the same mark. */
const CAUSE_ICON: Record<string, LucideIcon> = {
  comfyui_down: ServerOff,
  llm_server_down: ServerOff,
  no_model_installed: HardDriveDownload,
  still_clip_tier: HardDriveDownload,
  llm_model_missing: HardDriveDownload,
  cloud_key_missing: PlugZap,
  cloud_model_unknown: PlugZap,
  no_ffmpeg: Clapperboard,
};

export interface GapItem {
  key: string;
  stage: string;
  effect: string;
  verdict: string;
}

export interface GapGroup {
  cause: string;
  reason: string;
  items: GapItem[];
  /** The worst verdict inside, which decides both the well's edge colour
   * and where the group sorts. */
  severity: number;
}

/** Gaps grouped by cause, worst group first.
 *
 * One dead ComfyUI is one fact about the machine and three facts about the
 * render; grouped this way it is said once and then priced per stage. It
 * also degrades well: unrelated causes simply become their own groups.
 *
 * The ordering is the panel's whole argument — a reader who stops after
 * the first well has read the worst thing that will happen. */
export function gapGroups(rows: readonly ReadinessRow[]): GapGroup[] {
  const groups = new Map<string, GapGroup>();
  for (const row of distinctGaps(rows)) {
    const cause = causeOf(row);
    if (cause === null) continue;
    const group = groups.get(cause) ?? { cause, reason: row.reason, items: [], severity: 0 };
    group.items.push({
      key: `${row.kind}:${row.model ?? ""}:${row.reason}`,
      stage: stageOf(row),
      effect: effectOf(row),
      verdict: row.verdict,
    });
    group.severity = Math.max(group.severity, SEVERITY[row.verdict] ?? 0);
    groups.set(cause, group);
  }
  // Stable within a severity: Array.prototype.sort is required to be
  // stable, so equally-bad groups keep the engine's pipeline order rather
  // than shuffling between two reports that say the same thing.
  return [...groups.values()].sort((a, b) => b.severity - a.severity);
}

/** One readiness gap as a standalone sentence, for the surfaces that have
 * room for exactly one (Home's prompt box and tool box). Null when the
 * reason has no catalog entry — those callers gate on it. */
export function describeGap(row: ReadinessRow): string | null {
  const cause = causeOf(row);
  if (cause === null) return null;
  const effect = effectOf(row);
  return effect ? `${cause} ${t("readiness.line", { stage: stageOf(row), effect })}` : cause;
}

/** The gap list, shared by the banner and the gate so the two say the same
 * thing the same way — one well per cause, one lit row per stage it costs
 * something. The banner compacts it by context selector rather than by a
 * prop: there is one component here, and the surface it lands on decides
 * how dense it is.
 *
 * The list is a `ul` of `li`s and reads as one to a screen reader; the
 * dots are decoration, because the row's own words already carry the
 * severity ("a failed job", "a stand-in"). */
export function GapList({ rows }: { rows: readonly ReadinessRow[] }) {
  const groups = gapGroups(rows);
  if (groups.length === 0) return null;
  const totals = severityTotals(groups);
  return (
    <>
      {/* Only worth totalling when there is more than one well: with a
          single group the well IS the summary, and a chip repeating it is
          furniture. */}
      {groups.length > 1 && totals.length > 0 && (
        <div className="sev-row">
          {totals.map((total) => (
            <span className="sev-chip" key={total.verdict}>
              <span className={`pdot ${DOT[total.verdict]}`} aria-hidden="true" />
              <span className="readout">{total.count}</span>
              {t(`readiness.totals.${total.verdict}` as MessageKey)}
            </span>
          ))}
        </div>
      )}
      <div className="gap-list">
        {groups.map((group) => {
          const Icon = CAUSE_ICON[group.reason] ?? CircleSlash;
          return (
            <div
              className={`well ${group.severity >= SEVERITY.placeholder ? "edge-fail" : "edge-deg"}`}
              key={group.cause}
            >
              <div className="whead">
                <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>{group.cause}</span>
              </div>
              <ul className="plist">
                {group.items.map((item) => (
                  <li className="prow" key={item.key}>
                    <span className={`pdot ${DOT[item.verdict] ?? "deg"}`} aria-hidden="true" />
                    <span className="pname">{item.stage}</span>
                    <span className={`price${item.verdict === "will_fail" ? " fail" : ""}`}>
                      {item.effect}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** How many stages sit at each severity, worst first — the chip strip's
 * data. Counted over ITEMS rather than groups: two causes that both cost a
 * placeholder are two placeholders to the person reading. */
function severityTotals(groups: GapGroup[]): { verdict: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const item of group.items) {
      if (SEVERITY[item.verdict] === undefined) continue;
      counts.set(item.verdict, (counts.get(item.verdict) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([verdict, count]) => ({ verdict, count }))
    .sort((a, b) => (SEVERITY[b.verdict] ?? 0) - (SEVERITY[a.verdict] ?? 0));
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

  // Gated on the RENDERED groups, not on the row count: a report made
  // entirely of reason codes this build has no catalog entry for would
  // otherwise draw an empty warning box.
  if (gapGroups(gaps).length === 0) return null;
  // One direct shortcut at most: with a single downloadable gap the fix is
  // one click; anything wider belongs in Settings → Models, whole.
  // Counted by distinct MODEL, not by row: one missing image model shows
  // up as both a keyframe gap and a thumbnail gap, and that is still one
  // download — hiding the button there hides it in the very case it is for.
  const downloads = gaps.filter((row) => row.fix?.type === "download");
  const singleModel = new Set(
    downloads.map((row) => (row.fix?.type === "download" ? row.fix.model_id : "")),
  ).size === 1;
  const direct = singleModel ? downloads[0] : null;
  const directFix = direct?.fix?.type === "download" ? direct.fix : null;
  const downloading =
    directFix != null && models.some((row) => row.id === directFix.model_id && row.downloading);

  // The strip's own edge repeats the worst light inside it, so the board
  // can be read from the corner of the eye without expanding anything.
  const worst = Math.max(...gapGroups(gaps).map((group) => group.severity), 0);
  const grave = worst >= SEVERITY.placeholder;

  return (
    <div role="status" className={`banner readiness${grave ? " worst-fail" : ""}`}>
      <div className="row">
        {/* Coloured by the worst gap present — a status hue on a status
            mark, which is the one use the palette reserves them for. */}
        <TriangleAlert
          size={15}
          strokeWidth={1.8}
          aria-hidden="true"
          color={`var(--status-${grave ? "failed" : "draft"})`}
        />
        <b>{t("readiness.banner.title")}</b>
        <span className="spacer" />
        {directFix && (
          <button
            className="btn-outline"
            disabled={downloading}
            onClick={() => void startDownload(directFix.model_id)}
          >
            <HardDriveDownload size={14} strokeWidth={1.8} aria-hidden="true" />
            {t("readiness.banner.downloadPlain", { model: directFix.model_id })}
            {directFix.size_bytes > 0 && (
              <span className="readout">{formatSize(directFix.size_bytes)}</span>
            )}
          </button>
        )}
        <button className="btn-ghost" onClick={() => openSettings("models")}>
          <Boxes size={14} strokeWidth={1.8} aria-hidden="true" />
          {t("readiness.banner.setup")}
        </button>
      </div>
      <GapList rows={gaps} />
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
  kinds,
  onProceed,
  onClose,
}: {
  scopeKey: string;
  rows: ReadinessRow[];
  /** What the gate asked about, so a dismissal covers that question and
   * not every other one this scope can raise. */
  kinds?: string[];
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
  const groups = gapGroups(rows);
  const stages = groups.reduce((count, group) => count + group.items.length, 0);
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
            <Boxes size={14} strokeWidth={1.8} aria-hidden="true" />
            {t("readiness.dialog.setup")}
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              suppressReadiness(scopeKey, rows, scope, kinds);
              onProceed();
            }}
          >
            {t("readiness.dialog.renderAnyway")}
          </button>
        </>
      }
    >
      <IntroSentence stages={stages} />
      <GapList rows={rows} />
      {downloadIds.size > 0 && (
        <div className="well gate-downloads">
          <div className="whead label">
            <Download size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{t("readiness.dialog.fixes")}</span>
          </div>
          <ModelLibrary showActions filterIds={downloadIds} />
        </div>
      )}
      <div className="gate-scope">
        <div className="lbl">{t("readiness.dialog.skip")}</div>
        <div className="sc">
          <div className="seg-toggle" role="group" aria-label={t("readiness.dialog.skip")}>
            {scopes.map((option) => (
              <button
                key={option.id}
                className={scope === option.id ? "active" : ""}
                onClick={() => setScope(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {/* The hint that used to live in a tooltip on each segment. On
              screen it costs one line and answers the question the control
              actually raises ("for how long?") without a hover, which is
              the only way a pointerless user was ever going to read it. */}
          <div className="scope-hint" role="status">
            {t(`readiness.dialog.scopeHint.${scope}` as MessageKey)}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** The gate's one sentence, with its count set as a readout.
 *
 * The number is pulled out of the translated string rather than
 * concatenated around it: word order moves between languages, and a
 * sentence assembled from fragments cannot follow it. Passing `count` as a
 * sentinel makes `plural()` do the grammar (it still selects the category
 * from the real number) and hands back the sentence with a hole in it. */
function IntroSentence({ stages }: { stages: number }) {
  // A character no catalog string can contain, so the split can only land
  // on the placeholder. Splitting on the rendered NUMBER would break the
  // moment a sentence contained that digit anywhere else.
  const SLOT = "\u0000";
  const [before, after] = plural("readiness.dialog.intro", stages, { count: SLOT }).split(SLOT);
  return (
    <p className="gate-intro">
      {before}
      {after !== undefined && <span className="readout">{stages}</span>}
      {after}
    </p>
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
    kinds?: string[];
    proceed: () => void;
  } | null>(null);
  const busy = useRef(false);
  // Read inside the guard's `finally`, where `pending` is still the stale
  // render-time value.
  const pendingRef = useRef(false);

  const guard = async (run: () => void | Promise<void>, kinds?: string[]) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const rows = await readinessGaps(scopeKey, kinds);
      if (rows) {
        // Held until the user answers the dialog — `release` clears it.
        setPending({ rows, kinds, proceed: () => void run() });
        return;
      }
      // Inside the lock, not after it: the click this guards starts a
      // render, and releasing before the action ran left the second click
      // of a double-click free to start a second one — the exact case the
      // lock exists for, on surfaces (ToolSession's Regenerate) that carry
      // no busy state of their own.
      await run();
    } finally {
      busy.current = pendingRef.current;
    }
  };

  const release = () => {
    busy.current = false;
    pendingRef.current = false;
    setPending(null);
  };
  pendingRef.current = pending !== null;

  const dialog = pending ? (
    <ReadinessDialog
      scopeKey={scopeKey}
      rows={pending.rows}
      kinds={pending.kinds}
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
