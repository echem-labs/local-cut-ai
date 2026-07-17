import { useEffect, useMemo, useState } from "react";
import { formatSize, LicenseBadge, ModelLibrary, TASK_LABELS } from "../components/ModelLibrary";
import { useApp } from "../store";

/** First launch: hardware verdict plus a pre-picked model slate. One
 * screen, one decision — download the slate or skip; Customize is the
 * escape hatch. Downloads run server-side, so Continue never blocks. */
export function FirstRun() {
  const { client, system, models, refreshModels, startDownload, finishFirstRun } = useApp();
  const [customize, setCustomize] = useState(false);
  // null until seeded from the recommendations — not an empty selection.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (client) refreshModels().catch((err) => console.warn("models refresh failed:", err));
  }, [client, refreshModels]);

  const rowById = useMemo(() => new Map(models.map((row) => [row.id, row])), [models]);

  // Seed the selection once: the recommended slate + anything installed.
  useEffect(() => {
    if (selected || !system || models.length === 0) return;
    const ids = new Set<string>();
    for (const rec of system.recommendations) if (rec.model) ids.add(rec.model.id);
    for (const row of models) if (row.downloaded) ids.add(row.id);
    setSelected(ids);
  }, [selected, system, models]);

  const picked = selected ?? new Set<string>();
  const downloadable = models.filter((row) => picked.has(row.id) && row.files.length > 0);
  const pending = downloadable.filter((row) => !row.downloaded);
  const totalBytes = pending.reduce((sum, row) => sum + row.size_bytes, 0);

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const beginDownloads = () => {
    if (pending.length === 0) {
      finishFirstRun();
      return;
    }
    setCustomize(false);
    setStarted(true);
    for (const row of pending) {
      if (!row.downloading) void startDownload(row.id);
    }
  };

  const gpu = system?.hardware.primary_gpu ?? system?.hardware.gpus[0] ?? null;

  if (started) {
    return (
      <div className="setup">
        <h1>Downloading models…</h1>
        <p className="sub">
          Downloads keep running in the background — you can start creating right away.
        </p>
        <ModelLibrary showActions filterIds={new Set(downloadable.map((row) => row.id))} />
        <div className="setup-actions">
          <button className="btn-primary" onClick={finishFirstRun}>
            Continue to app
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      {system ? (
        <>
          <h1>Your machine: Tier {system.hardware.tier}</h1>
          <p className="sub">
            {gpu ? `${gpu.name} · ${gpu.vram_gb} GB VRAM` : "No GPU detected"} ·{" "}
            {system.hardware.ram_gb} GB RAM · {system.hardware.disk_free_gb} GB free disk
          </p>
        </>
      ) : (
        <>
          <h1>Checking your machine…</h1>
          <p className="sub">Probing hardware and picking the best local models.</p>
        </>
      )}

      {system &&
        (customize ? (
          <ModelLibrary selected={picked} onToggle={toggle} />
        ) : (
          <div className="model-groups">
            <div className="model-group">
              <h3>Recommended for your hardware</h3>
              {system.recommendations.map((rec) => {
                const row = rec.model ? rowById.get(rec.model.id) : undefined;
                const external = rec.model ? (row ?? rec.model).files.length === 0 : false;
                const size =
                  row?.size_bytes ?? rec.model?.files.reduce((sum, f) => sum + f.size, 0) ?? 0;
                return (
                  <div className="model-row" key={rec.task}>
                    <div className="grow">
                      <div className="name">
                        {TASK_LABELS[rec.task] ?? rec.task}
                        {rec.model && ` — ${rec.model.id}`}
                      </div>
                      <div className="meta">
                        {rec.model && !external && `${formatSize(size)} · `}
                        {rec.reason}
                      </div>
                    </div>
                    {rec.model && <LicenseBadge license={rec.model.license} />}
                    {external && (
                      <span
                        className="badge"
                        title="Served outside the engine (e.g. Ollama) — nothing to download"
                      >
                        external
                      </span>
                    )}
                    {row?.downloaded && <span className="badge ok">installed</span>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

      {system && pending.length > 0 && (
        <p className="hint" style={{ marginTop: "var(--space-3)" }}>
          {pending.length} download{pending.length === 1 ? "" : "s"} ·{" "}
          {formatSize(totalBytes)} total
        </p>
      )}

      <div className="setup-actions">
        <button
          className="btn-primary"
          onClick={beginDownloads}
          disabled={!system || models.length === 0}
        >
          {pending.length > 0 ? `Download & continue (${formatSize(totalBytes)})` : "Continue"}
        </button>
        <button
          className={`btn-ghost${customize ? " active" : ""}`}
          onClick={() => setCustomize(!customize)}
        >
          Customize
        </button>
        <button className="btn-ghost" onClick={finishFirstRun}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
