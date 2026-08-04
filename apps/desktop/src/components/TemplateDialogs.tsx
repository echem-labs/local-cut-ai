import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { Project } from "../api/types";
import { plural, t } from "../i18n";
import { relativeTime } from "../lib/time";
import { useApp } from "../store";
import { Modal } from "./Modal";

/**
 * The two ends of a template: naming one from a finished project, and
 * starting a video from one that was saved. Both are small modal forms
 * rather than inline affordances — each one asks a single question and the
 * engine call behind it creates or exports a whole document.
 */
export function SaveTemplateDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const saveTemplate = useApp((state) => state.saveTemplate);
  const [name, setName] = useState(project.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const message = await saveTemplate(project.id, trimmed);
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };

  return (
    <Modal label={t("library.saveTemplateTitle", { title: project.title })} onClose={onClose} initialFocus={nameRef}>
      <h2>{t("library.saveTemplateTitle", { title: project.title })}</h2>
      <p className="sub">{t("library.saveTemplateMessage")}</p>
      <label className="field">
        <span>{t("library.saveTemplateName")}</span>
        <input
          ref={nameRef}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
            if (event.key === "Escape") onClose();
          }}
        />
      </label>
      {error && (
        <p className="hint error-text" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn-primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
          {t("library.saveTemplateConfirm")}
        </button>
      </div>
    </Modal>
  );
}

export function StartFromTemplateDialog({ onClose }: { onClose: () => void }) {
  const { templates, startFromTemplate, deleteTemplate } = useApp();
  const [picked, setPicked] = useState<string | null>(templates[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!picked || busy) return;
    setBusy(true);
    const message = await startFromTemplate(picked);
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };

  return (
    <Modal label={t("library.startTemplateTitle")} onClose={onClose} className="template-modal">
      <h2>{t("library.startTemplateTitle")}</h2>
      {templates.length === 0 ? (
        <p className="sub">{t("library.startTemplateEmpty")}</p>
      ) : (
        <div className="template-list" role="radiogroup" aria-label={t("library.startTemplateTitle")}>
          {templates.map((entry) => (
            <div className={`template-row${picked === entry.id ? " on" : ""}`} key={entry.id}>
              <label>
                <input
                  type="radio"
                  name="template"
                  checked={picked === entry.id}
                  onChange={() => setPicked(entry.id)}
                />
                <span className="grow">
                  <span className="name">{entry.name}</span>
                  <span className="meta">
                    {t("library.templateSavedAt", { when: relativeTime(entry.savedAt) })}
                  </span>
                </span>
              </label>
              <button
                className="icon-btn-sm"
                aria-label={t("library.deleteTemplateAria", { name: entry.name })}
                title={t("library.deleteTemplate")}
                onClick={() => {
                  deleteTemplate(entry.id);
                  if (picked === entry.id) setPicked(null);
                }}
              >
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="hint error-text" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn-primary" disabled={!picked || busy} onClick={() => void create()}>
          {t("library.startTemplateConfirm")}
        </button>
      </div>
    </Modal>
  );
}

/**
 * What the last import will spend and what it left behind. The engine
 * surfaces both and blocks on neither, so this is a notice above the
 * project — never a gate in front of it.
 */
export function TemplateNotice() {
  const { templateNotice, dismissTemplateNotice } = useApp();
  if (!templateNotice) return null;
  const { cloudModels, droppedAssets } = templateNotice;
  return (
    <div className="banner warn template-notice" role="status">
      <span className="grow">
        {cloudModels.length > 0 &&
          plural("library.noticeCloud", cloudModels.length, { models: cloudModels.join(", ") })}
        {cloudModels.length > 0 && droppedAssets > 0 && " "}
        {droppedAssets > 0 && plural("library.noticeDropped", droppedAssets)}
      </span>
      <button className="btn-ghost" onClick={dismissTemplateNotice}>
        {t("common.dismiss")}
      </button>
    </div>
  );
}
