import { Boxes } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { m, t } from "../i18n";
import { useMenuFit } from "../lib/useMenuFit";
import { useApp } from "../store";
import { displayModelName } from "./ModelLibrary";
import { Tip } from "./Tooltip";

/** Model-readiness popover: per-task resolved model (or a not-installed
 * badge) with "Manage models" as the only action. Shared by Home's prompt
 * box and the project composer — `opens` flips the unfold direction so
 * the bottom-docked composer isn't clipped by the panel edge.
 *
 * Sourced from the engine's readiness report — the same resolution the
 * scheduler performs — rather than re-deriving install state from the
 * recommendation slate, which could disagree with what actually renders
 * (a stored default, a custom model, a live-flipped capability). The slate
 * stays as the fallback for an engine too old to serve /readiness. */
export function ModelsPopover({ opens = "down" }: { opens?: "up" | "down" }) {
  const { system, models, readiness, openSettings } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fit = useMenuFit();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const taskLabels = m().models.taskLabels as Record<string, string>;
  // One row per task — keyframe and thumbnail share image.gen and always
  // resolve alike, so the first of them speaks for both.
  const seen = new Set<string>();
  const lines = (readiness ?? []).flatMap((row) => {
    const task = String(row.data.task ?? "");
    if (!task || seen.has(task)) return [];
    seen.add(task);
    const entry = row.model ? models.find((candidate) => candidate.id === row.model) : null;
    return [
      {
        task,
        label: taskLabels[task] ?? task,
        // The still-clip tier and mock placeholders both read as "not
        // installed": this surface answers "what will render this", and
        // for either the honest answer is "not a model you chose".
        name:
          row.verdict === "ready"
            ? (entry ? displayModelName(entry.family, entry.version) : row.model)
            : null,
      },
    ];
  });
  const fallback = (system?.recommendations ?? []).map((rec) => {
    const row = rec.model ? models.find((entry) => entry.id === rec.model?.id) : null;
    const ready = row?.downloaded || (rec.model?.files.length ?? 1) === 0;
    return {
      task: rec.task,
      label: taskLabels[rec.task] ?? rec.task,
      name: rec.model && ready ? displayModelName(rec.model.family, rec.model.version) : null,
    };
  });

  return (
    <div className={`models-pop-wrap${opens === "up" ? " opens-up" : ""}`} ref={ref}>
      <Tip label={t("home.modelsTipLabel")} hint={t("home.modelsTipHint")} side="top">
        <button
          className="icon-btn"
          onClick={() => setOpen(!open)}
          aria-label={t("home.modelsAria")}
          aria-expanded={open}
        >
          <Boxes size={15} strokeWidth={1.8} />
        </button>
      </Tip>
      {open && (
        <div className="menu-pop" role="menu" ref={fit}>
          <div className="menu-label">{t("home.modelsPopTitle")}</div>
          {(lines.length > 0 ? lines : fallback).map((line) => (
            <div key={line.task} className="models-pop-row">
              <span className="grow">{line.label}</span>
              {line.name ? (
                <small>{line.name}</small>
              ) : (
                <span className="badge warn">{t("home.notInstalled")}</span>
              )}
            </div>
          ))}
          <div className="rule" aria-hidden="true" />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openSettings("models");
            }}
          >
            {t("home.manageModels")}
          </button>
        </div>
      )}
    </div>
  );
}
