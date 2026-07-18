import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModelLicense, ModelRow } from "../api/types";
import { m, t } from "../i18n";
import { useApp } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dropdown } from "./Dropdown";
import { Tip } from "./Tooltip";

// Safety net when the WS is down or a terminal event was missed; WS
// progress events (~0.5s) drive the bars in between.
const POLL_MS = 4000;

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 GB";
  const gb = bytes / 2 ** 30;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 2 ** 20))} MB`;
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
                  : t("models.custom.filePlaceholder")
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

  const rows = filterIds ? models.filter((row) => filterIds.has(row.id)) : models;
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
            return (
              <div className="model-row" key={row.id}>
                {onToggle && (
                  <input
                    type="checkbox"
                    checked={row.downloaded || (selected?.has(row.id) ?? false)}
                    disabled={row.downloaded || row.downloading}
                    onChange={() => onToggle(row.id)}
                    aria-label={t("models.selectAria", { id: row.id })}
                  />
                )}
                <div className="grow">
                  {/* human name leads; the raw id demotes to copyable mono
                      meta (review 4 §S8) */}
                  <div className="name">
                    {row.family ? displayModelName(row.family, row.version) : row.id}
                  </div>
                  <div className="meta">
                    <span className="mono-id">{row.id}</span>
                    {" · " +
                      [
                        row.quant,
                        external ? t("models.external") : formatSize(row.size_bytes),
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
