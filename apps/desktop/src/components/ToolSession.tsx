import { useEffect, useRef, useState } from "react";
import { AudioLines, Dices, FolderPlus, Mic, Repeat } from "lucide-react";
import type { Screenplay, TakeInfo } from "../api/types";
import { m, t } from "../i18n";
import { useApp } from "../store";
import { spokenSeconds } from "../lib/formats";
import { newestJob } from "../lib/jobs";
import { isDone, isSettled } from "../lib/status";
import { useMenuFit } from "../lib/useMenuFit";
import { useVoices } from "../lib/useVoices";
import { shortDuration } from "../lib/time";
import { isToolSession, toolLabel } from "../lib/tools";
import { ModelsPopover } from "./ModelsPopover";
import { ReadinessBanner, useReadinessGuard } from "./Readiness";
import { StatusRing } from "./StatusRing";
import { Tip } from "./Tooltip";
import { PromotedTo } from "./Provenance";
import { VoicePicker } from "./VoicePicker";
import { Waveform } from "./Waveform";

/** True when the page's h1 already says these words — exactly, or as the
 * longer ask the engine truncated this title down from. Tool projects are
 * titled by their own prompt, so a plain equality check misses the common
 * case where one side kept a few words the other lost. */
export function titleAlreadySays(pageTitle: string, title: string): boolean {
  const page = pageTitle.trim();
  const said = title.trim();
  if (!page || !said) return false;
  return page === said || page.startsWith(said) || said.startsWith(page);
}

/** How much of each end the loop-seam preview plays. Beds loop in
 * assembly, so end→start is the joint you would actually hear. */
export const SEAM_SECONDS = 2;

/** The seam preview's seek math, alone so a test can hold it still:
 * from (duration − seam) to the end, then from 0 for one seam more.
 * Tracks shorter than two seams have no distinct joint — play whole. */
export function seamPlan(durationS: number): { start: number; tailS: number } | null {
  if (!Number.isFinite(durationS) || durationS <= 2 * SEAM_SECONDS) return null;
  return { start: durationS - SEAM_SECONDS, tailS: SEAM_SECONDS };
}

/** Drive an audio element through the seam: tail, then head, then stop.
 * Returns a cancel function; `onDone` fires on either finish or cancel.
 * Takes the element rather than making one so a test can hand in a stub. */
export function playSeam(
  audio: HTMLAudioElement,
  durationS: number,
  onDone: () => void,
): () => void {
  const plan = seamPlan(durationS);
  let phase: "tail" | "head" = plan ? "tail" : "head";
  const stop = () => {
    audio.removeEventListener("ended", onEnded);
    audio.removeEventListener("timeupdate", onTime);
    audio.pause();
    onDone();
  };
  const onEnded = () => {
    if (phase === "tail") {
      // The joint itself: the end has played out, restart at the top.
      phase = "head";
      audio.currentTime = 0;
      void audio.play().catch(stop);
    } else {
      stop();
    }
  };
  const onTime = () => {
    if (phase === "head" && audio.currentTime >= SEAM_SECONDS) stop();
  };
  audio.addEventListener("ended", onEnded);
  audio.addEventListener("timeupdate", onTime);
  audio.currentTime = plan ? plan.start : 0;
  void audio.play().catch(stop);
  return stop;
}

export function useScreenplay(url: string | null): Screenplay | null {
  const [screenplay, setScreenplay] = useState<Screenplay | null>(null);

  useEffect(() => {
    setScreenplay(null);
    if (!url) return;
    let stale = false;
    fetch(url)
      .then((response) => response.json())
      .then((data) => {
        if (!stale) setScreenplay(data as Screenplay);
      })
      .catch((err) => console.warn("script artifact fetch failed:", err));
    return () => {
      stale = true;
    };
  }, [url]);

  return screenplay;
}

/** The screenplay as portable Markdown — what the Copy button puts on the
 * clipboard. Reads fine as plain text too. */
export function screenplayMarkdown(screenplay: Screenplay): string {
  const lines = [`# ${screenplay.title}`, ""];
  if (screenplay.hook) lines.push(`> ${screenplay.hook}`, "");
  for (const scene of screenplay.scenes) {
    lines.push(`## ${scene.id} · ~${Math.round(spokenSeconds(scene.narration))}s`, "");
    lines.push(scene.narration, "");
    if (scene.visual) lines.push(`*Visual:* ${scene.visual}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function ScriptTable({
  screenplay,
  targetS,
  hideTitle,
}: {
  screenplay: Screenplay;
  targetS?: number;
  /** True when the page's h1 already says exactly this — the same words
   * twice at heading weight read as a rendering bug, not emphasis. */
  hideTitle?: boolean;
}) {
  // Spoken time, not the script model's per-scene duration_s claim — nothing
  // downstream reads that field, and the assembled video will not either
  // (see SPEECH_WORDS_PER_S in lib/formats.ts).
  const totalS = screenplay.scenes.reduce(
    (sum, scene) => sum + spokenSeconds(scene.narration),
    0,
  );
  return (
    <div className="script-view">
      {!hideTitle && <h2>{screenplay.title}</h2>}
      {screenplay.hook && <p className="hook">{screenplay.hook}</p>}
      <table className="script-table">
        <thead>
          <tr>
            <th>{t("toolSession.table.scene")}</th>
            <th>{t("toolSession.table.narration")}</th>
            <th>{t("toolSession.table.visual")}</th>
            <th>{t("toolSession.table.length")}</th>
          </tr>
        </thead>
        <tbody>
          {screenplay.scenes.map((scene) => (
            <tr key={scene.id}>
              <td>{scene.id}</td>
              <td>{scene.narration}</td>
              <td>{scene.visual}</td>
              <td>{t("toolSession.lengthCell", { d: Math.round(spokenSeconds(scene.narration)) })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        {targetS
          ? t("toolSession.spokenTotalVsTarget", { total: Math.round(totalS), target: targetS })
          : t("toolSession.spokenTotal", { total: Math.round(totalS) })}
      </p>
    </div>
  );
}

/** Focused single-panel view for tool:* micro-projects — one node,
 * one preview, one download, and (for scripts) one promote path. */
export function ToolSession() {
  // `jobs`, not `allJobs`: allJobs is refreshed only by refreshHome, which a
  // job event for the OPEN project deliberately does not trigger (that path
  // calls refreshBoard). Reading it here left the model and duration below
  // pinned to whatever the last Home visit saw — so they never appeared at
  // all for a first render, and showed the previous take's after an enhance.
  const {
    board,
    client,
    currentProject,
    promote,
    actionError,
    jobs,
    projects,
    regenerate,
    enhance,
    refineTool,
    setVoice,
    selectTake,
    addToProject,
    applySessionVoiceClone,
  } = useApp();
  const [promoting, setPromoting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notes, setNotes] = useState("");
  const [enhancing, setEnhancing] = useState(false);
  // The composer's working copy of the tool's input — editable, sent back
  // through /patch as "update & re-render". Reset whenever the node's own
  // params move (a refine landing, a take swap).
  const [refineDraft, setRefineDraft] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  // Menus/dialogs local to this page. `null` string states double as
  // "closed"; a message is the store convention for a refusal.
  // The voice this voiceover speaks in, changeable without leaving the
  // window: re-rendering one in another voice is the reason to be here, and
  // sending the user back to Home to do it would lose the text they refined.
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const fit = useMenuFit();
  const [addResult, setAddResult] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneConsent, setCloneConsent] = useState(false);
  const [cloneResult, setCloneResult] = useState<string | null>(null);
  const [takeError, setTakeError] = useState<string | null>(null);
  const [seamPlaying, setSeamPlaying] = useState(false);
  const seamStopRef = useRef<(() => void) | null>(null);
  const seamAudioRef = useRef<HTMLAudioElement | null>(null);
  const cloneFileRef = useRef<HTMLInputElement>(null);

  // Whatever is playing stops with the page.
  useEffect(
    () => () => {
      seamStopRef.current?.();
    },
    [],
  );

  // Escape closes whichever popover is up — window-level, per the repo
  // rule: a div with no tabIndex never receives onKeyDown.
  useEffect(() => {
    if (!addOpen && !cloneOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAddOpen(false);
      setCloneOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addOpen, cloneOpen]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // Project-scoped on purpose: a tool session's graph holds exactly the
  // tool's nodes, so the project report is the precise preflight.
  const { guard: readinessGuard, dialog: readinessDialog } = useReadinessGuard(
    currentProject?.id ?? "home",
  );
  const tool = currentProject?.mode.startsWith("tool:")
    ? currentProject.mode.slice("tool:".length)
    : null;
  const node = tool ? board?.aux[tool] : undefined;
  // The clip tool is a keyframe→clip graph: while the keyframe renders (the
  // long pole) the clip sits queued, so show the keyframe's live progress —
  // and its error, which would otherwise be hidden behind the clip's
  // secondary "missing upstream artifact" failure.
  const upstream = tool === "clip" ? board?.aux.keyframe : undefined;
  // A skipped keyframe is not the long pole — it is not being rendered at
  // all — so the display falls through to the tool node rather than pinning
  // itself to a stage that will never progress.
  const progressNode = upstream && !isSettled(upstream.status) ? upstream : node;
  // `isDone`, not `isSettled`: this is a completion report, not a gate — it
  // suppresses the "generating" line AND gates the output panel, so a
  // `blocked` node (settled, but nothing was made and `artifact_hash` is
  // null) renders neither, leaving the session blank with no explanation.
  // See lib/status.ts for which question each helper answers.
  const done = node ? isDone(node.status) : false;
  const artifactUrl =
    node?.artifact_hash && client && currentProject
      ? client.artifactUrl(currentProject.id, node.artifact_hash)
      : null;
  const screenplay = useScreenplay(tool === "script" && done ? artifactUrl : null);

  // The artifact's recipe: what was asked for, straight off the tool node's
  // own params. prompt (visual tools) / text (voiceover) / brief (music) —
  // one of the three is the thing that was asked for. The KEY travels too:
  // it is what the composer's "update & re-render" writes back via /patch.
  const voices = useVoices(tool === "voiceover");
  const params = node?.params ?? {};
  const recipeKey =
    (["prompt", "text", "brief"] as const).find(
      (key) => typeof params[key] === "string" && (params[key] as string).length > 0,
    ) ?? null;
  const recipe = recipeKey ? (params[recipeKey] as string) : null;

  // A refine landing (or a take swap) moves the node's params — the
  // composer follows, discarding whatever half-edit it held: the engine's
  // text is the truth the next edit starts from.
  useEffect(() => {
    setRefineDraft(recipe ?? "");
    setRefineError(null);
  }, [recipe]);

  if (!tool || !node)
    // The dialog rides along: a board poll can drop the aux node while the
    // gate is open, and unmounting it there would discard the held
    // regenerate with nothing said — the same reason StalledNotice keeps
    // its dialog outside its own condition.
    return (
      <>
        <div className="banner">{t("toolSession.preparing")}</div>
        {readinessDialog}
      </>
    );

  // The job that produced what's on screen — its model and wall time are the
  // render's provenance. Newest DONE job for the tool node wins (a stale
  // failed retry must not claim a good artifact, and vice versa).
  const renderJob = done
    ? newestJob(jobs.filter((job) => job.spec.node_id === node.node_id && job.status === "done"))
    : null;
  const tookS =
    renderJob?.started_at != null && renderJob?.finished_at != null
      ? renderJob.finished_at - renderJob.started_at
      : null;
  const targetS =
    typeof node.params?.target_duration_s === "number"
      ? node.params.target_duration_s
      : undefined;

  const turnIntoVideo = async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      await promote();
    } finally {
      setPromoting(false);
    }
  };

  const copyScript = async () => {
    if (!screenplay) return;
    try {
      await navigator.clipboard.writeText(screenplayMarkdown(screenplay));
      setCopied(true);
    } catch (err) {
      console.warn("copy failed:", err);
    }
  };

  const sendEnhance = async () => {
    const trimmed = notes.trim();
    if (!trimmed || enhancing) return;
    setEnhancing(true);
    try {
      await enhance(trimmed);
      if (!useApp.getState().actionError) setNotes("");
    } finally {
      setEnhancing(false);
    }
  };

  const sendRefine = async () => {
    if (!recipeKey || refining) return;
    const value = refineDraft.trim();
    if (!value || value === recipe) return;
    setRefining(true);
    try {
      setRefineError(await refineTool(node.node_id, recipeKey, value));
    } finally {
      setRefining(false);
    }
  };

  // Whichever node drives the display: the keyframe while it renders, else
  // the tool node. `?? node` narrows the type (node is non-null past the
  // guard) — progressNode itself is computed before it.
  const shown = progressNode ?? node;

  // Tool projects are titled by their own ask, so the h1 above often IS the
  // recipe verbatim — repeating it in the card reads as a rendering bug.
  // And once a non-script session is done, the composer below holds the
  // same words editable, so the card's paragraph is only ever mid-render
  // provenance (script keeps it: its composer takes notes, not the prompt).
  // The chips carry the run's other inputs either way.
  const titleIsRecipe =
    recipe != null && currentProject != null && recipe.trim() === currentProject.title.trim();
  const showRecipeText = recipe != null && !titleIsRecipe && (tool === "script" || !done);
  const details: string[] = [];
  if (typeof params.voice === "string" && params.voice) details.push(params.voice);
  if (typeof params.motion === "string" && params.motion) details.push(params.motion);
  if (typeof params.duration_s === "number")
    details.push(t("toolSession.secondsChip", { s: params.duration_s }));
  if (typeof params.target_duration_s === "number")
    details.push(t("toolSession.secondsChip", { s: params.target_duration_s }));
  if (typeof params.aspect === "string" && params.aspect) details.push(params.aspect);

  // Recorded takes: only once a regenerate has displaced an identity —
  // one row is just "the current render" and says nothing.
  const takes = (node.takes ?? []).length > 1 ? (node.takes as TakeInfo[]) : [];

  // "Add to project" targets: real projects only. A tool output inside
  // another tool session helps nobody, and the newest-first order matches
  // the Continue shelf's idea of relevance.
  const targets = projects
    .filter((project) => !isToolSession(project))
    .sort((a, b) => (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at));

  const pickTake = async (take: TakeInfo) => {
    if (take.current) return;
    setTakeError(await selectTake(node.node_id, take.output_hash));
  };

  const addTo = async (targetId: string, title: string) => {
    setAddOpen(false);
    const error = await addToProject(targetId);
    setAddResult(error ?? t("toolSession.addedToProject", { title }));
  };

  const cloneFrom = async (file: File) => {
    setCloneOpen(false);
    setCloneConsent(false);
    const error = await applySessionVoiceClone(file);
    setCloneResult(error ?? t("toolSession.cloneApplied", { name: file.name }));
  };

  const toggleSeam = () => {
    if (seamPlaying) {
      seamStopRef.current?.();
      return;
    }
    if (!artifactUrl) return;
    // A fresh element (not the Waveform's player): the seam is a scripted
    // pass through two ranges, and stealing the visible player's position
    // mid-listen would be rude.
    const audio = seamAudioRef.current ?? new Audio(artifactUrl);
    seamAudioRef.current = audio;
    const begin = () => {
      setSeamPlaying(true);
      seamStopRef.current = playSeam(audio, audio.duration, () => {
        setSeamPlaying(false);
        seamStopRef.current = null;
      });
    };
    if (Number.isFinite(audio.duration) && audio.duration > 0) begin();
    else audio.addEventListener("loadedmetadata", begin, { once: true });
  };
  // Route the stage through the catalog (the raw "keyframe"/tool id was
  // untranslatable and disagreed with QueueTray's nodeLabel).
  // `toolLabel`, not an unchecked cast: `tool` is the raw wire value out of
  // `project.mode`, and indexing the catalog with a kind this build has no
  // copy for THREW — from the screen the palette will happily open, since it
  // lists a session whose kind it does not know rather than hiding it.
  const stageLabel = shown === upstream ? m().terms.kinds.keyframe : toolLabel(tool);
  return (
    <div className="tool-session">
      <ReadinessBanner />
      {readinessDialog}
      {/* What was asked for, then what answered it: the run's inputs as
          badges, then the render's provenance as muted meta. */}
      <div className="tool-status">
        <StatusRing status={shown.status} progress={shown.progress} />
        <span style={{ textTransform: "capitalize" }}>{m().status[shown.status]}</span>
        {shown.status === "rendering" && <span>{Math.round(shown.progress * 100)}%</span>}
        {details.map((detail) => (
          <span key={detail} className="badge">
            {detail}
          </span>
        ))}
        {(renderJob?.model || tookS != null || (tool === "image" && done)) && (
          <span className="status-meta">
            {renderJob?.model && (
              <Tip label={t("toolSession.modelMeta")} hint={renderJob.model} side="top">
                <small className="hint">{renderJob.model}</small>
              </Tip>
            )}
            {/* Only when there is a duration to read: a render that rounds
                to 0:00 reports nothing and reads as a broken clock. */}
            {tookS != null && Math.round(tookS) > 0 && (
              <Tip label={t("toolSession.tookMeta")} hint={t("toolSession.tookHint")} side="top">
                <small className="hint">{t("toolSession.took", { t: shortDuration(tookS) })}</small>
              </Tip>
            )}
            {/* The image tool's seed, visible: a reroll pins a new one, and a
                number you can read is a number you can reproduce. */}
            {tool === "image" && done && (
              <Tip label={t("toolSession.seedMeta")} hint={t("toolSession.seedHint")} side="top">
                <small className="hint">{t("toolSession.seedChip", { seed: node.seed })}</small>
              </Tip>
            )}
          </span>
        )}
      </div>

      {/* Outside the `done` branch on purpose: a session that has been
          promoted stays promoted while it re-runs, and a re-run that fails
          does not unmake the videos it already produced. */}
      {currentProject && <PromotedTo project={currentProject} />}

      {recipe && showRecipeText && (
        <div className="session-recipe">
          <span className="eyebrow">
            {t(tool === "voiceover" ? "toolSession.recipeText" : "toolSession.recipePrompt")}
          </span>
          <p>{recipe}</p>
        </div>
      )}

      {shown.error && <div className="banner error">{shown.error}</div>}
      {!done && !shown.error && (
        <div className="banner">{t("toolSession.generating", { stage: stageLabel })}</div>
      )}

      {done && artifactUrl && (
        <>
          {(tool === "thumbnail" || tool === "image") && (
            <img
              className="tool-preview"
              src={artifactUrl}
              alt={t("toolSession.generatedAlt", { tool })}
            />
          )}
          {(tool === "voiceover" || tool === "music") && currentProject && node.artifact_hash && (
            <Waveform
              projectId={currentProject.id}
              hash={node.artifact_hash}
              src={artifactUrl}
              ariaLabel={t("toolSession.audioAria", { tool })}
            />
          )}
          {tool === "clip" && (
            <video
              className="tool-preview"
              controls
              src={artifactUrl}
              aria-label={t("toolSession.clipPreview")}
            />
          )}
          {tool === "script" &&
            (screenplay ? (
              <ScriptTable
                screenplay={screenplay}
                targetS={targetS}
                hideTitle={
                  currentProject != null && titleAlreadySays(currentProject.title, screenplay.title)
                }
              />
            ) : (
              <div className="banner">{t("toolSession.loadingScript")}</div>
            ))}
          {takes.length > 0 && (
            <div className="takes-strip" role="group" aria-label={t("toolSession.takesAria")}>
              <span className="eyebrow">{t("toolSession.takes")}</span>
              {takes.map((take) => (
                <Tip
                  key={take.output_hash}
                  label={t("toolSession.seedChip", { seed: take.seed })}
                  // Whether clicking costs a render is the thing worth
                  // knowing, and it differs per take.
                  hint={t(
                    take.current
                      ? "toolSession.takeCurrentHint"
                      : take.available
                        ? "toolSession.takeSwapHint"
                        : "toolSession.takeRerenderHint",
                  )}
                  side="top"
                >
                  <button
                    className={`chip${take.current ? " active" : ""}`}
                    disabled={take.current}
                    onClick={() => void pickTake(take)}
                    aria-label={t(
                      take.current ? "toolSession.takeCurrentAria" : "toolSession.takeAria",
                      { seed: take.seed },
                    )}
                  >
                    {t("toolSession.seedChip", { seed: take.seed })}
                    {take.current && <small>{t("toolSession.takeCurrent")}</small>}
                    {/* An unavailable take re-renders on click; one that fell
                        off the recorded list is refused engine-side and the
                        reason lands in takeError below. */}
                    {!take.current && !take.available && (
                      <small>{t("toolSession.takeRerenders")}</small>
                    )}
                  </button>
                </Tip>
              ))}
            </div>
          )}
          {takeError && (
            <p className="hint error-text" role="alert">
              {takeError}
            </p>
          )}
          {/* The dock: the actions and the composer travel together.

              The composer used to do the sticking on its own, and a sticky
              box is lifted out of the flow it belongs to — so on a window
              short enough to scroll it was pulled up OVER the action row
              that flows just above it. At 1000x700 the four buttons ended
              up under the textarea: drawn where the layout put them, and
              answering no click, with "Turn into a video" — the whole
              point of a script session — invisible until you scrolled. A
              sticky box can only be trusted not to cover what it shares a
              sticky box WITH, so the two travel as one. */}
          <div className="tool-dock">
            {/* Every action here re-renders, records, or copies something
                somewhere else — the verb alone doesn't say what it costs or
                what it keeps, so each one carries its own explanation. */}
            <div className="tool-actions">
              <Tip label={t("common.download")} hint={t("toolSession.downloadHint")} side="top">
                <a className="btn-ghost" href={artifactUrl} download>
                  {t("common.download")}
                </a>
              </Tip>
              {tool === "script" && screenplay && (
                <Tip label={t("common.copy")} hint={t("toolSession.copyHint")} side="top">
                  <button className="btn-ghost" onClick={() => void copyScript()}>
                    {copied ? t("toolSession.copied") : t("common.copy")}
                  </button>
                </Tip>
              )}
              <Tip
                label={t("toolSession.regenerate")}
                hint={t("toolSession.regenerateHint")}
                side="top"
              >
                <button
                  className="btn-ghost"
                  onClick={() => void readinessGuard(() => void regenerate(node.node_id))}
                >
                  {t("toolSession.regenerate")}
                </button>
              </Tip>
              {tool === "image" && (
                <Tip label={t("toolSession.reroll")} hint={t("toolSession.rerollHint")} side="top">
                  <button
                    className="btn-ghost"
                    onClick={() =>
                      void readinessGuard(() =>
                        // A fresh seed, pinned in the same call — RegenerateBody.seed.
                        void regenerate(node.node_id, Math.floor(Math.random() * 2 ** 31)),
                      )
                    }
                  >
                    <Dices size={13} strokeWidth={1.8} aria-hidden="true" />
                    {t("toolSession.reroll")}
                  </button>
                </Tip>
              )}
              {tool === "music" && (
                <Tip label={t("toolSession.loopSeam")} hint={t("toolSession.loopSeamHint")} side="top">
                  <button
                    className="btn-ghost"
                    aria-label={t("toolSession.loopSeamAria")}
                    onClick={toggleSeam}
                  >
                    <Repeat size={13} strokeWidth={1.8} aria-hidden="true" />
                    {seamPlaying ? t("toolSession.loopSeamPlaying") : t("toolSession.loopSeam")}
                  </button>
                </Tip>
              )}
              {tool === "voiceover" && voices?.available && (
                <Tip label={t("voices.changeAria")} hint={t("voices.pickerSubtitle")} side="top">
                  <button
                    className="btn-ghost"
                    onClick={() => setVoiceOpen(true)}
                    aria-label={t("voices.changeAria")}
                  >
                    <AudioLines size={13} strokeWidth={1.8} aria-hidden="true" />
                    {t("voices.change")}
                  </button>
                </Tip>
              )}
              {tool === "voiceover" && (
                <Tip
                  label={t("toolSession.cloneVoiceTitle")}
                  hint={t("toolSession.cloneVoiceTipHint")}
                  side="top"
                >
                  <button
                    className="btn-ghost"
                    onClick={() => setCloneOpen(!cloneOpen)}
                    aria-expanded={cloneOpen}
                  >
                    <Mic size={13} strokeWidth={1.8} aria-hidden="true" />
                    {t("toolSession.cloneVoice")}
                  </button>
                </Tip>
              )}
              {tool !== "script" && (
                <span className="add-anchor">
                  <Tip
                    label={t("toolSession.addToProjectTitle")}
                    hint={t("toolSession.addToProjectHint")}
                    side="top"
                  >
                    <button
                      className="btn-ghost"
                      onClick={() => setAddOpen(!addOpen)}
                      aria-expanded={addOpen}
                      aria-label={t("toolSession.addToProjectAria")}
                    >
                      <FolderPlus size={13} strokeWidth={1.8} aria-hidden="true" />
                      {t("toolSession.addToProject")}
                    </button>
                  </Tip>
                  {addOpen && (
                    <div className="menu-pop" role="menu" ref={fit} aria-label={t("toolSession.addToProjectTitle")}>
                      <span className="hint">{t("toolSession.addToProjectHint")}</span>
                      {targets.length === 0 && (
                        <span className="hint">{t("toolSession.addToProjectEmpty")}</span>
                      )}
                      {targets.map((project) => (
                        <button
                          key={project.id}
                          role="menuitem"
                          onClick={() => void addTo(project.id, project.title)}
                        >
                          {project.title}
                        </button>
                      ))}
                    </div>
                  )}
                </span>
              )}
              {tool === "script" && (
                <Tip
                  label={t("toolSession.turnIntoVideo")}
                  hint={t("toolSession.turnIntoVideoHint")}
                  side="top"
                >
                  <button
                    className="btn-primary"
                    onClick={() => void turnIntoVideo()}
                    disabled={promoting}
                  >
                    {promoting ? t("toolSession.creatingProject") : t("toolSession.turnIntoVideo")}
                  </button>
                </Tip>
              )}
            </div>
            {addResult && (
              <p className="hint" role="status">
                {addResult}
              </p>
            )}
            {voiceOpen && voices && (
              <VoicePicker
                voices={voices}
                value={typeof params.voice_id === "string" ? params.voice_id : null}
                onPick={async (voiceId) => {
                  setVoiceOpen(false);
                  // A pick re-renders: the voice is part of the node's hash,
                  // so the artifact on screen is not what this now asks for.
                  setVoiceError(await setVoice(node.node_id, voiceId));
                }}
                onClose={() => setVoiceOpen(false)}
              />
            )}
            {voiceError && (
              <div className="banner error" role="status">
                {voiceError}
              </div>
            )}
            {cloneOpen && tool === "voiceover" && (
              <div className="clone-panel">
                <b>{t("toolSession.cloneVoiceTitle")}</b>
                <span className="hint">{t("toolSession.cloneVoiceHint")}</span>
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={cloneConsent}
                    onChange={(event) => setCloneConsent(event.target.checked)}
                  />
                  {t("toolSession.cloneConsent")}
                </label>
                <input
                  ref={cloneFileRef}
                  type="file"
                  accept="audio/wav,audio/mpeg,audio/flac,audio/mp4"
                  style={{ display: "none" }}
                  aria-label={t("toolSession.cloneUploadAria")}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void cloneFrom(file);
                  }}
                />
                <button
                  className="btn-ghost"
                  disabled={!cloneConsent}
                  onClick={() => cloneFileRef.current?.click()}
                >
                  {t("toolSession.cloneUpload")}
                </button>
              </div>
            )}
            {cloneResult && (
              <p className="hint" role="status">
                {cloneResult}
              </p>
            )}
            {/* The composer: the session's one "change it" surface, stuck to
                the bottom the way an editor's input is, wearing the same
                prompt-box dress as Home's. Script sessions take free-form
                notes (the LLM rewrite); every other tool holds an editable
                working copy of its own prompt/text/brief, sent back through
                /patch as update-and-re-render. */}
            <div className="prompt-box tool-composer">
              {tool === "script" ? (
                <textarea
                  value={notes}
                  placeholder={t("toolSession.enhancePlaceholder")}
                  aria-label={t("toolSession.enhanceAria")}
                  onChange={(event) => setNotes(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                      void sendEnhance();
                  }}
                />
              ) : (
                <textarea
                  value={refineDraft}
                  placeholder={t("toolSession.refinePlaceholder")}
                  aria-label={t("toolSession.refineAria")}
                  onChange={(event) => setRefineDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                      void sendRefine();
                  }}
                />
              )}
              <div className="row">
                <div className="spacer" />
                {/* The same readiness popover Home's box carries — opening
                    up so the bottom-docked card never clips it. */}
                <ModelsPopover opens="up" />
                {tool === "script" ? (
                  <button
                    className="btn-primary"
                    onClick={() => void sendEnhance()}
                    disabled={enhancing || !notes.trim()}
                  >
                    {enhancing ? t("toolSession.enhancing") : t("toolSession.enhance")}
                  </button>
                ) : (
                  <button
                    className="btn-primary"
                    onClick={() => void sendRefine()}
                    disabled={refining || !refineDraft.trim() || refineDraft.trim() === recipe}
                  >
                    {refining ? t("toolSession.updating") : t("toolSession.updateRerender")}
                  </button>
                )}
              </div>
              {refineError && (
                <p className="hint error-text" role="alert">
                  {refineError}
                </p>
              )}
            </div>
          </div>
          {(actionError?.scope === "promote" || actionError?.scope === "enhance") && (
            <p className="hint error-text" role="alert">
              {actionError.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
