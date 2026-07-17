import { useEffect } from "react";
import type { ModelLicense, ModelRow } from "../api/types";
import { useApp } from "../store";

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

/** Grouped model list shared by first-run and settings: license badge,
 * size, install state, live download progress with cancel. */
export function ModelLibrary({ selected, onToggle, showActions, filterIds }: ModelLibraryProps) {
  const { models, downloadErrors, refreshModels, startDownload, cancelDownload } = useApp();

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
                  <span className="badge ok">installed</span>
                ) : row.downloading ? (
                  <>
                    <span className="badge">{Math.round(fraction * 100)}%</span>
                    <button className="btn-ghost" onClick={() => void cancelDownload(row.id)}>
                      Cancel
                    </button>
                  </>
                ) : showActions ? (
                  <button className="btn-ghost" onClick={() => void startDownload(row.id)}>
                    {error ? "Retry" : "Download"}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
