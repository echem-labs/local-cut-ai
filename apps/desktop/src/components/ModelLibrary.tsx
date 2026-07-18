import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModelLicense, ModelRow } from "../api/types";
import { useApp } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { Tip } from "./Tooltip";

export const TASK_LABELS: Record<string, string> = {
  "text.llm": "Script writing",
  "image.gen": "Keyframes",
  "video.i2v": "Video clips",
  "video.t2v": "Video clips (text-to-video)",
  "speech.tts": "Narration",
  "music.gen": "Music",
  transcribe: "Captions",
};

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

const VERDICTS: Record<ModelLicense["verdict"], { glyph: string; label: string; cls: string }> = {
  commercial: { glyph: "✓", label: "commercial-safe", cls: "ok" },
  conditions: { glyph: "⚠", label: "conditions", cls: "warn" },
  "personal-only": { glyph: "✗", label: "personal only", cls: "bad" },
};

export function LicenseBadge({ license }: { license: ModelLicense }) {
  const verdict = VERDICTS[license.verdict] ?? VERDICTS.conditions;
  return (
    <span className={`badge ${verdict.cls}`} title={license.notes || license.id}>
      {verdict.glyph} {verdict.label}
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
}

/** A pending destructive/interrupting act awaiting the user's confirmation. */
type PendingAction =
  | { kind: "delete"; row: ModelRow }
  | { kind: "discard"; row: ModelRow }
  | { kind: "cancel"; row: ModelRow };

/** Grouped model list shared by first-run and settings: license badge,
 * size, install state, live download progress with cancel, delete for
 * installed weights (confirmed — multi-GB re-downloads aren't free). */
export function ModelLibrary({ selected, onToggle, showActions, filterIds }: ModelLibraryProps) {
  const { models, downloadErrors, refreshModels, startDownload, cancelDownload, deleteModel } =
    useApp();
  const [pending, setPending] = useState<PendingAction | null>(null);

  const anyDownloading = models.some((row) => row.downloading);
  useEffect(() => {
    if (!anyDownloading) return;
    const timer = setInterval(() => {
      refreshModels().catch((err) => console.warn("models poll failed:", err));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyDownloading, refreshModels]);

  const rows = filterIds ? models.filter((row) => filterIds.has(row.id)) : models;
  if (rows.length === 0) return <p className="hint">No models in the manifest yet.</p>;

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
          <h3>{TASK_LABELS[task] ?? task}</h3>
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
                    aria-label={`Select ${row.id}`}
                  />
                )}
                <div className="grow">
                  <div className="name">{row.id}</div>
                  <div className="meta">
                    {[
                      `${row.family}${row.version ? ` ${row.version}` : ""}`,
                      row.quant,
                      external ? "external" : formatSize(row.size_bytes),
                      `needs ${row.requirements.vram_gb} GB VRAM`,
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
                <LicenseBadge license={row.license} />
                {external ? (
                  <span
                    className="badge"
                    title="Served outside the engine (e.g. Ollama) — nothing to download"
                  >
                    external
                  </span>
                ) : row.downloaded ? (
                  <>
                    <span className="badge ok">installed</span>
                    {showActions && (
                      <Tip label="Delete from disk" hint={`frees ${formatSize(row.size_bytes)}`}>
                        <button
                          className="btn-ghost"
                          onClick={() => setPending({ kind: "delete", row })}
                          aria-label={`Delete ${row.id} from disk`}
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
                      Cancel
                    </button>
                  </>
                ) : showActions ? (
                  <>
                    <button className="btn-ghost" onClick={() => void startDownload(row.id)}>
                      {error
                        ? "Retry"
                        : row.partial_bytes > 0 && row.size_bytes > 0
                          ? `Resume · ${Math.min(
                              99,
                              Math.round((row.partial_bytes / row.size_bytes) * 100),
                            )}%`
                          : "Download"}
                    </button>
                    {row.partial_bytes > 0 && (
                      <Tip
                        label="Discard partial download"
                        hint={`throws away ${formatSize(row.partial_bytes)}`}
                      >
                        <button
                          className="btn-ghost"
                          onClick={() => setPending({ kind: "discard", row })}
                          aria-label={`Discard partial download of ${row.id}`}
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
      {pending?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${pending.row.id}?`}
          message={`Removes ${formatSize(pending.row.size_bytes)} from disk. Jobs that need it will fail until it's downloaded again — the download is always available here.`}
          confirmLabel={`Delete (${formatSize(pending.row.size_bytes)})`}
          danger
          onConfirm={() => {
            void deleteModel(pending.row.id);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === "discard" && (
        <ConfirmDialog
          title={`Discard partial download of ${pending.row.id}?`}
          message={`Throws away the ${formatSize(pending.row.partial_bytes)} downloaded so far. A later download starts from zero instead of resuming.`}
          confirmLabel="Discard"
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
          title={`Pause downloading ${pending.row.id}?`}
          message="Nothing is lost — the downloaded part stays on disk and Resume picks up exactly where it stopped."
          confirmLabel="Pause download"
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
