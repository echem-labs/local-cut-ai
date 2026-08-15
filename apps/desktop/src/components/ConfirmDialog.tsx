import { useRef } from "react";
import { t } from "../i18n";
import { Modal } from "./Modal";

/** Modal confirmation — reserved for genuinely destructive acts (doc 09).
 * Escape cancels, the safe action holds initial focus, clicking the
 * backdrop cancels, and Tab cycles within the dialog (all in `Modal`). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  victim,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  /** Defaults to "Cancel". `common.keepIt` reads correctly against a
   * delete and oddly against everything else ("Keep it" answering "Discard
   * this download?"), so the caller that means it says so. */
  cancelLabel?: string;
  danger?: boolean;
  /** The thing being destroyed, put on screen as evidence: a dialog that
   * names it in prose asks you to trust that the right one is selected,
   * where a row showing its name and a distinguishing readout lets you
   * check. */
  victim?: { name: string; detail?: string };
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      title={title}
      role="alertdialog"
      onClose={onCancel}
      initialFocus={cancelRef}
      footer={
        <>
          <button className="btn-ghost" ref={cancelRef} onClick={onCancel}>
            {cancelLabel ?? t("common.cancel")}
          </button>
          <button className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
      {victim && (
        <div className={`well confirm-victim${danger ? " edge-fail" : ""}`}>
          <div className="prow">
            <span className="pname">{victim.name}</span>
            {victim.detail && <span className="price readout">{victim.detail}</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}
