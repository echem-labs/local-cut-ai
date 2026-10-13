import { AppWindow, HardDrive, Laptop, RefreshCw, Server } from "lucide-react";
import { useEffect } from "react";
import { t } from "../i18n";
import { hostOf, isKnownProgram, PROGRAM_ORDER } from "../lib/programs";
import { useVoices } from "../lib/useVoices";
import { useApp } from "../store";
import { formatSize } from "./ModelLibrary";
import { PipelineStrip } from "./PipelineStrip";
import { ChatterboxWell, ProgramWell, useCheckAgain, WithCode } from "./ProgramWell";
import { Tip } from "./Tooltip";

/* the settings chrome scale: 15/1.8 for headings, 14 inside rows */
const ICON_CONTROL = { size: 15, strokeWidth: 1.8 } as const;

/** "On this computer", with the place set in bold. The sentence comes whole
 * from the catalog and is split at the slot, so word order stays the
 * translator's. */
function Where({ where }: { where: string }) {
  const SLOT = "\u0000";
  const [before, after] = t("programs.on", { where: SLOT }).split(SLOT);
  return (
    <span>
      {before}
      <b>{where}</b>
      {after}
    </span>
  );
}

/**
 * Settings > Programs: the programs the engine runs, as its machine finds
 * them, and the one thing to do about each. On a paired engine everything
 * here is that box's (its programs, its disk, its system's steps), which
 * the line at the top says before anything else does.
 */
export function ProgramsPane() {
  const client = useApp((state) => state.client);
  const programs = useApp((state) => state.programs);
  const programsError = useApp((state) => state.programsError);
  const remoteEngine = useApp((state) => state.remoteEngine);
  const refreshPrograms = useApp((state) => state.refreshPrograms);
  const refreshReadiness = useApp((state) => state.refreshReadiness);
  const setSettingsTab = useApp((state) => state.setSettingsTab);
  const voices = useVoices();
  const check = useCheckAgain();

  // Read on every visit: a program installed by hand since the last one is
  // exactly what someone opens this pane to see.
  useEffect(() => {
    if (!client) return;
    void refreshPrograms();
    refreshReadiness().catch((err) => console.warn("readiness refresh failed:", err));
  }, [client, refreshPrograms, refreshReadiness]);

  const host = remoteEngine ? hostOf(client?.baseUrl) : null;
  const rows = (programs?.programs ?? []).filter((row) => isKnownProgram(row.id));
  rows.sort((a, b) => PROGRAM_ORDER.indexOf(a.id) - PROGRAM_ORDER.indexOf(b.id));

  return (
    <section className="programs-pane">
      <h2>
        <AppWindow {...ICON_CONTROL} />
        {t("settings.tabs.programs")}
      </h2>
      <p className="hint">{t("programs.pane.hint")}</p>
      <div className="programs-where">
        {host ? (
          <Server {...ICON_CONTROL} aria-hidden="true" />
        ) : (
          <Laptop {...ICON_CONTROL} aria-hidden="true" />
        )}
        <Where where={host ?? t("programs.here")} />
        <span className="spacer" />
        <Tip label={t("programs.pane.checkTip")} hint={t("programs.pane.checkTipHint")}>
          <button className="btn-ghost sm" disabled={check.busy || !client} onClick={check.run}>
            <RefreshCw
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
              className={check.busy ? "spin" : ""}
            />
            {check.busy ? t("programs.pane.checking") : t("programs.pane.check")}
          </button>
        </Tip>
      </div>
      {host && <p className="hint programs-remote">{t("programs.pane.remoteHint")}</p>}
      <PipelineStrip context="settings" />
      {programsError && (
        <p className="banner error" role="alert">
          {t("programs.pane.failed", { error: programsError })}
        </p>
      )}
      {programs ? (
        <>
          <div className="pw-list">
            {rows.map((program) => (
              <ProgramWell
                key={program.id}
                program={program}
                report={programs}
                context="settings"
                host={host}
              />
            ))}
            <p className="programs-group">{t("programs.pane.optional")}</p>
            <ChatterboxWell cloning={voices?.cloning === true} remote={host !== null} />
          </div>
          <p className="programs-foot">
            <HardDrive size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>
              <WithCode
                text={
                  programs.programs_bytes > 0
                    ? t("programs.pane.foot", {
                        size: formatSize(programs.programs_bytes),
                        dir: programs.programs_dir,
                      })
                    : t("programs.pane.footEmpty", { dir: programs.programs_dir })
                }
                code={[formatSize(programs.programs_bytes), programs.programs_dir]}
              />{" "}
              <WithCode
                text={t("programs.pane.footFree", { size: formatSize(programs.disk_free_bytes) })}
                code={[formatSize(programs.disk_free_bytes)]}
              />{" "}
              <Tip
                label={t("programs.pane.manageStorageTip")}
                hint={t("programs.pane.manageStorageTipHint")}
              >
                <button className="link" onClick={() => setSettingsTab("storage")}>
                  {t("programs.pane.manageStorage")}
                </button>
              </Tip>
            </span>
          </p>
        </>
      ) : (
        !programsError && (
          <p className="hint">
            {client ? t("programs.pane.loading") : t("programs.pane.noEngine")}
          </p>
        )
      )}
    </section>
  );
}
