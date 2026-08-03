import {
  ArrowDownToLine,
  Clapperboard,
  FileText,
  Film,
  Info,
  Loader2,
  MoreHorizontal,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dropdown } from "../components/Dropdown";
import { ModelsPopover } from "../components/ModelsPopover";
import { Tip } from "../components/Tooltip";
import type { Job, LlmModels, Project, ToolKind } from "../api/types";
import { m, plural, t } from "../i18n";
import { FOCUS_PROMPT_EVENT } from "../components/Palette";
import { DurationPicker } from "../components/DurationPicker";
import { ASPECTS } from "../lib/formats";
import { newestJob } from "../lib/jobs";
import { shortcutLabel } from "../lib/platform";
import { relativeTime, shortDuration } from "../lib/time";
import { TOOL_ICONS, TOOL_KINDS, isToolSession, toolKindOf } from "../lib/tools";
import { displayModelName, formatSize } from "../components/ModelLibrary";
import { useApp } from "../store";

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

type SortKey = "recent" | "created" | "name";

type TileStatus = "generating" | "failed" | "ready" | "final" | "draft";

// Re-exported: App and this screen's own tests have always reached for them
// here, and the palette now takes them from lib/tools directly.
export { isToolSession, toolKindOf };

/** The rail lists only the most recent few sessions; its overflow row asks
 * Home to reveal the whole list. Home may not be mounted when the ask is
 * made (the row is reachable from inside a project), so the request is also
 * left as a flag for Home's next mount to pick up — otherwise the click
 * lands at the top of Home and the user is back to scrolling for it. */
export const TOOL_HISTORY_EVENT = "localcut:reveal-tool-history";
let revealPending = false;
export function revealToolHistory() {
  revealPending = true;
  window.dispatchEvent(new Event(TOOL_HISTORY_EVENT));
}

/** Tile status from the global queue: active work wins, then a trailing
 * failure, then a finished output, else draft. Shared with the rail's
 * open-project tabs and history rows so every status dot agrees.
 *
 * A quick tool has no export stage — `tool_graph` names its terminal node
 * for the tool itself — so the export rule below never matched and every
 * finished one-off read "Draft" beside its own download link. Tool sessions
 * settle at "ready" rather than "final": "Final" is a claim about a cut, and
 * a voiceover is not a cut. */
export function tileStatus(project: Project, allJobs: Job[]): TileStatus {
  const jobs = allJobs.filter((job) => job.project_id === project.id);
  if (jobs.some((job) => job.status === "queued" || job.status === "rendering")) {
    return "generating";
  }
  const newest = newestJob(jobs);
  if (newest?.status === "failed") return "failed";
  if (isToolSession(project)) {
    // The engine's record, and ONLY that. Two reasons it beats the job list.
    //
    // Reach: `allJobs` is the newest 200 rows across ALL projects, so an old
    // session's rows have aged out behind a couple of full renders — and
    // history is made of exactly those old sessions.
    //
    // Meaning: a DONE row is not the same claim as "there is an artifact".
    // The engine derives this field through the trusted artifact cache, so a
    // placeholder rendered by a fallback tier and since distrusted has no
    // hash here while its DONE row is still in the window. Reading the row
    // would paint a green "Ready" tile that opens on a queued session with
    // nothing to download — two sources disagreeing, which is the whole
    // thing this field exists to stop.
    return project.tool_artifact_hash ? "ready" : "draft";
  }
  if (jobs.some((job) => job.spec.node_id === "export" && job.status === "done")) return "final";
  return "draft";
}

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
    actionError,
  } = useApp();
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [missingModel, setMissingModel] = useState<{ task: string; size: number } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toolSectionRef = useRef<HTMLDivElement>(null);

  const { prompt, tool, toolInput, voice, motion, scriptModel } = homeDraft;
  const { aspect, duration, mode } = defaults;
  const activeTool = TOOLS.find((entry) => entry.kind === tool) ?? null;
  const toolCopy = activeTool ? m().tools[activeTool.kind] : null;

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

  // The context menu closes on any press outside its own tile.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(`[data-project="${menuFor}"]`)) {
        setMenuFor(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor]);


  // The rail's "all outputs" row, whether Home was already mounted (event)
  // or is mounting because of the click that asked (flag).
  useEffect(() => {
    const reveal = () => {
      revealPending = false;
      toolSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener(TOOL_HISTORY_EVENT, reveal);
    // Cancelled on unmount: left to run after Home has gone, it clears the
    // flag against a null ref, consuming the request without scrolling so a
    // later mount never honours it.
    const frame = revealPending ? requestAnimationFrame(reveal) : 0;
    return () => {
      window.removeEventListener(TOOL_HISTORY_EVENT, reveal);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

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

  // "/" focuses search when no field owns the keyboard (review 4 §H4).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      // Home stays mounted under the Settings overlay; don't steal "/" (and
      // focus a hidden search box behind it) while Settings is open, or when
      // there's no search box to focus.
      if (useApp.getState().settingsOpen || !searchRef.current) return;
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
        return;
      event.preventDefault();
      searchRef.current.focus();
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

  // FR1 readiness note: a missing recommended model for a downloadable task.
  const checkReadiness = () => {
    for (const rec of system?.recommendations ?? []) {
      if (!rec.model || rec.model.files.length === 0) continue;
      const row = models.find((entry) => entry.id === rec.model?.id);
      if (row && !row.downloaded && !row.downloading) {
        setMissingModel({ task: rec.task, size: row.size_bytes });
        return;
      }
    }
    setMissingModel(null);
  };

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    checkReadiness();
    setBusy(true);
    try {
      await createFromPrompt(prompt.trim(), duration, aspect, mode);
      if (!useApp.getState().actionError) setHomeDraft({ prompt: "" });
    } finally {
      setBusy(false);
    }
  };

  const runTool = async () => {
    if (!tool || !toolInput.trim() || busy) return;
    // No checkReadiness() here: the missing-model banner only renders in the
    // video prompt box, so setting it from a tool run just leaks a stale note
    // into the prompt box after the tool closes.
    setBusy(true);
    const effectiveVoice = voice.trim() || defaults.voice.trim();
    try {
      await createTool(tool, {
        ...(tool === "voiceover"
          ? { text: toolInput.trim(), ...(effectiveVoice ? { voice: effectiveVoice } : {}) }
          : { prompt: toolInput.trim() }),
        ...(tool === "clip" && motion.trim() ? { motion: motion.trim() } : {}),
        // Only an explicit pick travels — "" lets the engine default apply.
        ...(tool === "script" && scriptModel ? { model: scriptModel } : {}),
      });
      if (!useApp.getState().actionError) setHomeDraft({ toolInput: "" });
    } finally {
      setBusy(false);
    }
  };

  const startRename = (project: Project) => {
    setMenuFor(null);
    setRenaming(project.id);
    setRenameDraft(project.title);
  };

  const commitRename = async (id: string) => {
    const title = renameDraft.trim();
    setRenaming(null);
    if (!title) return;
    const error = await renameProject(id, title);
    setLifecycleError(error);
  };

  const real = projects.filter((project) => !project.mode.startsWith("tool:"));
  // Sorted the same way the rail's history is (last activity first). The
  // rail's overflow row scrolls the user straight to this list, and the two
  // reading in different orders makes it look like a different list.
  const toolSessions = useMemo(
    () =>
      [...projects.filter(isToolSession)].sort(
        (a, b) => (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at),
      ),
    [projects],
  );
  // Gate on the grid this controls (real projects, not tool sessions), and keep
  // the controls visible whenever a query is active — otherwise deleting down to
  // ≤6 unmounts the search box while `search` still filters the grid, hiding
  // projects with no visible way to clear the query.
  const showLibraryControls = real.length > 6 || search.trim().length > 0;

  const visibleReal = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? real.filter((project) => project.title.toLowerCase().includes(q))
      : real;
    const stamp = (p: Project) => p.updated_at ?? p.created_at;
    return [...filtered].sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title)
        : sort === "created"
          ? b.created_at - a.created_at
          : stamp(b) - stamp(a),
    );
  }, [real, search, sort]);

  const renderTile = (project: Project) => {
    const toolKind = toolKindOf(project);
    const status = tileStatus(project, allJobs);
    const client = useApp.getState().client;
    const thumbUrl =
      project.thumb_hash && client ? client.artifactUrl(project.id, project.thumb_hash) : null;
    const ToolIcon = toolKind
      ? (TOOLS.find((entry) => entry.kind === toolKind)?.icon ?? Film)
      : null;
    const meta = `${t(`home.status.${status}`)} · ${relativeTime(
      project.updated_at ?? project.created_at,
    )}`;
    const body = (
      <div className="tile-body">
        <div className="title">{project.title}</div>
        <div className="meta">
          <i className={`dot ${status}`} aria-hidden="true" />
          {meta}
        </div>
      </div>
    );
    return (
      <div
        key={project.id}
        className="project-tile"
        data-project={project.id}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuFor(menuFor === project.id ? null : project.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "F2" && renaming !== project.id) {
            event.preventDefault();
            startRename(project);
          }
        }}
      >
        <button
          className="tile-open"
          onClick={() => void openProject(project.id)}
          aria-label={t("home.openProjectAria", { title: project.title })}
        >
          <div className="tile-thumb">
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                loading="lazy"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            ) : ToolIcon ? (
              <ToolIcon {...ICON_ILLUSTRATIVE} aria-hidden="true" />
            ) : (
              <Clapperboard {...ICON_ILLUSTRATIVE} aria-hidden="true" />
            )}
            {toolKind && <span className="tile-tool">{m().tools[toolKind].label}</span>}
            {!isToolSession(project) && project.duration_s != null && project.duration_s > 0 && (
              <span className="tile-dur">{shortDuration(project.duration_s)}</span>
            )}
          </div>
          {renaming !== project.id && body}
        </button>
        {renaming === project.id && (
          <div className="tile-body">
            <input
              className="tile-rename"
              value={renameDraft}
              autoFocus
              aria-label={t("home.renameAria", { title: project.title })}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") void commitRename(project.id);
                if (event.key === "Escape") setRenaming(null);
              }}
              onBlur={() => void commitRename(project.id)}
            />
          </div>
        )}
        <button
          className="tile-kebab"
          aria-label={t("home.tileMenuAria", { title: project.title })}
          aria-expanded={menuFor === project.id}
          onClick={(event) => {
            event.stopPropagation();
            setMenuFor(menuFor === project.id ? null : project.id);
          }}
        >
          <MoreHorizontal {...ICON_CONTROL} />
        </button>
        {menuFor === project.id && (
          <div className="menu-pop" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setMenuFor(null);
                void openProject(project.id);
              }}
            >
              {t("common.open")}
            </button>
            <button role="menuitem" onClick={() => startRename(project)}>
              {t("common.rename")}
              <small>{shortcutLabel(t("common.keys.rename"))}</small>
            </button>
            <button
              role="menuitem"
              onClick={async () => {
                setMenuFor(null);
                setLifecycleError(await duplicateProject(project.id));
              }}
            >
              {t("common.duplicate")}
            </button>
            <div className="rule" aria-hidden="true" />
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenuFor(null);
                setConfirmDelete(project);
              }}
            >
              {t("common.delete")}
            </button>
          </div>
        )}
      </div>
    );
  };

  // Model downloads still running after first-run → the bridge strip (FR1).
  const downloading = models.filter((row) => row.downloading);
  const [stripDismissed, setStripDismissed] = useState(
    () => localStorage.getItem("localcut.home.dlStripDismissed") === "1",
  );
  let dlDone = 0;
  let dlTotal = 0;
  for (const row of downloading) {
    dlDone += row.progress?.done ?? 0;
    dlTotal += row.progress && row.progress.total > 0 ? row.progress.total : row.size_bytes;
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
            <Dropdown
              value={aspect}
              onChange={(value) => setDefaults({ aspect: value })}
              ariaLabel={t("home.aspectAria")}
              options={ASPECTS.map((entry) => ({
                value: entry.value,
                label: `${entry.value} · ${m().aspects[entry.key]}`,
                icon: entry.icon,
              }))}
            />
            <DurationPicker
              value={duration}
              onChange={(value) => setDefaults({ duration: value })}
              ariaLabel={t("home.durationAria")}
            />
            <div className="seg-toggle" role="group" aria-label={t("home.modeAria")}>
              <button
                className={mode === "prompt" ? "active" : ""}
                onClick={() => setDefaults({ mode: "prompt" })}
                title={t("home.modeAutoTitle")}
              >
                {t("home.modeAuto")}
              </button>
              <button
                className={mode === "beginner" ? "active" : ""}
                onClick={() => setDefaults({ mode: "beginner" })}
                title={t("home.modeReviewTitle")}
              >
                {t("home.modeReview")}
              </button>
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
          {missingModel && (
            <p className="hint" role="alert">
              {t("home.modelMissing", {
                task:
                  (m().models.taskLabels as Record<string, string>)[missingModel.task] ??
                  missingModel.task,
                size: formatSize(missingModel.size),
              })}{" "}
              <button className="link" onClick={() => openSettings("models")}>
                {t("home.getIt")}
              </button>
            </p>
          )}
        </div>
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
              onClick={() => setHomeDraft({ tool: null })}
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
          <div className="row">
            {activeTool.kind === "voiceover" && (
              <>
                <input
                  placeholder={defaults.voice.trim() || t("home.voicePlaceholder")}
                  title={defaults.voice.trim() || t("home.voicePlaceholder")}
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
              </>
            )}
            {activeTool.kind === "script" && scriptModels && (
              <Dropdown
                value={scriptModel || scriptModels.default}
                onChange={(value) =>
                  setHomeDraft({ scriptModel: value === scriptModels.default ? "" : value })
                }
                ariaLabel={t("home.scriptModelAria")}
                options={[...new Set([scriptModels.default, ...scriptModels.models])].map(
                  (name) => ({
                    value: name,
                    label:
                      name === scriptModels.default ? t("home.defaultModel", { name }) : name,
                  }),
                )}
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
        </div>
      )}

      {downloading.length > 0 && !stripDismissed && (
        <div className="dl-strip" role="status">
          <ArrowDownToLine {...ICON_CONTROL} aria-hidden="true" />
          <div className="grow">
            {plural("home.dlStrip", downloading.length, {
              size: formatSize(Math.max(0, dlTotal - dlDone)),
            })}
            <div
              className="dl-bar"
              role="progressbar"
              aria-valuenow={dlTotal > 0 ? Math.round((dlDone / dlTotal) * 100) : 0}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="dl-bar-fill"
                style={{ width: `${dlTotal > 0 ? (dlDone / dlTotal) * 100 : 0}%` }}
              />
            </div>
          </div>
          <button className="btn-ghost" onClick={() => openSettings("models")}>
            {t("home.viewModels")}
          </button>
          <button
            className="icon-btn-sm"
            aria-label={t("common.dismiss")}
            onClick={() => {
              localStorage.setItem("localcut.home.dlStripDismissed", "1");
              setStripDismissed(true);
            }}
          >
            <X size={13} strokeWidth={2} />
          </button>
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
                onClick={() =>
                  setHomeDraft({
                    tool: tool === entry.kind ? null : entry.kind,
                    toolInput: "",
                  })
                }
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
          tool outputs here took away the templates that get them started. */}
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
                  setHomeDraft({ tool: null, prompt: template.scaffold });
                  setDefaults({ aspect: template.aspect, duration: template.duration });
                  requestAnimationFrame(() => promptRef.current?.focus());
                }}
              >
                <Sparkles size={12} strokeWidth={1.8} aria-hidden="true" />
                {template.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {real.length > 0 && (
        <div className="recent">
          <div className="recent-head">
            <h2>{t("home.projectsEyebrow")}</h2>
            <span className="count">· {real.length}</span>
            <span className="spacer" />
            {showLibraryControls && (
              <>
                <span className="recent-search">
                  <Search size={13} strokeWidth={1.8} aria-hidden="true" />
                  <input
                    ref={searchRef}
                    value={search}
                    placeholder={t("home.searchPlaceholder")}
                    aria-label={t("home.searchAria")}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setSearch("");
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </span>
                <Dropdown
                  value={sort}
                  onChange={setSort}
                  ariaLabel={t("home.sortAria")}
                  options={[
                    { value: "recent", label: t("home.sortRecent") },
                    { value: "created", label: t("home.sortCreated") },
                    { value: "name", label: t("home.sortName") },
                  ]}
                />
              </>
            )}
          </div>
          {visibleReal.length > 0 ? (
            <div className="grid">{visibleReal.map(renderTile)}</div>
          ) : (
            <p className="no-match">{t("home.noMatch", { q: search.trim() })}</p>
          )}
          {lifecycleError && (
            <p className="hint error-text" role="alert">
              {lifecycleError}
            </p>
          )}
        </div>
      )}

      {toolSessions.length > 0 && (
        <div className="recent" ref={toolSectionRef}>
          <div className="recent-head">
            <h2>{t("home.toolOutputs")}</h2>
            <span className="count">· {toolSessions.length}</span>
          </div>
          <div className="grid">{toolSessions.map(renderTile)}</div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          // A one-off output is not a project: promising to cancel running
          // jobs and remove "all generated media" overstates what is at
          // stake and makes deleting a stray thumbnail feel unsafe.
          title={t(
            toolKindOf(confirmDelete) ? "home.deleteToolTitle" : "home.deleteTitle",
            { title: confirmDelete.title },
          )}
          message={t(
            toolKindOf(confirmDelete) ? "home.deleteToolMessage" : "home.deleteMessage",
          )}
          confirmLabel={t(
            toolKindOf(confirmDelete) ? "home.deleteToolConfirm" : "home.deleteConfirm",
          )}
          danger
          onConfirm={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            void deleteProject(target.id).then(setLifecycleError);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
