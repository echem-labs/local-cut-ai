import { CircleCheck, HardDriveDownload } from "lucide-react";
import { useState } from "react";

import { m, t, type MessageKey } from "../i18n";
import { useApp, type ProgramSetup } from "../store";
import { formatSize } from "./ModelLibrary";
import { Tip } from "./Tooltip";

/** A program's name in the app's words ("FFmpeg", not the wire id). The id
 * itself for a program this build has no entry for, which a newer engine
 * can offer to set up. */
export function programName(programId: string): string {
  const names = m().readiness.programs.names as Record<string, string>;
  return names[programId] ?? programId;
}

/** What a running setup is doing, as a phrase. A phase this build has no
 * words for reads as a plain "Setting up", never as the raw code. */
function phrase(setup: Extract<ProgramSetup, { status: "running" }>, name: string): string {
  if (setup.phase === null) return t("readiness.programs.starting", { program: name });
  const phases = m().readiness.programs.phases as Record<string, string>;
  return typeof phases[setup.phase] === "string"
    ? t(`readiness.programs.phases.${setup.phase}` as MessageKey, { program: name })
    : t("readiness.programs.working", { program: name });
}

/** Why a setup failed, from its reason code. The engine's `error` is the
 * same failure in English for logs and the CLI, and it names hashes and
 * byte counts; the code is what this sentence is made from. */
function failure(setup: Extract<ProgramSetup, { status: "failed" }>, name: string): string {
  const reasons = m().readiness.programs.reasons as Record<string, string>;
  return typeof reasons[setup.reason] === "string"
    ? t("readiness.programs.failed", {
        program: name,
        reason: t(`readiness.programs.reasons.${setup.reason}` as MessageKey),
      })
    : t("readiness.programs.failedPlain", { program: name });
}

/**
 * Setting up LocalCut's own copy of a program, wherever a readiness row's
 * fix is `setup_program`: the offer, then the setup as /ws reports it, then
 * how it ended. One control for the banner and the gate, so the two cannot
 * come to disagree about what a setup is doing.
 *
 * The numbers that move (bytes, speed) are hidden from assistive tech, and
 * the progressbar's value carries them instead. The banner is a live region,
 * and text that changes twice a second there is read out twice a second;
 * the phase changes five times in a whole setup, which is worth hearing.
 */
export function ProgramSetupControl({
  program,
  sizeBytes,
}: {
  program: string;
  /** The download, as the readiness fix gives it. */
  sizeBytes: number;
}) {
  const setup = useApp((state) => state.programSetups[program]);
  const startProgramSetup = useApp((state) => state.startProgramSetup);
  const cancelProgramSetup = useApp((state) => state.cancelProgramSetup);
  // What the engine said when it would not start or stop one (a 409 or a
  // 507). A failure the setup itself reports is `setup`, not this.
  const [refusal, setRefusal] = useState<string | null>(null);
  const name = programName(program);

  const start = async () => {
    setRefusal(null);
    setRefusal(await startProgramSetup(program));
  };
  const cancel = async () => {
    setRefusal(null);
    setRefusal(await cancelProgramSetup(program));
  };

  const refused = refusal && <span className="error-text">{refusal}</span>;

  if (setup?.status === "running") {
    const fraction = setup.total > 0 ? Math.min(1, setup.done / setup.total) : null;
    return (
      <span className="program-setup">
        <span>{phrase(setup, name)}</span>
        {setup.total > 0 && setup.done < setup.total && (
          <span className="readout" aria-hidden="true">
            {t("readiness.programs.bytes", {
              done: formatSize(setup.done),
              total: formatSize(setup.total),
            })}
          </span>
        )}
        {setup.bytesPerS !== null && (
          <span className="readout" aria-hidden="true">
            {t("readiness.programs.rate", { size: formatSize(setup.bytesPerS) })}
          </span>
        )}
        {fraction !== null && (
          <span
            className="dl-bar"
            role="progressbar"
            aria-label={t("readiness.programs.progress", { program: name })}
            aria-valuenow={Math.round(fraction * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className="dl-bar-fill" style={{ width: `${fraction * 100}%` }} />
          </span>
        )}
        <Tip label={t("readiness.programs.cancel")} hint={t("readiness.programs.cancelTipHint")}>
          <button className="btn-ghost" onClick={() => void cancel()}>
            {t("readiness.programs.cancel")}
          </button>
        </Tip>
        {refused}
      </span>
    );
  }

  if (setup?.status === "done") {
    return (
      <span className="program-setup done">
        <CircleCheck size={14} strokeWidth={1.8} aria-hidden="true" />
        <span>
          {setup.version
            ? t("readiness.programs.done", { program: name, version: setup.version })
            : t("readiness.programs.donePlain", { program: name })}
        </span>
      </span>
    );
  }

  const failed = setup?.status === "failed";
  return (
    <span className="program-setup">
      {failed && <span className="error-text">{failure(setup, name)}</span>}
      {refused}
      <Tip
        label={t("readiness.programs.setupTip", { program: name })}
        hint={t("readiness.programs.setupTipHint")}
      >
        <button className="btn-outline" onClick={() => void start()}>
          <HardDriveDownload size={14} strokeWidth={1.8} aria-hidden="true" />
          {failed ? t("readiness.programs.retry") : t("readiness.programs.setup", { program: name })}
          {!failed && sizeBytes > 0 && <span className="readout">{formatSize(sizeBytes)}</span>}
        </button>
      </Tip>
    </span>
  );
}
