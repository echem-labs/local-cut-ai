import {
  Check,
  ChevronRight,
  CircleCheck,
  Clapperboard,
  Copy,
  ExternalLink,
  Image,
  Mic,
  RefreshCw,
  ScrollText,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProgramId, ProgramInfo, ProgramsReport, ReadinessRow } from "../api/types";
import { t, type MessageKey } from "../i18n";
import {
  binDirOf,
  manualSteps,
  needsAttention,
  osOf,
  PROGRAM_SITES,
  programName,
  rowsCostBy,
  setupEta,
  setupFraction,
  setupOffer,
  shownFailure,
  statusOf,
  type ManualText,
} from "../lib/programs";
import { useMenuFit } from "../lib/useMenuFit";
import { useOutsideClick } from "../lib/useOutsideClick";
import { useApp } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { formatSize } from "./ModelLibrary";
import { GapRows } from "./Readiness";
import { Tip } from "./Tooltip";

const ICON: Record<ProgramId, LucideIcon> = {
  ffmpeg: Clapperboard,
  ollama: ScrollText,
  comfyui: Image,
};

/** A sentence with its paths, variables and commands set in mono. */
export function WithCode({ text, code }: ManualText): ReactNode {
  const parts = [...new Set((code ?? []).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (parts.length === 0) return text;
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pieces = text.split(new RegExp(`(${parts.map(escape).join("|")})`));
  return pieces.map((piece, index) =>
    parts.includes(piece) ? (
      <span className="readout" key={index}>
        {piece}
      </span>
    ) : (
      piece
    ),
  );
}

/** A command or a file to copy, with the button that copies it. */
function Copyable({ text, block = false }: { text: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className={`pw-cmd${block ? " block" : ""}`}>
      {block ? <pre className="t">{text}</pre> : <code className="t">{text}</code>}
      <Tip label={t("programs.diy.copyTip")} hint={t("programs.diy.copyTipHint")}>
        <button
          className="icon-btn-sm"
          aria-label={t("programs.diy.copyAria", { text: block ? "extra_model_paths.yaml" : text })}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(text)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {copied ? (
            <Check size={14} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
      </Tip>
      {/* Said, not only drawn: the tick is the only other sign it worked. */}
      <span className="sr-only" role="status">
        {copied ? t("programs.diy.copied") : ""}
      </span>
    </div>
  );
}

/** Look again: the programs and the readiness verdicts they decide. */
export function useCheckAgain(): { busy: boolean; run: () => void } {
  const refreshPrograms = useApp((state) => state.refreshPrograms);
  const refreshReadiness = useApp((state) => state.refreshReadiness);
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (busy) return;
    setBusy(true);
    void Promise.all([
      refreshPrograms(),
      refreshReadiness().catch((err) => console.warn("readiness refresh failed:", err)),
    ]).finally(() => setBusy(false));
  };
  return { busy, run };
}

function CheckAgain({ name }: { name: string }) {
  const { busy, run } = useCheckAgain();
  return (
    <Tip label={t("programs.diy.checkTip", { name })} hint={t("programs.diy.checkTipHint")}>
      <button className="btn-ghost sm" disabled={busy} onClick={run}>
        <RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" className={busy ? "spin" : ""} />
        {busy ? t("programs.diy.checking") : t("programs.diy.check")}
      </button>
    </Tip>
  );
}

/** The steps for doing it by hand, written for the engine's own system. */
function ManualSetup({
  program,
  report,
  host,
  open,
}: {
  program: ProgramInfo;
  report: ProgramsReport;
  host: string | null;
  open: boolean;
}) {
  const system = useApp((state) => state.system);
  const gpu = system?.hardware.primary_gpu ?? system?.hardware.gpus[0] ?? null;
  const { steps, notes } = manualSteps(program, {
    os: osOf(report.platform),
    host,
    binDir: binDirOf(report),
    modelsDir: report.models_dir ?? null,
    gpuVendor: gpu?.vendor ?? null,
  });
  const name = programName(program.id);
  return (
    <details className="pw-diy" open={open}>
      <summary>
        <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
        {host ? t("programs.diy.summaryOn", { host }) : t("programs.diy.summary")}
      </summary>
      <ol>
        {steps.map((step) => (
          <li key={step.text}>
            <WithCode text={step.text} code={step.code} />
            {step.link && (
              <>
                {" "}
                <Tip label={step.link.label} hint={t("programs.diy.openTip")}>
                  <a className="link-out" href={step.link.href} target="_blank" rel="noreferrer">
                    {step.link.label}
                    <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
                  </a>
                </Tip>
              </>
            )}
            {step.command && <Copyable text={step.command} />}
            {step.block && <Copyable text={step.block} block />}
            {step.check && (
              <div className="pw-step-action">
                <CheckAgain name={name} />
              </div>
            )}
          </li>
        ))}
      </ol>
      {notes.map((note) => (
        <p className="pw-alt" key={note.text}>
          <WithCode text={note.text} code={note.code} />
        </p>
      ))}
    </details>
  );
}

/** The gear menu Settings puts on a well: the program's site, LocalCut's
 * own copy, and the screens that are the other way round a missing one. */
function ProgramMenu({ program, onRemove }: { program: ProgramInfo; onRemove: () => void }) {
  const openSettings = useApp((state) => state.openSettings);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const fit = useMenuFit();
  const name = programName(program.id);
  useOutsideClick(wrap, open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    // Capture phase, and stopped: Settings closes on Escape too, and the
    // key that closes a menu must not close the screen under it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const canRemove = program.managed !== null && !program.setup.job;
  return (
    <div className="pw-menu" ref={wrap}>
      <Tip label={t("programs.menu.tip", { name })} hint={t("programs.menu.tipHint")}>
        <button
          ref={trigger}
          className={`icon-btn-sm pw-gear${open ? " active" : ""}`}
          aria-label={t("programs.menu.aria", { name })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <SettingsIcon size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </Tip>
      {open && (
        <div className="menu-pop" role="menu" ref={fit}>
          <a
            role="menuitem"
            href={PROGRAM_SITES[program.id]}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            {t("programs.menu.site", { name })}
          </a>
          {program.id === "ollama" && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openSettings("providers");
              }}
            >
              {t("programs.menu.cloud")}
            </button>
          )}
          {program.id === "comfyui" && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openSettings("workflows");
              }}
            >
              {t("programs.menu.workflows")}
            </button>
          )}
          {canRemove && (
            <>
              <div className="rule" aria-hidden="true" />
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  setOpen(false);
                  onRemove();
                }}
              >
                {t("programs.menu.remove")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One program as a well: what it makes, whether it is there, and the one
 * thing to do about it. Shared by Settings > Programs and the first-run
 * step, which differ in one rule: on a first run nothing has failed yet, so
 * a program that is simply not there yet is a to-do, with no red edge and no
 * stage rows. Edges and rows come with a setup that failed, a program that
 * is there and broken, and with Settings, where a missing program is a
 * problem with the machine as it stands.
 */
export function ProgramWell({
  program,
  report,
  context,
  host,
  queuedBehind,
}: {
  program: ProgramInfo;
  report: ProgramsReport;
  context: "settings" | "wizard";
  /** The paired engine's host name, or null for this computer. */
  host: string | null;
  /** Wizard only: the program this one waits for in "Set up all". */
  queuedBehind?: ProgramId | null;
}) {
  const readiness = useApp((state) => state.readiness);
  const setupProgram = useApp((state) => state.setupProgram);
  const cancelProgramSetup = useApp((state) => state.cancelProgramSetup);
  const removeProgram = useApp((state) => state.removeProgram);
  const openSettings = useApp((state) => state.openSettings);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const name = programName(program.id);
  const Icon = ICON[program.id];
  const job = program.setup.job;
  const offer = setupOffer(program);
  const failure = shownFailure(program);
  const attention = needsAttention(program);
  const costs: ReadinessRow[] =
    failure || (context === "settings" && attention) || (attention && program.state === "broken")
      ? rowsCostBy(program, readiness)
      : [];
  // The edge is the worst light in the well; a failed setup is red whatever
  // the rows say, and a running one is the accent.
  const edge = job
    ? "edge-busy"
    : failure || costs.some((row) => row.verdict !== "degraded") ||
        (context === "settings" && program.state !== "ready") ||
        program.state === "broken"
      ? "edge-fail"
      : costs.length > 0
        ? "edge-deg"
        : "";
  const quiet = !job && !attention && !failure;

  // The outcome is announced once, as it lands, for whoever cannot see the
  // well change. The visible state is the status line itself.
  const seenOutcome = useRef(program.setup.last?.job ?? null);
  const last = program.setup.last;
  const announce =
    last && last.job !== seenOutcome.current
      ? t(`programs.outcomes.${last.outcome}` as MessageKey, { name })
      : "";

  const act = async (run: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(await run());
    setBusy(false);
  };

  const size = offer?.size ?? program.setup.download_bytes;
  const sizeLabel = size ? formatSize(size) : null;
  const setupButton = (kind: "setup" | "retry" | "update") => {
    const label =
      kind === "retry"
        ? t("programs.setup.retry")
        : kind === "update"
          ? t("programs.setup.update", { name })
          : host
            ? t("programs.setup.actionOn", { host })
            : t("programs.setup.action", { name });
    const tip =
      kind === "retry"
        ? {
            label: t("programs.setup.retryTip", { name }),
            hint: t("programs.setup.retryTipHint", { size: sizeLabel ?? "" }),
          }
        : kind === "update"
          ? {
              label: t("programs.setup.updateTip", { version: program.setup.version ?? "" }),
              hint: t("programs.setup.updateTipHint", { size: sizeLabel ?? "" }),
            }
          : {
              label: t("programs.setup.tip", { name }),
              hint: host
                ? t("programs.setup.tipHintOn", { size: sizeLabel ?? "", host })
                : t("programs.setup.tipHint", { size: sizeLabel ?? "" }),
            };
    return (
      <Tip label={tip.label} hint={tip.hint}>
        <button
          className="btn-outline sm"
          disabled={busy}
          onClick={() => void act(() => setupProgram(program.id))}
        >
          {label}
          {/* A space for the accessible name; the flex gap draws it. */}
          {sizeLabel && " "}
          {sizeLabel && <span className="readout">{sizeLabel}</span>}
        </button>
      </Tip>
    );
  };

  let action: ReactNode = null;
  if (job) {
    const late = job.phase === "installing";
    action = (
      <Tip
        label={late ? t("programs.setup.cancelLateTip") : t("programs.setup.cancelTip", { name })}
        hint={late ? t("programs.setup.cancelLateTipHint") : t("programs.setup.cancelTipHint")}
      >
        <button
          className="btn-ghost sm"
          disabled={busy || late}
          onClick={() => void act(() => cancelProgramSetup(program.id))}
        >
          {t("common.cancel")}
        </button>
      </Tip>
    );
  } else if (queuedBehind && sizeLabel) {
    action = <span className="readout">{sizeLabel}</span>;
  } else if (offer && offer.kind !== "retry") {
    action = setupButton(offer.kind);
  } else if (!attention && context === "wizard") {
    action = (
      <span className="ok-word">
        <CircleCheck size={15} strokeWidth={1.8} aria-hidden="true" />
        {t("programs.states.ready")}
      </span>
    );
  }
  const gear =
    context === "settings" && !job && offer?.kind !== "setup" ? (
      <ProgramMenu program={program} onRemove={() => setConfirmRemove(true)} />
    ) : null;

  const fraction = job ? setupFraction(job) : 0;
  const eta = job ? setupEta(job) : null;
  const progress =
    job && job.total > 0
      ? eta
        ? t("programs.setup.progressEta", {
            done: formatSize(job.done),
            total: formatSize(job.total),
            eta,
          })
        : t("programs.setup.progress", { done: formatSize(job.done), total: formatSize(job.total) })
      : null;
  const phase = job ? t(`programs.phases.${job.phase}` as MessageKey, { name }) : "";
  const lines = job || failure ? [] : statusOf(program, { host, offer });
  // The other way round a missing Ollama: a cloud model, with a key.
  const cloudAlternative = program.id === "ollama" && attention;

  return (
    <div
      className={`pw${edge ? ` ${edge}` : ""}${quiet ? " quiet" : ""}`}
      role="group"
      aria-label={t("programs.wellAria", {
        name,
        state: t(`programs.states.${program.state}` as MessageKey),
      })}
    >
      <div className="pw-head">
        <span className="pw-ico" aria-hidden="true">
          <Icon size={16} strokeWidth={1.8} />
        </span>
        <div className="pw-id">
          <div className="pw-name">
            {name}
            {program.version && program.state === "ready" && (
              <span
                className="readout"
                aria-label={t("programs.versionAria", { version: program.version })}
              >
                {program.version}
              </span>
            )}
          </div>
          <div className="pw-does">{t(`programs.does.${program.id}` as MessageKey)}</div>
        </div>
        {(action || gear) && (
          <div className="pw-act">
            {action}
            {gear}
          </div>
        )}
      </div>

      {job && (
        <>
          <p className="pw-status">
            {phase}
            {progress && <span className="readout">{progress}</span>}
          </p>
          <div
            className="pw-bar"
            role="progressbar"
            aria-label={t("programs.setup.progressAria", { name })}
            aria-valuenow={Math.round(fraction * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${phase}, ${Math.round(fraction * 100)}%`}
          >
            <i style={{ width: `${fraction * 100}%` }} />
          </div>
        </>
      )}
      {queuedBehind && !job && (
        <p className="pw-status">{t("programs.queued", { name: programName(queuedBehind) })}</p>
      )}
      {failure && (
        <>
          <p className="pw-status fail">
            {t(`programs.failures.${failure}` as MessageKey, { name })}
          </p>
          <p className="pw-detail">
            {t(`programs.advice.${failure}` as MessageKey, {
              name,
              size: formatSize(
                (program.setup.download_bytes ?? 0) + (program.setup.install_bytes ?? 0),
              ),
              dir: report.programs_dir,
            })}
          </p>
          {offer?.kind === "retry" && <div className="pw-fix">{setupButton("retry")}</div>}
        </>
      )}
      {lines.length > 0 && !queuedBehind && (
        <p className="pw-status">
          {lines.map((line, index) => (
            <span key={line.text}>
              {index > 0 && " "}
              <WithCode text={line.text} code={line.code} />
            </span>
          ))}
        </p>
      )}
      {error && (
        <p className="pw-error" role="alert">
          {error}
        </p>
      )}
      {cloudAlternative && (
        <p className="pw-alt">
          {context === "settings" ? (
            <>
              {t("programs.diy.ollama.cloud")}{" "}
              <Tip
                label={t("programs.diy.ollama.cloudLink")}
                hint={t("programs.diy.ollama.cloudTipHint")}
              >
                <button className="link" onClick={() => openSettings("providers")}>
                  {t("programs.diy.ollama.cloudLink")}
                </button>
              </Tip>
              .
            </>
          ) : (
            t("programs.diy.ollama.cloudLater")
          )}
        </p>
      )}
      {costs.length > 0 && (
        <div className="pw-rows">
          <GapRows rows={costs} />
        </div>
      )}
      {attention && !job && !queuedBehind && (
        <ManualSetup program={program} report={report} host={host} open={failure !== null} />
      )}
      <span className="sr-only" role="status">
        {announce}
      </span>
      {confirmRemove && program.managed && (
        <ConfirmDialog
          title={t("programs.remove.title", { name })}
          message={t("programs.remove.message", { name })}
          confirmLabel={t("programs.remove.confirm", { size: formatSize(program.managed.bytes) })}
          cancelLabel={t("common.keepIt")}
          danger
          victim={{
            name: program.managed.version ? `${name} ${program.managed.version}` : name,
            detail: program.managed.location,
          }}
          onConfirm={() => {
            setConfirmRemove(false);
            void act(async () => {
              const failed = await removeProgram(program.id);
              return failed ? t("programs.remove.failed", { error: failed }) : null;
            });
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}

/** Voice cloning, which runs inside the engine's own Python and so is
 * nothing a setup can download. Shown under "Not needed to make a video",
 * dimmed when the engine cannot clone. */
export function ChatterboxWell({ cloning, remote }: { cloning: boolean; remote: boolean }) {
  return (
    <div
      className={`pw quiet${cloning ? "" : " off"}`}
      role="group"
      aria-label={t("programs.wellAria", {
        name: t("programs.chatterbox.name"),
        state: t(cloning ? "programs.states.ready" : "programs.states.missing"),
      })}
    >
      <div className="pw-head">
        <span className="pw-ico" aria-hidden="true">
          <Mic size={16} strokeWidth={1.8} />
        </span>
        <div className="pw-id">
          <div className="pw-name">{t("programs.chatterbox.name")}</div>
          <div className="pw-does">{t("programs.chatterbox.does")}</div>
        </div>
      </div>
      <p className="pw-status">
        {cloning
          ? t("programs.chatterbox.ready")
          : // A source checkout or a GPU box can carry it; only the
            // installed app on this computer is sure not to.
            remote || import.meta.env.DEV
            ? t("programs.chatterbox.notInEngine")
            : t("programs.chatterbox.notInstalled")}
      </p>
    </div>
  );
}
