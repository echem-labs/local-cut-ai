import { Boxes } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { m, t } from "../i18n";
import { useMenuFit } from "../lib/useMenuFit";
import { useApp } from "../store";
import { displayModelName } from "./ModelLibrary";
import { Tip } from "./Tooltip";

/** Model-readiness popover: per-task installed model (or a not-installed
 * badge) with "Manage models" as the only action. Shared by Home's prompt
 * box and the project composer — `opens` flips the unfold direction so
 * the bottom-docked composer isn't clipped by the panel edge. */
export function ModelsPopover({ opens = "down" }: { opens?: "up" | "down" }) {
  const { system, models, openSettings } = useApp();
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
          {(system?.recommendations ?? []).map((rec) => {
            const row = rec.model ? models.find((entry) => entry.id === rec.model?.id) : null;
            const ready = row?.downloaded || (rec.model?.files.length ?? 1) === 0;
            return (
              <div key={rec.task} className="models-pop-row">
                <span className="grow">
                  {(m().models.taskLabels as Record<string, string>)[rec.task] ?? rec.task}
                </span>
                {rec.model ? (
                  ready ? (
                    <small>{displayModelName(rec.model.family, rec.model.version)}</small>
                  ) : (
                    <span className="badge warn">{t("home.notInstalled")}</span>
                  )
                ) : (
                  <small>{t("home.cloudOnly")}</small>
                )}
              </div>
            );
          })}
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
