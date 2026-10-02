import type { ReactNode } from "react";
import type { ProgramId } from "../api/types";
import { plural, t, useLocale, type MessageKey } from "../i18n";
import { narrate, pipelineStages, type Narration, type StageView } from "../lib/pipeline";
import { programName } from "../lib/programs";
import { useApp } from "../store";
import { Tip } from "./Tooltip";

/** The word under a stage's light. Two stages have their own: music that
 * is a stand-in is silence in the finished video, and clips on the still
 * tier are stills rather than a lower quality of video. */
function wordOf(stage: StageView): string {
  if (stage.id === "music" && stage.light === "ph") return t("programs.strip.none");
  if (stage.id === "clips" && stage.light === "deg") return t("programs.strip.stills");
  return t(`programs.strip.lights.${stage.light}` as MessageKey);
}

/** A sentence from the catalog with a control set into its {link} slot, so
 * word order stays the translator's. */
function withLink(text: string, link: ReactNode): ReactNode {
  const SLOT = "\u0000";
  const [before, after] = text.split(SLOT);
  return (
    <>
      {before}
      {after !== undefined && link}
      {after}
    </>
  );
}

function Said({
  narration,
  context,
  list,
  onModels,
}: {
  narration: Narration;
  context: "wizard" | "settings";
  list: (items: string[]) => string;
  onModels: () => void;
}) {
  const stage = (id: string) => t(`programs.strip.stages.${id}` as MessageKey);
  const inSentence = (id: string) => t(`programs.strip.inSentence.${id}` as MessageKey);
  switch (narration.kind) {
    case "checking":
      return <>{t("programs.narrate.checking")}</>;
    case "settingUp": {
      const names = narration.ready.map((id: ProgramId) => programName(id));
      const parts = [
        names.length > 0 ? plural("programs.narrate.ready", names.length, { names: list(names) }) : "",
        narration.next
          ? t("programs.narrate.settingUpThen", {
              name: programName(narration.current),
              next: programName(narration.next),
            })
          : t("programs.narrate.settingUp", { name: programName(narration.current) }),
        context === "wizard" ? t("programs.narrate.goOn") : "",
      ];
      return <>{parts.filter(Boolean).join(" ")}</>;
    }
    case "render": {
      const fails = list(narration.fails.map(inSentence));
      if (narration.standIns > 0 && narration.fails.length > 0) {
        return <>{plural("programs.narrate.standInsFail", narration.standIns, { stages: fails })}</>;
      }
      if (narration.standIns > 0) {
        return <>{plural("programs.narrate.standIns", narration.standIns)}</>;
      }
      return <>{t("programs.narrate.fail", { stages: fails })}</>;
    }
    case "programsReady":
      return (
        <>{narration.all ? t("programs.narrate.programsReady") : t("programs.narrate.programsDone")}</>
      );
    case "noModel": {
      const text = plural("programs.narrate.noModel", narration.stages.length, {
        stages: list(narration.stages.map(stage)),
        link: "\u0000",
      });
      return withLink(
        text,
        <Tip label={t("programs.narrate.modelsTip")} hint={t("programs.narrate.modelsTipHint")}>
          <button className="link" onClick={onModels}>
            {t("programs.narrate.modelsLink")}
          </button>
        </Tip>,
      );
    }
    case "allReady":
      return <>{t("programs.narrate.allReady")}</>;
  }
}

/**
 * Seven lights, in the order a video gets made, saying what the next render
 * would come out like: ready, being set up, a stand-in, a failed job, a
 * lower-quality result, or (on the first run) waiting on the models the
 * next step downloads. The line under it says the same in a sentence,
 * worst news first, and changes as programs come up.
 */
export function PipelineStrip({ context }: { context: "wizard" | "settings" }) {
  const readiness = useApp((state) => state.readiness);
  const programs = useApp((state) => state.programs);
  const queue = useApp((state) => state.programQueue);
  const setSettingsTab = useApp((state) => state.setSettingsTab);
  const locale = useLocale((state) => state.locale);
  const busy = new Set<ProgramId>(queue);
  for (const row of programs?.programs ?? []) if (row.setup.job) busy.add(row.id);
  const stages = pipelineStages(readiness, programs, context, busy);
  const narration = narrate(stages, programs, context, queue);
  const list = (items: string[]) =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  return (
    <>
      <div className="pstrip">
        <ol aria-label={t("programs.strip.aria")}>
          {stages.map((stage) => (
            <li key={stage.id}>
              <i className={`light ${stage.light}`} aria-hidden="true" />
              <span className="lbl">{t(`programs.strip.stages.${stage.id}` as MessageKey)}</span>
              <span className={`eff ${stage.light}`}>{wordOf(stage)}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className="pnarr" role="status">
        <Said
          narration={narration}
          context={context}
          list={list}
          onModels={() => setSettingsTab("models")}
        />
      </p>
    </>
  );
}
