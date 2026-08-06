import { AlertTriangle, X } from "lucide-react";

import { t } from "../i18n";

/**
 * A refusal the user needs to read, in the place the action was taken.
 *
 * Extracted because these had been a bare red paragraph — the engine's whole
 * sentence, in `--status-failed`, running the width of the page. Long red
 * prose reads as breakage rather than as an answer, and it is the answer:
 * every message that reaches here names a thing and says what happened to
 * it. So the colour retreats to a mark and a rule, the text goes back to
 * ordinary body colour, and the box says "notice" instead of shouting.
 *
 * `role="alert"` deliberately: this appears in response to something the
 * user just did, which is exactly what an assertive live region is for.
 */
export function Alert({
  message,
  onDismiss,
}: {
  message: string;
  /** Omit for a message that is only true while the state behind it is. */
  onDismiss?: () => void;
}) {
  return (
    <div className="alert" role="alert">
      <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
      <p>{message}</p>
      {onDismiss && (
        <button
          type="button"
          className="alert-close"
          aria-label={t("common.dismiss")}
          onClick={onDismiss}
        >
          <X size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
