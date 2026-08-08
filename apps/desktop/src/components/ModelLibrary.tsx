import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModelLicense, ModelRow } from "../api/types";
import { m, t } from "../i18n";
import type { Fit } from "../lib/fit";
import { isWindows } from "../lib/platform";
import { useApp } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dropdown } from "./Dropdown";
import { Tip } from "./Tooltip";

// Safety net when the WS is down or a terminal event was missed; WS
// progress events (~0.5s) drive the bars in between.
const POLL_MS = 4000;

export function formatSize(bytes: number): string {
  if (bytes <= 0) return t("common.sizeGb", { value: 0 });
  const gb = bytes / 2 ** 30;
  if (gb >= 10) return t("common.sizeGb", { value: Math.round(gb) });
  if (gb >= 1) return t("common.sizeGb", { value: gb.toFixed(1) });
  return t("common.sizeMb", { value: Math.max(1, Math.round(bytes / 2 ** 20)) });
}

/** "wan 2.2" → "Wan 2.2", "ltx" → "LTX", "sdxl" → "SDXL": manifest family
 * strings are lowercase ids; display leads with a human name (review 4
 * §S8). Vowel-less short tokens read as acronyms. */
export function displayModelName(family: string, version = ""): string {
  const pretty = family
    .split(/\s+/)
    .map((word) =>
      /[aeiou]/i.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word.toUpperCase(),
    )
    .join(" ");
  return `${pretty}${version ? ` ${version}` : ""}`;
}

/** External text.llm picks run in Ollama; other externals (TTS, captions)
 * are companion processes beside the engine. Same wire fact (files: []),
 * different words — the engine doesn't say which runtime, so the task id
 * decides, and the wizard's rail reads the same fact the same way. */
export const OLLAMA_TASK = "text.llm";
const COMPANION_TASKS = new Set(["speech.tts", "transcribe"]);

/** What an external row says instead of a download size. The badge beside
 * it already says "external"; this says what that MEANS — but only for
 * the tasks this build actually ships a runtime for. Anything else
 * external is a model the app cannot name a runtime for, and the bare
 * word is the honest answer (the wizard mock's flux row says exactly
 * that). */
export function externalNote(task: string): string {
  if (task === OLLAMA_TASK) return t("models.ollamaMeta");
  return COMPANION_TASKS.has(task) ? t("models.externalMeta") : t("models.external");
}

const VERDICTS: Record<
  ModelLicense["verdict"],
  { glyph: string; labelKey: "commercial" | "conditions" | "personalOnly"; cls: string }
> = {
  commercial: { glyph: "✓", labelKey: "commercial", cls: "ok" },
  conditions: { glyph: "⚠", labelKey: "conditions", cls: "warn" },
  "personal-only": { glyph: "✗", labelKey: "personalOnly", cls: "bad" },
};

export function LicenseBadge({ license }: { license: ModelLicense }) {
  const verdict = VERDICTS[license.verdict] ?? VERDICTS.conditions;
  return (
    <span className={`badge ${verdict.cls}`} title={license.notes || license.id}>
      {verdict.glyph} {t(`models.verdicts.${verdict.labelKey}`)}
    </span>
  );
}

interface ModelLibraryProps {
  /** Checkbox mode (first-run customize): the picked ids. */
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  /** Show a Download button on rows not yet installed. */
  showActions?: boolean;
  /** Restrict to these ids (first-run download progress view). */
  filterIds?: Set<string>;
  /** Offer the "+ Add custom model" flow (Settings only, review 4). */
  showAddCustom?: boolean;
  /** Wizard library mode: accent-outline the engine's pick per stage. */
  recommendedIds?: Set<string>;
  /** Wizard library mode: grey rows that cannot load on this machine
   * (checkbox disabled, reason badge) — lib/fit.ts decides. */
  fitOf?: (row: ModelRow) => Fit;
  /** With fitOf: drop won't-fit rows entirely ("Fits this machine"). */
  hideUnfit?: boolean;
}

const CUSTOM_TASKS = [
  "video.i2v",
  "video.t2v",
  "image.gen",
  "text.llm",
  "speech.tts",
  "music.gen",
  "transcribe",
] as const;

/** Register a user model outside the curated catalog: URL or local file,
 * task slot, VRAM, optional workflow — behind the doc-04 license
 * self-acknowledgment (review 4 "Add custom model"). */
function AddCustomModel({ onDone }: { onDone: () => void }) {
  const addCustomModel = useApp((state) => state.addCustomModel);
  // Read, never fetched here: Settings → Workflows owns the list, and a
  // form that refetched it would be a second caller of /comfy/* whose
  // failure mode is an empty picker with no explanation.
  const importedWorkflows = useApp((state) => state.workflows);
  const [name, setName] = useState("");
  const [task, setTask] = useState<string>("video.i2v");
  const [source, setSource] = useState<"url" | "file">("url");
  const [ref, setRef] = useState("");
  const [vram, setVram] = useState("8");
  const [workflow, setWorkflow] = useState("");
  const [acked, setAcked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskLabels = m().models.taskLabels as Record<string, string>;
  const canAdd = Boolean(name.trim() && ref.trim() && acked && !saving);

  const submit = async () => {
    if (!canAdd) return;
    setSaving(true);
    setError(null);
    const result = await addCustomModel({
      name: name.trim(),
      task,
      source,
      ref: ref.trim(),
      vram_gb: Number.parseFloat(vram) || 8,
      ...(workflow.trim() ? { workflow_template: workflow.trim() } : {}),
    });
    setSaving(false);
    if (result) setError(result);
    else onDone();
  };

  return (
    <div className="custom-model-form">
      <div className="form-row">
        <div className="grow">
          <label htmlFor="custom-source">{t("models.custom.source")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <div className="seg-toggle" role="group" aria-label={t("models.custom.source")}>
              <button
                className={source === "url" ? "active" : ""}
                onClick={() => setSource("url")}
              >
                {t("models.custom.sourceUrl")}
              </button>
              <button
                className={source === "file" ? "active" : ""}
                onClick={() => setSource("file")}
              >
                {t("models.custom.sourceFile")}
              </button>
            </div>
            <input
              id="custom-source"
              style={{ flex: 1, minWidth: 180 }}
              value={ref}
              placeholder={
                source === "url"
                  ? t("models.custom.urlPlaceholder")
                  : t(
                      isWindows
                        ? "models.custom.filePlaceholderWindows"
                        : "models.custom.filePlaceholderPosix",
                    )
              }
              onChange={(event) => setRef(event.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="form-row">
        <div>
          <label htmlFor="custom-task">{t("models.custom.task")}</label>
          <Dropdown
            value={task}
            onChange={setTask}
            ariaLabel={t("models.custom.task")}
            options={CUSTOM_TASKS.map((id) => ({ value: id, label: taskLabels[id] ?? id }))}
          />
        </div>
        <div className="grow">
          <label htmlFor="custom-name">{t("models.custom.name")}</label>
          <input
            id="custom-name"
            value={name}
            placeholder={t("models.custom.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div style={{ width: 110 }}>
          <label htmlFor="custom-vram">{t("models.custom.vram")}</label>
          <input
            id="custom-vram"
            type="number"
            min={0}
            step={1}
            value={vram}
            onChange={(event) => setVram(event.target.value)}
          />
        </div>
      </div>
      <div>
        <label htmlFor="custom-workflow">{t("models.custom.workflow")}</label>
        <input
          id="custom-workflow"
          value={workflow}
          placeholder={t("models.custom.workflowPlaceholder")}
          onChange={(event) => setWorkflow(event.target.value)}
        />
        {/* The workflows imported in Settings → Workflows, offered rather
            than imposed: the field also accepts a template packaged with
            the engine, which is not in this list, so a picker that
            REPLACED the input would remove a working option. Typing the
            name of a workflow you imported ten minutes ago from memory is
            the case this fixes. */}
        {importedWorkflows.length > 0 && (
          <div className="chip-row" role="group" aria-label={t("models.custom.workflowPickAria")}>
            {importedWorkflows.map((row) => (
              <button
                type="button"
                key={row.name}
                className={`chip${workflow === row.name ? " active" : ""}`}
                onClick={() => setWorkflow(workflow === row.name ? "" : row.name)}
              >
                {row.name}
              </button>
            ))}
          </div>
        )}
        <div className="hint" style={{ marginTop: 4 }}>
          {t("models.custom.workflowHint")}
        </div>
      </div>
      <div>
        <div className="license-note">{t("models.custom.licenseNote")}</div>
        <label className="consent" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            checked={acked}
            onChange={(event) => setAcked(event.target.checked)}
          />
          {t("models.custom.licenseAck")}
        </label>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="form-row">
        <button className="btn-primary" disabled={!canAdd} onClick={() => void submit()}>
          {saving ? t("models.custom.adding") : t("models.custom.add")}
        </button>
        <button className="btn-ghost" onClick={onDone}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

/** A pending destructive/interrupting act awaiting the user's confirmation. */
type PendingAction =
  | { kind: "delete"; row: ModelRow }
  | { kind: "discard"; row: ModelRow }
  | { kind: "cancel"; row: ModelRow };

/** Grouped model list shared by first-run and settings: license badge,
 * size, install state, live download progress with cancel, delete for
 * installed weights (confirmed — multi-GB re-downloads aren't free). */
export function ModelLibrary({
  selected,
  onToggle,
  showActions,
  filterIds,
  showAddCustom,
  recommendedIds,
  fitOf,
  hideUnfit,
}: ModelLibraryProps) {
  const {
    models,
    downloadErrors,
    refreshModels,
    startDownload,
    cancelDownload,
    deleteModel,
    deleteCustomModel,
  } = useApp();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [adding, setAdding] = useState(false);

  const anyDownloading = models.some((row) => row.downloading);
  useEffect(() => {
    if (!anyDownloading) return;
    const timer = setInterval(() => {
      refreshModels().catch((err) => console.warn("models poll failed:", err));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyDownloading, refreshModels]);

  let rows = filterIds ? models.filter((row) => filterIds.has(row.id)) : models;
  if (fitOf && hideUnfit) rows = rows.filter((row) => fitOf(row) !== "wont");
  if (rows.length === 0 && !showAddCustom) return <p className="hint">{t("models.empty")}</p>;

  // Group by task, preserving manifest order.
  const groups: [string, ModelRow[]][] = [];
  for (const row of rows) {
    const group = groups.find(([task]) => task === row.task);
    if (group) group[1].push(row);
    else groups.push([row.task, [row]]);
  }

  return (
    <div className="model-groups">
      {groups.map(([task, taskRows]) => (
        <div className="model-group" key={task}>
          <h3>{(m().models.taskLabels as Record<string, string>)[task] ?? task}</h3>
          {taskRows.map((row) => {
            const external = row.files.length === 0;
            const fraction =
              row.progress && row.progress.total > 0
                ? Math.min(1, row.progress.done / row.progress.total)
                : 0;
            const error = downloadErrors[row.id];
            const fit: Fit = fitOf ? fitOf(row) : "fits";
            const recommended = recommendedIds?.has(row.id) ?? false;
            return (
              <div
                className={`model-row${recommended ? " rec-row" : ""}${fit === "wont" ? " dis" : ""}`}
                key={row.id}
              >
                {onToggle && (
                  <input
                    type="checkbox"
                    checked={row.downloaded || (selected?.has(row.id) ?? false)}
                    disabled={row.downloaded || row.downloading || fit === "wont"}
                    onChange={() => onToggle(row.id)}
                    aria-label={t("models.selectAria", { id: row.id })}
                  />
                )}
                <div className="grow">
                  {/* human name leads; the raw id demotes to copyable mono
                      meta (review 4 §S8) */}
                  <div className="name">
                    {row.family ? displayModelName(row.family, row.version) : row.id}
                    {recommended && (
                      <span className="badge rec">{t("models.recommended")}</span>
                    )}
                  </div>
                  <div className="meta">
                    <span className="mono-id">{row.id}</span>
                    {/* the badge beside this row already says "external" —
                        the meta says what that MEANS, as the rail does */}
                    {" · " +
                      [
                        row.quant,
                        external ? externalNote(row.task) : formatSize(row.size_bytes),
                        t("models.needsVram", { vram: row.requirements.vram_gb }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                  </div>
                  {row.downloading && row.progress && (
                    <div
                      className="dl-bar"
                      role="progressbar"
                      aria-valuenow={Math.round(fraction * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div className="dl-bar-fill" style={{ width: `${fraction * 100}%` }} />
                    </div>
                  )}
                  {error && <div className="meta error-text">{error}</div>}
                </div>
                {fit === "tight" && (
                  <span className="badge warn" title={t("models.tightFitTitle")}>
                    {t("models.tightFit")}
                  </span>
                )}
                {fit === "wont" && (
                  <span className="badge warn">
                    {t("models.wontFit", { vram: row.requirements.vram_gb })}
                  </span>
                )}
                {row.custom ? (
                  <>
                    <span className="badge">{t("models.custom.tag")}</span>
                    <span className="badge warn" title={row.license.notes}>
                      ⚠ {t("models.custom.yourLicense")}
                    </span>
                  </>
                ) : (
                  <LicenseBadge license={row.license} />
                )}
                {external ? (
                  <span className="badge" title={t("models.externalTitle")}>
                    {t("models.external")}
                  </span>
                ) : row.downloaded ? (
                  <>
                    <span className="badge ok">{t("models.installed")}</span>
                    {showActions && (
                      <Tip
                        label={t("models.deleteFromDisk")}
                        hint={t("models.deleteFromDiskHint", { size: formatSize(row.size_bytes) })}
                      >
                        <button
                          className="btn-ghost"
                          onClick={() => setPending({ kind: "delete", row })}
                          aria-label={t("models.deleteAria", { id: row.id })}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </Tip>
                    )}
                  </>
                ) : row.downloading ? (
                  <>
                    <span className="badge">{Math.round(fraction * 100)}%</span>
                    <button className="btn-ghost" onClick={() => setPending({ kind: "cancel", row })}>
                      {t("common.cancel")}
                    </button>
                  </>
                ) : showActions ? (
                  <>
                    <button className="btn-ghost" onClick={() => void startDownload(row.id)}>
                      {error
                        ? t("common.retry")
                        : row.partial_bytes > 0 && row.size_bytes > 0
                          ? t("models.resumePct", {
                              pct: Math.min(
                                99,
                                Math.round((row.partial_bytes / row.size_bytes) * 100),
                              ),
                            })
                          : t("common.download")}
                    </button>
                    {row.partial_bytes > 0 && (
                      <Tip
                        label={t("models.discardPartial")}
                        hint={t("models.discardPartialHint", { size: formatSize(row.partial_bytes) })}
                      >
                        <button
                          className="btn-ghost"
                          onClick={() => setPending({ kind: "discard", row })}
                          aria-label={t("models.discardAria", { id: row.id })}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </Tip>
                    )}
                    {row.custom && row.partial_bytes === 0 && (
                      <Tip label={t("models.custom.removeEntry")}>
                        <button
                          className="btn-ghost"
                          onClick={() => setPending({ kind: "delete", row })}
                          aria-label={t("models.deleteAria", { id: row.id })}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </Tip>
                    )}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
      {showAddCustom &&
        (adding ? (
          <AddCustomModel onDone={() => setAdding(false)} />
        ) : (
          <button
            className="btn-ghost"
            style={{ marginTop: 10, display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => setAdding(true)}
          >
            <Plus size={13} strokeWidth={2} aria-hidden="true" />
            {t("models.custom.addEntry")}
          </button>
        ))}
      {pending?.kind === "delete" && (
        <ConfirmDialog
          title={t("models.deleteTitle", { id: pending.row.id })}
          message={
            pending.row.custom
              ? t("models.custom.deleteMessage")
              : t("models.deleteMessage", { size: formatSize(pending.row.size_bytes) })
          }
          confirmLabel={t("models.deleteConfirm", { size: formatSize(pending.row.size_bytes) })}
          danger
          onConfirm={() => {
            // Custom entries also leave the register, not just the disk.
            if (pending.row.custom) void deleteCustomModel(pending.row.id);
            else void deleteModel(pending.row.id);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === "discard" && (
        <ConfirmDialog
          title={t("models.discardTitle", { id: pending.row.id })}
          message={t("models.discardMessage", { size: formatSize(pending.row.partial_bytes) })}
          confirmLabel={t("models.discardConfirm")}
          danger
          onConfirm={() => {
            void deleteModel(pending.row.id);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === "cancel" && (
        <ConfirmDialog
          title={t("models.pauseTitle", { id: pending.row.id })}
          message={t("models.pauseMessage")}
          confirmLabel={t("models.pauseConfirm")}
          onConfirm={() => {
            void cancelDownload(pending.row.id);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
