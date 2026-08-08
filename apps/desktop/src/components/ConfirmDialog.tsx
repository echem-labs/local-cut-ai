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
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
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
            {t("common.keepIt")}
          </button>
          <button className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}
