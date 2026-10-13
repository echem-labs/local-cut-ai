import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelRow } from "../api/types";
import { BrandMark } from "../components/BrandMark";
import { FilterTabs } from "../components/FilterTabs";
import { formatSize, ModelLibrary, OLLAMA_TASK } from "../components/ModelLibrary";
import { PipelineRail } from "../components/PipelineRail";
import { PipelineStrip } from "../components/PipelineStrip";
import { ChatterboxWell, ProgramWell } from "../components/ProgramWell";
import { SpecChips } from "../components/SpecChips";
import { StageSummaryRow } from "../components/StageSummaryRow";
import { Stepper } from "../components/Stepper";
import { m, plural, t } from "../i18n";
import { fitFor } from "../lib/fit";
import {
  hostOf,
  isKnownProgram,
  needsAttention,
  PROGRAM_ORDER,
  programName,
  setupOffer,
} from "../lib/programs";
import { finalVideoRow, stageRows, type StageRow } from "../lib/stages";
import { useVoices } from "../lib/useVoices";
import { useApp } from "../store";

/**
 * First launch as a five-step wizard: welcome, machine, programs, models,
 * ready (design review v3, reference/v3/wiz-1..4, with the programs step
 * from design review 14). Each step makes one claim and asks one
 * question; the stepper header is the only "N of M".
 *
 * The state machine lives here, not in the store: steps and the model
 * selection are conversation state, meaningless once setup finishes —
 * only firstRunDone (and the downloads the engine is running) survive.
 * The one store input besides data is firstRunReturning: reopened from
 * Settings, the wizard starts at the machine step, because the welcome
 * promise is a once-only moment.
 */
type Step = 1 | 2 | 3 | 4 | 5;

export function FirstRun() {
  const {
    client,
    system,
    models,
    refreshModels,
    startDownload,
    finishFirstRun,
    firstRunReturning,
    programs,
  } = useApp();
  const [step, setStep] = useState<Step>(firstRunReturning ? 2 : 1);
  const [library, setLibrary] = useState(false);
  // null until seeded from the recommendations — not an empty selection.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  // What "Download & continue" actually started, frozen at that moment:
  // step 4's overall bar must keep counting a model that finishes while
  // the screen is open, not drop it and jump backward.
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set());

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
    for (const row of pending) {
      if (!row.downloading) void startDownload(row.id);
    }
    setWatchedIds(new Set(pending.map((row) => row.id)));
    setLibrary(false);
    setStep(5);
  };

  const taskLabels = m().models.taskLabels as Record<string, string>;
  const stepLabels = [
    t("firstRun.stepWelcome"),
    t("firstRun.stepMachine"),
    t("firstRun.stepPrograms"),
    t("firstRun.stepModels"),
    t("firstRun.stepReady"),
  ];

  // Recommendations with a model, in pipeline order — the rail, the
  // library outline and the summary all derive from this one list.
  const stages = useMemo(
    () => (system ? system.recommendations.filter((rec) => rec.model !== null) : []),
    [system],
  );
  const recommendedIds = useMemo(
    () => new Set(stages.map((rec) => rec.model!.id)),
    [stages],
  );

  const railMeta = (row: ModelRow | undefined, task: string): string => {
    const external = row ? row.files.length === 0 : false;
    if (external) {
      return task === OLLAMA_TASK ? t("firstRun.railOllama") : t("firstRun.railOutside");
    }
    const size = formatSize(row?.size_bytes ?? 0);
    return row?.downloaded
      ? t("firstRun.railInstalled", { size })
      : t("firstRun.railToDownload", { size });
  };

  return (
    <div className="setup wizard">
      <Stepper labels={stepLabels} current={step - 1} />

      {step === 1 && (
        <div className="wiz-body">
          <BrandMark size={56} />
          <h1>{t("firstRun.welcomeTitle")}</h1>
          <p className="sub">{t("firstRun.welcomeSub")}</p>
          <div className="setup-actions">
            <button className="btn-primary" onClick={() => setStep(2)}>
              {t("firstRun.getStarted")}
            </button>
            <button className="btn-ghost" onClick={finishFirstRun}>
              {t("firstRun.skip")}
            </button>
          </div>
          <p className="hintline">{t("firstRun.welcomeHint")}</p>
        </div>
      )}

      {step === 2 && (
        <div className="wiz-body">
          <h2>{t("firstRun.machineTitle")}</h2>
          <p className="sub">{t("firstRun.machineSub")}</p>
          {system ? (
            <div className="setup-machine">
              <div className="machine-head">
                <span className="eyebrow">{t("firstRun.hardwareEyebrow")}</span>
                <span className="badge">
                  {t("firstRun.tierBadge", { tier: system.hardware.tier })}
                </span>
              </div>
              <SpecChips system={system} />
              <p className="verdict">
                {stages.length === system.recommendations.length && stages.length > 0 ? (
                  <>
                    <b>{t("firstRun.verdictAllLead")}</b> {t("firstRun.verdictAllTail")}
                  </>
                ) : (
                  <>
                    <b>{t("firstRun.verdictPartialLead", { count: stages.length })}</b>{" "}
                    {t("firstRun.verdictPartialTail")}
                  </>
                )}
              </p>
            </div>
          ) : (
            <div className="setup-machine">
              <div className="machine-head">
                <span className="eyebrow">{t("firstRun.hardwareEyebrow")}</span>
              </div>
              <p className="verdict">{t("firstRun.checkingSub")}</p>
            </div>
          )}
          <div className="setup-actions">
            <button className="btn-primary" onClick={() => setStep(3)} disabled={!system}>
              {t("common.continue")}
            </button>
            <button className="btn-ghost" onClick={() => setStep(1)} disabled={firstRunReturning}>
              {t("common.back")}
            </button>
            <span className="spacer" />
            <button className="btn-ghost" onClick={finishFirstRun}>
              {t("firstRun.skip")}
            </button>
          </div>
        </div>
      )}

      {step === 3 && <ProgramsStep onBack={() => setStep(2)} onNext={() => setStep(4)} />}

      {step === 4 && !library && (
        <div className="wiz-body">
          <h2>{t("firstRun.modelsTitle")}</h2>
          <p className="sub">{t("firstRun.modelsSub")}</p>
          <PipelineRail
            rows={stages.map((rec) => {
              const row = rowById.get(rec.model!.id);
              return {
                key: rec.task,
                name: t("firstRun.railName", {
                  stage: taskLabels[rec.task] ?? rec.task,
                  model: rec.model!.id,
                }),
                meta: railMeta(row, rec.task),
                checked: picked.has(rec.model!.id),
                toggleAria: t("firstRun.railToggleAria", {
                  stage: taskLabels[rec.task] ?? rec.task,
                }),
                onToggle: () => toggle(rec.model!.id),
              };
            })}
          />
          <div className="setup-actions">
            <button
              className="btn-primary"
              onClick={beginDownloads}
              disabled={!system || models.length === 0}
            >
              {pending.length > 0
                ? t("firstRun.downloadContinue", { size: formatSize(totalBytes) })
                : t("common.continue")}
            </button>
            <button className="btn-ghost" onClick={() => setLibrary(true)}>
              {t("firstRun.openLibrary")}
            </button>
            <span className="spacer" />
            <button className="btn-ghost" onClick={() => setStep(3)}>
              {t("common.back")}
            </button>
          </div>
          {pending.length > 0 && (
            <p className="hintline">
              {plural("firstRun.pending", pending.length, { size: formatSize(totalBytes) })}
            </p>
          )}
        </div>
      )}

      {step === 4 && library && (
        <LibraryStep
          picked={picked}
          onToggle={toggle}
          recommendedIds={recommendedIds}
          pendingCount={pending.length}
          totalBytes={totalBytes}
          onContinue={beginDownloads}
          onBackToRail={() => setLibrary(false)}
          onBack={() => {
            setLibrary(false);
            setStep(3);
          }}
        />
      )}

      {step === 5 && (
        <ReadyStep
          stages={[
            ...stageRows(system, models, programs),
            ...(finalVideoRow(programs) ? [finalVideoRow(programs)!] : []),
          ]}
          models={models}
          pendingIds={watchedIds}
          onDone={finishFirstRun}
        />
      )}
    </div>
  );
}

function LibraryStep({
  picked,
  onToggle,
  recommendedIds,
  pendingCount,
  totalBytes,
  onContinue,
  onBackToRail,
  onBack,
}: {
  picked: Set<string>;
  onToggle: (id: string) => void;
  recommendedIds: Set<string>;
  pendingCount: number;
  totalBytes: number;
  onContinue: () => void;
  onBackToRail: () => void;
  onBack: () => void;
}) {
  const system = useApp((state) => state.system);
  const [filter, setFilter] = useState<"fits" | "all">("fits");
  return (
    <div className="wiz-body">
      <h2>{t("firstRun.libraryTitle")}</h2>
      <p className="sub">{t("firstRun.librarySub")}</p>
      <FilterTabs
        ariaLabel={t("firstRun.fitFilterAria")}
        value={filter}
        onChange={setFilter}
        options={[
          { value: "fits", label: t("firstRun.fitFilterFits") },
          { value: "all", label: t("firstRun.fitFilterAll") },
        ]}
      />
      <ModelLibrary
        selected={picked}
        onToggle={onToggle}
        recommendedIds={recommendedIds}
        fitOf={(row) => fitFor(row, system)}
        hideUnfit={filter === "fits"}
      />
      <div className="setup-actions">
        <button className="btn-primary" onClick={onContinue}>
          {pendingCount > 0
            ? t("firstRun.downloadContinue", { size: formatSize(totalBytes) })
            : t("common.continue")}
        </button>
        <button className="link" onClick={onBackToRail}>
          {t("firstRun.backToRecommended")}
        </button>
        <span className="spacer" />
        <button className="btn-ghost" onClick={onBack}>
          {t("common.back")}
        </button>
      </div>
      {filter === "all" && <p className="hintline">{t("firstRun.libraryHint")}</p>}
    </div>
  );
}

/**
 * The programs step: FFmpeg, Ollama and ComfyUI, found or not, with the
 * strip above them saying what a render would make right now.
 *
 * Nothing has gone wrong yet on a first run, so a program that is not
 * there yet is a to-do rather than a failure (the wells carry no red edge
 * and no stage rows until a setup fails). The setups run in the engine,
 * one at a time, and carry on when this step is left, which is why its
 * button turns into Continue the moment one starts.
 */
function ProgramsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const client = useApp((state) => state.client);
  const programs = useApp((state) => state.programs);
  const programsError = useApp((state) => state.programsError);
  const queue = useApp((state) => state.programQueue);
  const remoteEngine = useApp((state) => state.remoteEngine);
  const refreshPrograms = useApp((state) => state.refreshPrograms);
  const refreshReadiness = useApp((state) => state.refreshReadiness);
  const setupPrograms = useApp((state) => state.setupPrograms);
  const voices = useVoices();
  const [error, setError] = useState<string | null>(null);

  // Asked again on arrival: this is the screen a person reads to decide
  // whether to set something up, so what it shows has to be now.
  useEffect(() => {
    if (!client) return;
    void refreshPrograms();
    refreshReadiness().catch((err) => console.warn("readiness refresh failed:", err));
  }, [client, refreshPrograms, refreshReadiness]);

  const host = remoteEngine ? hostOf(client?.baseUrl) : null;
  const rows = (programs?.programs ?? [])
    .filter((row) => isKnownProgram(row.id))
    .sort((a, b) => PROGRAM_ORDER.indexOf(a.id) - PROGRAM_ORDER.indexOf(b.id));
  const running = rows.find((row) => row.setup.job) ?? null;
  const busy = running !== null || queue.length > 0;
  const settable = rows.filter((row) => {
    const offer = setupOffer(row);
    return offer?.kind === "setup" || offer?.kind === "retry";
  });
  const total = settable.reduce((sum, row) => sum + (row.setup.download_bytes ?? 0), 0);
  // A program LocalCut cannot set up here has only its manual steps, and
  // the sentence that promises "for you" must not cover it.
  const someByHand = rows.some((row) => needsAttention(row) && !row.setup.available);

  const start = () => {
    void setupPrograms(settable.map((row) => row.id)).then(setError);
  };
  const action = busy || settable.length === 0
    ? null
    : settable.length === 1
      ? t("programs.setup.action", { name: programName(settable[0].id) })
      : settable.length === 2
        ? t("programs.wizard.setupBoth")
        : t("programs.wizard.setupAll");

  return (
    <div className="wiz-body">
      <h2>{t("programs.wizard.title")}</h2>
      <p className="sub">{someByHand ? t("programs.wizard.subSome") : t("programs.wizard.sub")}</p>
      <PipelineStrip context="wizard" />
      {programsError && (
        <p className="banner error" role="alert">
          {t("programs.pane.failed", { error: programsError })}
        </p>
      )}
      {programs ? (
        <div className="pw-list">
          {rows.map((row) => {
            const place = queue.indexOf(row.id);
            const behind = place < 0 ? null : place === 0 ? (running?.id ?? null) : queue[place - 1];
            return (
              <ProgramWell
                key={row.id}
                program={row}
                report={programs}
                context="wizard"
                host={host}
                queuedBehind={behind}
              />
            );
          })}
          <p className="programs-group">{t("programs.pane.optional")}</p>
          <ChatterboxWell cloning={voices?.cloning === true} remote={host !== null} />
        </div>
      ) : (
        !programsError && <p className="hint">{t("programs.pane.loading")}</p>
      )}
      <div className="setup-actions">
        {action ? (
          <button className="btn-primary" onClick={start}>
            {action}
            {total > 0 && (
              <>
                {" "}
                <span className="readout">{formatSize(total)}</span>
              </>
            )}
          </button>
        ) : (
          <button className="btn-primary" onClick={onNext}>
            {t("common.continue")}
          </button>
        )}
        <button className="btn-ghost" onClick={onBack}>
          {t("common.back")}
        </button>
        {action && (
          <>
            <span className="spacer" />
            <button className="btn-ghost" onClick={onNext}>
              {t("programs.wizard.skip")}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="hint error-text" role="alert">
          {error}
        </p>
      )}
      {action && <p className="hintline">{t("programs.wizard.hintSetup")}</p>}
      {busy && <p className="hintline">{t("programs.wizard.hintRunning")}</p>}
    </div>
  );
}

function ReadyStep({
  stages,
  models,
  pendingIds,
  onDone,
}: {
  stages: StageRow[];
  models: ModelRow[];
  pendingIds: Set<string>;
  onDone: () => void;
}) {
  // Overall progress across everything this wizard set downloading —
  // including extra library picks that aren't a pipeline stage.
  const watched = models.filter((row) => pendingIds.has(row.id));
  const totalBytes = watched.reduce((sum, row) => sum + row.size_bytes, 0);
  const doneBytes = watched.reduce(
    (sum, row) => sum + (row.downloaded ? row.size_bytes : (row.progress?.done ?? 0)),
    0,
  );
  const remaining = Math.max(0, totalBytes - doneBytes);

  // Simple rate-based time-left (per-median ETAs arrive in U5): bytes per
  // second since the step mounted, smoothed by using the whole elapsed
  // window rather than instantaneous deltas.
  const started = useRef<{ at: number; bytes: number } | null>(null);
  if (started.current === null) started.current = { at: Date.now(), bytes: doneBytes };
  const elapsed = (Date.now() - started.current.at) / 1000;
  const rate = elapsed > 3 ? (doneBytes - started.current.bytes) / elapsed : 0;
  const minutesLeft = rate > 0 ? Math.max(1, Math.round(remaining / rate / 60)) : null;

  const anyPending = watched.some((row) => !row.downloaded);

  return (
    <div className="wiz-body">
      <h2>{t("firstRun.readyTitle")}</h2>
      <p className="sub">{t("firstRun.readySub")}</p>
      <div className="sumrail">
        {stages.map((stage) => (
          <StageSummaryRow
            key={stage.task}
            stage={stage.stage}
            name={stage.name}
            runner={stage.runner}
            status={stage.status}
          />
        ))}
      </div>
      {anyPending && totalBytes > 0 && (
        <div className="overall">
          <span>
            {t("firstRun.overallOf", {
              done: formatSize(doneBytes),
              total: formatSize(totalBytes),
            })}
          </span>
          <span
            className="bar"
            role="progressbar"
            aria-valuenow={Math.round((doneBytes / totalBytes) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${(doneBytes / totalBytes) * 100}%` }} />
          </span>
          <span>{minutesLeft !== null ? t("firstRun.timeLeft", { minutes: minutesLeft }) : ""}</span>
        </div>
      )}
      <div className="setup-actions">
        <button className="btn-primary" onClick={onDone}>
          {t("firstRun.startCreating")}
        </button>
      </div>
    </div>
  );
}
