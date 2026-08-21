import {
  ChevronRight,
  Clapperboard,
  FileText,
  ImagePlus,
  Info,
  LayoutTemplate,
  Loader2,
  Play,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "../components/Alert";
import { Dropdown } from "../components/Dropdown";
import { ProjectTile, useTileLifecycle } from "../components/ProjectTile";
import { StageSummaryRow } from "../components/StageSummaryRow";
import { StartFromTemplateDialog } from "../components/TemplateDialogs";
import { ModelsPopover } from "../components/ModelsPopover";
import { Tip } from "../components/Tooltip";
import type { Job, LlmModels, Project, ToolKind } from "../api/types";
import { m, plural, t } from "../i18n";
import { FOCUS_PROMPT_EVENT } from "../components/Palette";
import { DurationPicker } from "../components/DurationPicker";
import { ASPECTS, TOOL_CLIP_SECONDS } from "../lib/formats";
import { shortcutLabel } from "../lib/platform";
import { readyStages, stageRows } from "../lib/stages";
import { STYLE_PRESETS } from "../lib/styles";
import { tileStatus } from "../lib/tiles";
import {
  MOTION_PRESETS,
  SCRIPT_PRESETS,
  TOOL_ENGINE_KINDS,
  TOOL_ICONS,
  TOOL_KINDS,
  VOICE_SWATCHES,
  isToolSession,
} from "../lib/tools";
import { displayModelName, formatSize } from "../components/ModelLibrary";
import { describeGap, useReadinessGuard } from "../components/Readiness";
import { blockingGaps, distinctGaps } from "../lib/readiness";

/** The engine kinds a full video renders. Everything but the thumbnail,
 * which only the publish kit and the thumbnail tool ever build — warning
 * about a thumbnail model before a video is a warning about nothing.
 * Mirrors readiness.PIPELINE_KINDS, compared by test_ui_contract. */
const VIDEO_KINDS = [
  "script",
  "keyframe",
  "clip",
  "narration",
  "captions",
  "music",
  "timeline",
  "export",
];
import { useVoices } from "../lib/useVoices";
import { VoicePicker } from "../components/VoicePicker";
import { EMPTY_TOOL_OPTIONS, useApp } from "../store";

/** The bundled 2-second samples the voice swatches play. Resolved at build
 * time by Vite; keyed by the kokoro speaker each swatch's brief picks. */
const VOICE_SAMPLES: Record<string, string> = Object.fromEntries(
  VOICE_SWATCHES.map((swatch) => [
    swatch.voice,
    new URL(`../assets/voices/${swatch.voice}.wav`, import.meta.url).href,
  ]),
);

/* one three-step icon scale (review 4 §S10) */
const ICON_CONTROL = { size: 15, strokeWidth: 1.8 } as const;
const ICON_FEATURE = { size: 17, strokeWidth: 1.8 } as const;
const ICON_ILLUSTRATIVE = { size: 22, strokeWidth: 1.5 } as const;

/* stable ids + icons only — display copy resolves from the catalog. Both
   come from lib/tools so this screen and the palette cannot disagree about
   which tools this build has; a kind added to the wire type without an icon
   is a compile error there. */
const TOOLS: { kind: ToolKind; icon: typeof FileText }[] = TOOL_KINDS.map((kind) => ({
  kind,
  icon: TOOL_ICONS[kind],
}));

/** Home: one prompt surface — the video prompt, or the active quick tool's
 * panel in its place (never both) — plus the Quick Tools row and a real
 * project browser (review 4): search/sort, status dots, context menus. */
export function Home() {
  const {
    projects,
    allJobs,
    models,
    system,
    defaults,
    setDefaults,
    homeDraft,
    setHomeDraft,
    createFromPrompt,
    createTool,
    openProject,
    deleteProject,
    renameProject,
    duplicateProject,
    openSettings,
    openLibrary,
    actionError,
    dismissActionError,
    readiness,
  } = useApp();
  const [busy, setBusy] = useState(false);
  const [startTemplate, setStartTemplate] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const tiles = useTileLifecycle();
  const { guard, dialog: readinessDialog } = useReadinessGuard("home");

  const {
    prompt,
    tool,
    toolInput,
    voice,
    voiceId,
    motion,
    scriptModel,
    toolAspect,
    toolDuration,
    clipSeconds,
  } = homeDraft;
  // This video's choices, falling back to the saved baseline. `??` and not
  // `||`: a duration of 0 would never reach the engine, but neither should a
  // legitimate falsy override be mistaken for "unset".
  const aspect = homeDraft.aspect ?? defaults.aspect;
  const duration = homeDraft.duration ?? defaults.duration;
  const style = homeDraft.style ?? defaults.style;
  const mode = homeDraft.mode ?? defaults.mode;
  const activeTool = TOOLS.find((entry) => entry.kind === tool) ?? null;
  const toolCopy = activeTool ? m().tools[activeTool.kind] : null;
  // The clip's optional conditioning image. Component state, not the
  // persisted draft: a File does not survive JSON, and a stale path
  // silently uploading the wrong image is worse than re-picking it.
  const [startFrame, setStartFrame] = useState<File | null>(null);
  const startFrameRef = useRef<HTMLInputElement>(null);
  // The one swatch audio element — starting a second sample stops the
  // first, so two speakers never talk over each other. `swatchPlaying`
  // mirrors it into render state so the active swatch shows a stop
  // affordance instead of a play icon that no longer tells the truth.
  const swatchAudioRef = useRef<HTMLAudioElement | null>(null);
  const [swatchPlaying, setSwatchPlaying] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voices = useVoices(tool === "voiceover");
  const playSwatch = (swatchVoice: string) => {
    swatchAudioRef.current?.pause();
    if (swatchPlaying === swatchVoice) {
      setSwatchPlaying(null);
      return;
    }
    const audio = new Audio(VOICE_SAMPLES[swatchVoice]);
    swatchAudioRef.current = audio;
    audio.addEventListener("ended", () => setSwatchPlaying(null));
    setSwatchPlaying(swatchVoice);
    // play() returns undefined in environments without media (jsdom).
    const request = audio.play();
    if (request)
      void request.catch(() => {
        /* autoplay policy or a missing device — the swatch still selects */
        setSwatchPlaying(null);
      });
  };
  useEffect(() => () => swatchAudioRef.current?.pause(), []);

  // The script tool's model pick — fetched when the panel opens, so the
  // list is what the LLM server has installed *now*. null = no picker
  // (server down, or scripts route to another backend) and the engine
  // default silently applies, exactly as before.
  const [scriptModels, setScriptModels] = useState<LlmModels | null>(null);
  useEffect(() => {
    if (tool !== "script") return;
    let stale = false;
    useApp
      .getState()
      .client?.llmModels()
      .then((result) => {
        if (!stale) setScriptModels(result.available ? result : null);
      })
      .catch(() => {
        if (!stale) setScriptModels(null);
      });
    return () => {
      stale = true;
    };
  }, [tool]);

  // Coming back to Home re-mounts it (App swaps it out while a project is
  // open), and the WS refreshes the home read model only on OFF-project
  // lifecycle edges — a render left running in the project just closed emits
  // nothing but progress ticks for minutes at a time. Without this refetch
  // the tiles and the tray's engine-wide queue show the world as it was when
  // Home last happened to refresh.
  useEffect(() => {
    void useApp
      .getState()
      .refreshHome()
      .catch((err) => console.warn("home refresh failed:", err));
  }, []);

  // "/" searches the library — Home has no box of its own to focus now, and
  // a shelf of four tiles is not what anyone is searching (review v5, Q3).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      if (useApp.getState().settingsOpen) return;
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
        return;
      event.preventDefault();
      useApp.getState().openLibrary({ focusSearch: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The palette's "New video" lands here and hands the prompt focus; the
  // first landing after first-run autofocuses too (review 4 §FR1).
  useEffect(() => {
    const focus = () => promptRef.current?.focus();
    window.addEventListener(FOCUS_PROMPT_EVENT, focus);
    if (!homeDraft.prompt && !homeDraft.tool) focus();
    return () => window.removeEventListener(FOCUS_PROMPT_EVENT, focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The readiness facts, standing — not a snapshot taken after a click.
  // The prompt box notes the first gap a VIDEO would hit; a tool panel
  // notes only the kinds that tool renders. Both read the same engine
  // report the workspace banner and the gate dialog read.
  // `blockingGaps`, not `noteworthyGaps`: this note is standing, and the
  // still-clip tier is how a low-VRAM machine normally works — a permanent
  // alert about the normal path is the thing the banner/gate split exists
  // to avoid. Filtered to the surface's kinds BEFORE deduping, or the
  // thumbnail panel loses its only line to the keyframe row that shares
  // its task.
  const gapsFor = (kinds: string[]) =>
    distinctGaps(blockingGaps(readiness).filter((row) => kinds.includes(row.kind)));
  const promptGap = gapsFor(VIDEO_KINDS)[0] ?? null;
  const toolGaps = tool ? gapsFor(TOOL_ENGINE_KINDS[tool]) : [];

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    // The gate holds the click when a needed model is missing — warned,
    // suppressible, never blocking ("Render anyway" always proceeds).
    // Scoped to what a video renders: a thumbnail model it will never
    // touch is not a reason to interrupt.
    await guard(async () => {
      setBusy(true);
      try {
        await createFromPrompt(prompt.trim(), duration, aspect, mode, style);
        // The whole composition goes, not just the words: the row described
        // THAT video, and leaving a look or a run mode behind aims the next
        // one without anyone choosing it. Back to the Settings baseline.
        if (!useApp.getState().actionError)
          setHomeDraft({ prompt: "", aspect: null, duration: null, style: null, mode: null });
      } finally {
        setBusy(false);
      }
    }, VIDEO_KINDS);
  };

  const runTool = async () => {
    if (!tool || !toolInput.trim() || busy) return;
    await guard(() => runToolNow(), TOOL_ENGINE_KINDS[tool]);
  };

  const runToolNow = async () => {
    if (!tool || !toolInput.trim() || busy) return;
    setBusy(true);
    const effectiveVoice = voice.trim() || defaults.voice.trim();
    // A number input does not stop a typed value from leaving its bounds.
    const seconds = Math.min(TOOL_CLIP_SECONDS.max, Math.max(TOOL_CLIP_SECONDS.min, clipSeconds));
    try {
      await createTool(
        tool,
        {
          ...(tool === "voiceover"
            ? {
                text: toolInput.trim(),
                ...(effectiveVoice ? { voice: effectiveVoice } : {}),
                // Only an explicit pick travels: absent leaves the node on
                // the hash a brief-only render used, where null would be a
                // third state neither the engine nor the cache knows.
                ...(voiceId ? { voice_id: voiceId } : {}),
              }
            : { prompt: toolInput.trim() }),
          ...(tool === "clip" && motion.trim() ? { motion: motion.trim() } : {}),
          ...(tool === "clip" ? { duration_s: seconds, aspect: toolAspect } : {}),
          ...(tool === "thumbnail" || tool === "image" ? { aspect: toolAspect } : {}),
          ...(tool === "script"
            ? { target_duration_s: toolDuration, aspect: toolAspect }
            : {}),
          ...(tool === "music" ? { target_duration_s: toolDuration } : {}),
          // Only an explicit pick travels — "" lets the engine default apply.
          ...(tool === "script" && scriptModel ? { model: scriptModel } : {}),
        },
        tool === "clip" ? (startFrame ?? undefined) : undefined,
      );
      if (!useApp.getState().actionError) {
        // Same rule as the video row above: the options described THAT run,
        // so they go back to their starting values with the text. Keeping
        // `tool` is the exception and deliberate — the panel you are looking
        // at is not a choice about the output, and closing it under you
        // after every run would be its own bug.
        setHomeDraft({
          toolInput: "",
          voice: "",
          voiceId: null,
          motion: "",
          scriptModel: "",
          toolAspect: EMPTY_TOOL_OPTIONS.toolAspect,
          toolDuration: EMPTY_TOOL_OPTIONS.toolDuration,
          clipSeconds: EMPTY_TOOL_OPTIONS.clipSeconds,
        });
        setStartFrame(null);
      }
    } finally {
      setBusy(false);
    }
  };

  /** A preset chip writes into the visible field rather than hiding state
   * in the request: motion replaces (chips are alternatives), script
   * appends (platform + tone stack). */
  const applyMotionPreset = (key: (typeof MOTION_PRESETS)[number]) =>
    setHomeDraft({ motion: m().home.motionPresets[key].text });
  const applyScriptPreset = (key: (typeof SCRIPT_PRESETS)[number]) => {
    const text = m().home.scriptPresets[key].text;
    if (toolInput.includes(text)) return;
    setHomeDraft({ toolInput: toolInput.trim() ? `${toolInput.trimEnd()}\n${text}` : text });
  };

  const real = projects.filter((project) => !isToolSession(project));
  // The Continue shelf: four, most recently touched first — videos AND tool
  // outputs. A one-off output is still work you might want back, and a
  // session whose tab you closed had no route home but the Library. Not a
  // browser, though: that is the Library, one click away at the end of this
  // row.
  const recent = useMemo(
    () =>
      [...projects]
        .sort((a, b) => (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at))
        .slice(0, 4),
    [projects],
  );
  // Setup hands over mid-download (FR1). The rows are the wizard's own; the
  // bytes are what the engine is still moving for THIS pipeline, so a model
  // downloaded from Settings for some other reason doesn't inflate them.
  const downloadStages = useMemo(() => stageRows(system, models), [system, models]);
  const dlReady = readyStages(downloadStages);
  // Only while bytes are actually moving: a stage nobody picked reads
  // "queued" forever, and gating on that would pin this strip to Home for
  // the life of the install.
  const downloading = models.some((row) => row.downloading);
  const [dlOpen, setDlOpen] = useState(false);
  let dlDone = 0;
  let dlTotal = 0;
  for (const stage of downloadStages) {
    const row = models.find((entry) => entry.id === stage.id);
    if (!row || row.files.length === 0) continue;
    dlTotal += row.size_bytes;
    dlDone += row.downloaded ? row.size_bytes : (row.progress?.done ?? 0);
  }

  return (
    <div className="home">
      <div className="home-header">
        <h1>{t("home.title")}</h1>
      </div>
      <p className="sub">{t("home.subtitle")}</p>

      {!activeTool && (
        <div className={`prompt-box${busy ? " committing" : ""}`}>
          <textarea
            ref={promptRef}
            placeholder={t("home.promptPlaceholder")}
            value={prompt}
            onChange={(event) => setHomeDraft({ prompt: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void generate();
            }}
            aria-label={t("home.promptAria")}
          />
          <div className="row">
            {/* Each chip shows its VALUE — "9:16 · Shorts", "Cinematic" —
                which says nothing about what the control decides. The bubble
                is where that lives; `side="bottom"` because this row sits
                near the top of Home and a top bubble is drawn off it. */}
            <Dropdown
              value={aspect}
              onChange={(value) => setHomeDraft({ aspect: value })}
              ariaLabel={t("home.aspectAria")}
              tip={t("home.aspectTip")}
              tipHint={t("home.aspectTipHint")}
              tipSide="bottom"
              options={ASPECTS.map((entry) => ({
                value: entry.value,
                label: `${entry.value} · ${m().aspects[entry.key]}`,
                icon: entry.icon,
              }))}
            />
            <DurationPicker
              value={duration}
              onChange={(value) => setHomeDraft({ duration: value })}
              ariaLabel={t("home.durationAria")}
              tip={t("home.durationTip")}
              tipHint={t("home.durationTipHint")}
              tipSide="bottom"
            />
            {/* The engine has taken style_preset since Phase 1 and defaulted
                it silently; this is the first surface that lets anyone say
                which look they wanted. */}
            <Dropdown
              value={style}
              onChange={(value) => setHomeDraft({ style: value })}
              ariaLabel={t("home.styleAria")}
              tip={t("home.styleTip")}
              tipHint={t("home.styleTipHint")}
              tipSide="bottom"
              options={STYLE_PRESETS.map((preset) => ({
                value: preset.id,
                label: (m().home.styles as Record<string, string>)[preset.id] ?? preset.id,
                // "Watercolor" is a word everyone knows and a look nobody can
                // picture the model's version of. The menu is where that is
                // worth a sentence — the chip has room for one word.
                hint: (m().home.styleHints as Record<string, string>)[preset.id],
                icon: preset.icon,
              }))}
            />
            {/* The app's bubble, not the browser's `title`: the same rule the
                rail follows, and these two sit beside three chips that now
                use it — one row speaking two ways is worse than either. */}
            <div className="seg-toggle" role="group" aria-label={t("home.modeAria")}>
              <Tip label={t("home.modeAuto")} hint={t("home.modeAutoTitle")} side="bottom">
                <button
                  className={mode === "prompt" ? "active" : ""}
                  onClick={() => setHomeDraft({ mode: "prompt" })}
                >
                  {t("home.modeAuto")}
                </button>
              </Tip>
              <Tip label={t("home.modeReview")} hint={t("home.modeReviewTitle")} side="bottom">
                <button
                  className={mode === "beginner" ? "active" : ""}
                  onClick={() => setHomeDraft({ mode: "beginner" })}
                >
                  {t("home.modeReview")}
                </button>
              </Tip>
            </div>
            <div className="spacer" />
            <ModelsPopover />
            <Tip label={t("common.generate")} shortcut={shortcutLabel(t("home.ctrlEnter"))} side="top">
              <button
                className="btn-primary"
                onClick={() => void generate()}
                disabled={busy || !prompt.trim()}
              >
                {busy ? (
                  <Loader2 size={14} strokeWidth={2} className="spin" />
                ) : (
                  <Sparkles size={14} strokeWidth={2} />
                )}
                {busy ? t("common.starting") : t("common.generate")}
              </button>
            </Tip>
          </div>
          {actionError?.scope === "create" && (
            <p className="hint error-text" role="alert">
              {actionError.message}
            </p>
          )}
          {/* `status`, not `alert`: this is standing copy, and an
              assertive live region re-announces it on every readiness
              refresh. Also gated on the SENTENCE — a reason code this
              build has no catalog entry for must render as nothing, not
              as an empty announcement with a link after it. */}
          {promptGap && describeGap(promptGap) && (
            <p className="hint" role="status">
              {describeGap(promptGap)}{" "}
              <button className="link" onClick={() => openSettings("models")}>
                {t("home.getIt")}
              </button>
            </p>
          )}
        </div>
      )}

      {!activeTool && (
        <button className="link from-template" onClick={() => setStartTemplate(true)}>
          <LayoutTemplate size={13} strokeWidth={1.8} aria-hidden="true" />
          {t("home.startTemplate")}
        </button>
      )}

      {activeTool && toolCopy && (
        <div className={`prompt-box tool-panel${busy ? " committing" : ""}`}>
          <div className="tool-head">
            <activeTool.icon {...ICON_CONTROL} />
            <b>{toolCopy.label}</b>
            <small>
              {toolCopy.tip} {t("home.toolHeadSuffix")}
            </small>
            <button
              className="icon-btn"
              onClick={() => {
                // The error belonged to this panel's attempt; a fresh
                // surface starts clean.
                if (actionError?.scope === "tool") dismissActionError();
                setHomeDraft({ tool: null });
              }}
              aria-label={t("home.closeToolAria")}
            >
              <X {...ICON_CONTROL} />
            </button>
          </div>
          <textarea
            placeholder={toolCopy.placeholder}
            value={toolInput}
            onChange={(event) => setHomeDraft({ toolInput: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void runTool();
            }}
            aria-label={
              activeTool.kind === "voiceover"
                ? t("home.voiceoverTextAria")
                : t("home.toolPromptAria", { label: toolCopy.label })
            }
            autoFocus
          />
          {/* A preset chip writes a whole SENTENCE into the box above it, and
              its one-word label says nothing about which. The bubble carries
              the text itself — the only honest preview of what a click does. */}
          {activeTool.kind === "script" && (
            <div className="chip-row" role="group" aria-label={t("home.scriptPresetsAria")}>
              {SCRIPT_PRESETS.map((key) => (
                <Tip
                  key={key}
                  label={m().home.scriptPresets[key].label}
                  hint={m().home.scriptPresets[key].text}
                  side="top"
                >
                  <button className="chip" onClick={() => applyScriptPreset(key)}>
                    {m().home.scriptPresets[key].label}
                  </button>
                </Tip>
              ))}
            </div>
          )}
          {activeTool.kind === "voiceover" && voiceOpen && voices && (
            <VoicePicker
              voices={voices}
              value={voiceId}
              onPick={(picked) => {
                // A pick outranks the brief, so clearing the brief with it
                // keeps the panel honest: one voice is chosen, one way.
                setHomeDraft(picked ? { voiceId: picked, voice: "" } : { voiceId: null });
                setVoiceOpen(false);
              }}
              onClose={() => setVoiceOpen(false)}
            />
          )}
          {activeTool.kind === "voiceover" && (
            <div className="voice-swatches" role="group" aria-label={t("home.voiceSwatchesAria")}>
              {VOICE_SWATCHES.map((swatch) => {
                const name = m().home.voiceNames[swatch.voice];
                return (
                  <span
                    key={swatch.voice}
                    className={`voice-swatch${voice.trim() === swatch.brief ? " active" : ""}`}
                  >
                    <button
                      className="swatch-play"
                      onClick={() => playSwatch(swatch.voice)}
                      aria-label={t(
                        swatchPlaying === swatch.voice
                          ? "home.voiceStopAria"
                          : "home.voicePlayAria",
                        { name },
                      )}
                    >
                      {swatchPlaying === swatch.voice ? (
                        <Square size={11} strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <Play size={11} strokeWidth={2} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      className="swatch-name"
                      // Clears the pick for the reason picking clears the
                      // brief: a picked voice outranks a brief at render, so
                      // leaving both would light this swatch up while another
                      // voice is what actually speaks.
                      onClick={() => setHomeDraft({ voice: swatch.brief, voiceId: null })}
                      aria-label={t("home.voiceSwatchAria", { name })}
                    >
                      {name}
                    </button>
                  </span>
                );
              })}
              {/* The five swatches are the fast path and keep their bundled
                  samples; the pack holds fifty-four, and the rest are one
                  press away rather than unreachable. */}
              {voices?.available && (
                <button className="swatch-more" onClick={() => setVoiceOpen(true)}>
                  {voiceId
                    ? t("voices.current", {
                        name: voices.voices.find((v) => v.id === voiceId)?.name ?? voiceId,
                      })
                    : t("voices.more", { count: voices.voices.length })}
                </button>
              )}
            </div>
          )}
          {activeTool.kind === "clip" && (
            <div className="chip-row" role="group" aria-label={t("home.motionPresetsAria")}>
              {MOTION_PRESETS.map((key) => (
                <Tip
                  key={key}
                  label={m().home.motionPresets[key].label}
                  hint={m().home.motionPresets[key].text}
                  side="top"
                >
                  <button
                    className={`chip${motion === m().home.motionPresets[key].text ? " active" : ""}`}
                    onClick={() => applyMotionPreset(key)}
                  >
                    {m().home.motionPresets[key].label}
                  </button>
                </Tip>
              ))}
            </div>
          )}
          <div className="row">
            {activeTool.kind === "voiceover" && (
              <>
                {/* No tooltip: it repeated the field's own placeholder, so it
                    said nothing the empty field had not already said and
                    nothing at all once the field was filled. The ⓘ beside it
                    carries the explanation. */}
                <input
                  placeholder={defaults.voice.trim() || t("home.voicePlaceholder")}
                  value={voice}
                  onChange={(event) => setHomeDraft({ voice: event.target.value })}
                  aria-label={t("home.voiceAria")}
                />
                <Tip label={t("home.voiceTipLabel")} hint={t("home.voiceTipHint")} side="top">
                  <span className="info-dot" tabIndex={0} aria-label={t("home.voiceInfoAria")}>
                    <Info size={13} strokeWidth={1.8} />
                  </span>
                </Tip>
              </>
            )}
            {activeTool.kind === "clip" && (
              <>
                <input
                  placeholder={t("home.motionPlaceholder")}
                  value={motion}
                  onChange={(event) => setHomeDraft({ motion: event.target.value })}
                  aria-label={t("home.motionAria")}
                />
                <Tip label={t("home.motionTipLabel")} hint={t("home.motionTipHint")} side="top">
                  <span className="info-dot" tabIndex={0} aria-label={t("home.motionInfoAria")}>
                    <Info size={13} strokeWidth={1.8} />
                  </span>
                </Tip>
                <Tip
                  label={t("home.clipSecondsTipLabel")}
                  hint={t("home.clipSecondsTipHint", TOOL_CLIP_SECONDS)}
                  side="top"
                >
                  <span className="seconds-field">
                    <input
                      type="number"
                      min={TOOL_CLIP_SECONDS.min}
                      max={TOOL_CLIP_SECONDS.max}
                      value={clipSeconds}
                      aria-label={t("home.clipSecondsAria")}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) setHomeDraft({ clipSeconds: value });
                      }}
                      onBlur={() =>
                        setHomeDraft({
                          clipSeconds: Math.min(
                            TOOL_CLIP_SECONDS.max,
                            Math.max(TOOL_CLIP_SECONDS.min, clipSeconds),
                          ),
                        })
                      }
                    />
                    <span aria-hidden="true">{t("home.clipSecondsUnit")}</span>
                  </span>
                </Tip>
                <input
                  ref={startFrameRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: "none" }}
                  aria-label={t("home.startFrameAria")}
                  onChange={(event) => setStartFrame(event.target.files?.[0] ?? null)}
                />
                {startFrame ? (
                  <span className="chip active start-frame">
                    {t("home.startFrameSet", { name: startFrame.name })}
                    <button
                      className="icon-btn"
                      onClick={() => {
                        setStartFrame(null);
                        if (startFrameRef.current) startFrameRef.current.value = "";
                      }}
                      aria-label={t("home.startFrameClearAria")}
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </span>
                ) : (
                  <Tip
                    label={t("home.startFrameTipLabel")}
                    hint={t("home.startFrameTipHint")}
                    side="top"
                  >
                    <button className="btn-ghost" onClick={() => startFrameRef.current?.click()}>
                      <ImagePlus size={13} strokeWidth={1.8} aria-hidden="true" />
                      {t("home.startFrame")}
                    </button>
                  </Tip>
                )}
              </>
            )}
            {activeTool.kind === "script" && scriptModels && (
              <Dropdown
                value={scriptModel || scriptModels.default}
                onChange={(value) =>
                  setHomeDraft({ scriptModel: value === scriptModels.default ? "" : value })
                }
                ariaLabel={t("home.scriptModelAria")}
                tip={t("home.scriptModelTip")}
                tipHint={t("home.scriptModelTipHint")}
                tipSide="top"
                options={[...new Set([scriptModels.default, ...scriptModels.models])].map(
                  (name) => ({
                    value: name,
                    label:
                      name === scriptModels.default ? t("home.defaultModel", { name }) : name,
                  }),
                )}
              />
            )}
            {(activeTool.kind === "script" || activeTool.kind === "music") && (
              <DurationPicker
                value={toolDuration}
                onChange={(value) => setHomeDraft({ toolDuration: value })}
                ariaLabel={t("home.toolDurationAria")}
                tip={t("home.toolDurationTip")}
                tipHint={t("home.toolDurationTipHint")}
                tipSide="top"
              />
            )}
            {(activeTool.kind === "script" ||
              activeTool.kind === "thumbnail" ||
              activeTool.kind === "image" ||
              activeTool.kind === "clip") && (
              <Dropdown
                value={toolAspect}
                onChange={(value) => setHomeDraft({ toolAspect: value })}
                ariaLabel={t("home.toolAspectAria")}
                tip={t("home.toolAspectTip")}
                tipHint={t("home.toolAspectTipHint")}
                tipSide="top"
                options={ASPECTS.map((entry) => ({
                  value: entry.value,
                  label: `${entry.value} · ${m().aspects[entry.key]}`,
                  icon: entry.icon,
                }))}
              />
            )}
            <div className="spacer" />
            <ModelsPopover />
            <Tip label={t("common.generate")} shortcut={shortcutLabel(t("home.ctrlEnter"))} side="top">
              <button
                className="btn-primary"
                onClick={() => void runTool()}
                disabled={busy || !toolInput.trim()}
              >
                {busy ? (
                  <Loader2 size={14} strokeWidth={2} className="spin" />
                ) : (
                  <Sparkles size={14} strokeWidth={2} />
                )}
                {busy
                  ? t("common.starting")
                  : t("home.generateTool", { tool: toolCopy.label.toLowerCase() })}
              </button>
            </Tip>
          </div>
          {actionError?.scope === "tool" && (
            <p className="hint error-text" role="alert">
              {actionError.message}
            </p>
          )}
          {toolGaps.length > 0 && describeGap(toolGaps[0]) && (
            <p className="hint" role="status">
              {describeGap(toolGaps[0])}{" "}
              <button className="link" onClick={() => openSettings("models")}>
                {t("home.getIt")}
              </button>
            </p>
          )}
        </div>
      )}
      {readinessDialog}

      {/* Setup hands over mid-download: the same per-stage rows the wizard's
          last step shows, behind one line so they never push the tools down
          the page while bytes move (design review v5, Q1). */}
      {downloading && (
        <div className={`dl-summary${dlOpen ? " open" : ""}`}>
          <button
            className="dl-summary-head"
            aria-expanded={dlOpen}
            aria-label={dlOpen ? t("home.dlCollapseAria") : t("home.dlExpandAria")}
            onClick={() => setDlOpen(!dlOpen)}
          >
            <ChevronRight {...ICON_CONTROL} className={dlOpen ? "caret open" : "caret"} />
            <span>
              {t("home.dlSummary", { ready: dlReady, total: downloadStages.length })}
            </span>
            <span
              className="dl-bar"
              role="progressbar"
              aria-valuenow={dlTotal > 0 ? Math.round((dlDone / dlTotal) * 100) : 0}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <i style={{ width: `${dlTotal > 0 ? (dlDone / dlTotal) * 100 : 0}%` }} />
            </span>
            <span className="bytes">
              {t("home.dlSummaryBytes", {
                done: formatSize(dlDone),
                total: formatSize(dlTotal),
              })}
            </span>
          </button>
          {dlOpen && (
            <div className="sumrail">
              {downloadStages.map((stage) => (
                <StageSummaryRow
                  key={stage.id}
                  stage={stage.stage}
                  name={stage.name}
                  id={stage.id}
                  status={stage.status}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="tools-head">
        <h3>{t("home.quickTools")}</h3>
        <span className="hint">{t("home.quickToolsHint")}</span>
      </div>
      <div className="quick-tools" role="group" aria-label={t("home.quickToolsAria")}>
        {TOOLS.map((entry) => {
          const Icon = entry.icon;
          const copy = m().tools[entry.kind];
          return (
            <Tip
              key={entry.kind}
              label={copy.tip}
              hint={t("home.noProjectHint")}
              side="bottom"
            >
              <button
                className={tool === entry.kind ? "active" : ""}
                onClick={() => {
                  // A stale panel error following the user from tool to
                  // tool implicates runs that never happened.
                  if (actionError?.scope === "tool") dismissActionError();
                  setHomeDraft({
                    tool: tool === entry.kind ? null : entry.kind,
                    toolInput: "",
                  });
                }}
                aria-label={t("home.toolButtonAria", { label: copy.label, tip: copy.tip })}
              >
                <span className="tool-well">
                  <Icon {...ICON_FEATURE} aria-hidden="true" />
                </span>
                <span className="tool-label">{copy.label}</span>
                <span className="tool-output">{copy.output}</span>
              </button>
            </Tip>
          );
        })}
      </div>

      {/* Gate on real projects, not the whole list: someone who has only
          used the quick tools has made no video yet, and counting their
          tool outputs here took away the templates that get them started.
          BELOW the quick tools: the empty state answers "where will my
          videos go", and pushing the tools off-screen to say so priced
          the app's second surface at its first-run moment. */}
      {real.length === 0 && (
        <div className="empty-state">
          <Clapperboard {...ICON_ILLUSTRATIVE} aria-hidden="true" />
          <b>{t("home.emptyTitle")}</b>
          <p>{t("home.emptyBody")}</p>
          <div className="templates">
            {m().home.templates.map((template) => (
              <button
                key={template.label}
                className="btn-ghost"
                onClick={() => {
                  // A template describes the video it scaffolds, so its
                  // format rides with that draft and leaves with it. It used
                  // to be written into the baseline, which meant picking
                  // "YouTube explainer" once aimed every later video at 16:9.
                  setHomeDraft({
                    tool: null,
                    prompt: template.scaffold,
                    aspect: template.aspect,
                    duration: template.duration,
                  });
                  requestAnimationFrame(() => promptRef.current?.focus());
                }}
              >
                {template.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* One shelf, four tiles: what you were last working on. Everything
          else — including every tool output — is one click away in the
          Library, which is where a browsing surface belongs (v5). */}
      {/* Same refusal, reported on the shelf that was clicked. */}
      {actionError?.scope === "open" && (
        <Alert message={actionError.message} onDismiss={dismissActionError} />
      )}

      {recent.length > 0 && (
        <div className="recent">
          <div className="recent-head">
            <h2>{t("home.continueEyebrow")}</h2>
            <span className="count">{t("home.continueCount", { count: recent.length })}</span>
            <span className="spacer" />
            <button className="link" onClick={() => openLibrary()}>
              {t("home.openLibrary")}
            </button>
          </div>
          <div className="grid">
            {recent.map((project) => (
              <ProjectTile
                key={project.id}
                project={project}
                status={tileStatus(project, allJobs)}
                actions={tiles.bind(project)}
              />
            ))}
          </div>
          {tiles.error && (
            <p className="hint error-text" role="alert">
              {tiles.error}
            </p>
          )}
        </div>
      )}

      {tiles.dialog}
      {startTemplate && <StartFromTemplateDialog onClose={() => setStartTemplate(false)} />}
    </div>
  );
}
