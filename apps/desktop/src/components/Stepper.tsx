import { t } from "../i18n";

/**
 * The wizard's progress header: uppercase step labels joined by short
 * connector bars. Structural teaching, not chrome — the header itself
 * says how long setup is and where you are in it, which is what lets
 * every step drop the "step 2 of 4" sentence.
 *
 * Connectors before the current step read done (accent); the current
 * label lifts one text tier, no more — the wizard's one gradient stays
 * reserved for the primary button.
 */
export function Stepper({ labels, current }: { labels: string[]; current: number }) {
  return (
    <div
      className="stepper"
      role="group"
      aria-label={t("firstRun.stepperAria", { step: current + 1, total: labels.length })}
    >
      {labels.map((label, index) => (
        // A connector belongs to the gap BEFORE its label, hence index > 0.
        <span className="step-slot" key={label}>
          {index > 0 && <i className={index <= current ? "done" : ""} aria-hidden="true" />}
          <span className={`step-label${index === current ? " cur" : ""}`}>{label}</span>
        </span>
      ))}
    </div>
  );
}
