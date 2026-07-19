import {
  Aperture,
  ArrowDownToLine,
  Boxes,
  Clapperboard,
  FileText,
  Film,
  Image as ImageIcon,
  Info,
  Loader2,
  Mic,
  MoreHorizontal,
  Music,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dropdown } from "../components/Dropdown";
import { Tip } from "../components/Tooltip";
import type { Job, Project, ToolKind } from "../api/types";
import { m, plural, t } from "../i18n";
import { FOCUS_PROMPT_EVENT } from "../components/Palette";
import { ASPECTS, DURATIONS } from "../lib/formats";
import { relativeTime, shortDuration } from "../lib/time";
import { displayModelName, formatSize } from "../components/ModelLibrary";
import { useApp } from "../store";

/* one three-step icon scale (review 4 §S10) */
const ICON_CONTROL = { size: 15, strokeWidth: 1.8 } as const;
const ICON_FEATURE = { size: 17, strokeWidth: 1.8 } as const;
const ICON_ILLUSTRATIVE = { size: 22, strokeWidth: 1.5 } as const;

/* stable ids + icons only — display copy resolves from the catalog */
const TOOLS: { kind: ToolKind; icon: typeof FileText }[] = [
  { kind: "script", icon: FileText },
  { kind: "thumbnail", icon: ImageIcon },
  { kind: "voiceover", icon: Mic },
  { kind: "image", icon: Aperture },
  { kind: "music", icon: Music },
  { kind: "clip", icon: Film },
];

type SortKey = "recent" | "created" | "name";

type TileStatus = "generating" | "failed" | "final" | "draft";

/** Tile status from the global queue: active work wins, then a trailing
 * failure, then a finished export, else draft. */
function tileStatus(project: Project, allJobs: Job[]): TileStatus {
  const jobs = allJobs.filter((job) => job.project_id === project.id);
  if (jobs.some((job) => job.status === "queued" || job.status === "rendering")) {
    return "generating";
  }
  if (jobs.length > 0 && jobs[jobs.length - 1].status === "failed") return "failed";
  if (jobs.some((job) => job.spec.node_id === "export" && job.status === "done")) return "final";
  return "draft";
}

const toolKindOf = (project: Project): ToolKind | null =>
  project.mode.startsWith("tool:") ? (project.mode.slice(5) as ToolKind) : null;

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
  const [modelsPopOpen, setModelsPopOpen] = useState(false);
  const [missingModel, setMissingModel] = useState<{ task: string; size: number } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const modelsPopRef = useRef<HTMLDivElement>(null);

  const { prompt, tool, toolInput, voice, motion } = homeDraft;
  const { aspect, duration, mode } = defaults;
  const activeTool = TOOLS.find((entry) => entry.kind === tool) ?? null;
  const toolCopy = activeTool ? m().tools[activeTool.kind] : null;

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

  // The models popover closes on outside press too.
  useEffect(() => {
    if (!modelsPopOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!modelsPopRef.current?.contains(event.target as Node)) setModelsPopOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelsPopOpen]);

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
  const toolSessions = projects.filter((project) => project.mode.startsWith("tool:"));
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
            {!toolKind && project.duration_s != null && project.duration_s > 0 && (
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
              <small>F2</small>
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
            <Dropdown
              value={duration}
              onChange={(value) => setDefaults({ duration: value })}
              ariaLabel={t("home.durationAria")}
              options={DURATIONS.map((entry) => ({
                value: entry.value,
                label: m().durations[entry.key],
                icon: entry.icon,
              }))}
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
            <div className="models-pop-wrap" ref={modelsPopRef}>
              <Tip label={t("home.modelsTipLabel")} hint={t("home.modelsTipHint")} side="top">
                <button
                  className="icon-btn"
                  onClick={() => setModelsPopOpen(!modelsPopOpen)}
                  aria-label={t("home.modelsAria")}
                  aria-expanded={modelsPopOpen}
                >
                  <Boxes {...ICON_CONTROL} />
                </button>
              </Tip>
              {modelsPopOpen && (
                <div className="menu-pop" role="menu">
                  <div className="menu-label">{t("home.modelsPopTitle")}</div>
                  {(system?.recommendations ?? []).map((rec) => {
                    const row = rec.model
                      ? models.find((entry) => entry.id === rec.model?.id)
                      : null;
                    const ready = row?.downloaded || (rec.model?.files.length ?? 1) === 0;
                    return (
                      <div key={rec.task} className="models-pop-row">
                        <span className="grow">
                          {(m().models.taskLabels as Record<string, string>)[rec.task] ??
                            rec.task}
                        </span>
                        {rec.model ? (
                          ready ? (
                            <small>{displayModelName(rec.model.family, rec.model.version)}</small>
                          ) : (
                            <span className="badge warn">{t("home.notInstalled")}</span>
                          )
                        ) : (
                          <small>{t("home.cloudOnly")}</small>
                        )}
                      </div>
                    );
                  })}
                  <div className="rule" aria-hidden="true" />
                  <button
                    role="menuitem"
                    onClick={() => {
                      setModelsPopOpen(false);
                      openSettings("models");
                    }}
                  >
                    {t("home.manageModels")}
                  </button>
                </div>
              )}
            </div>
            <Tip label={t("common.generate")} shortcut={t("home.ctrlEnter")} side="top">
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
            <div className="spacer" />
            <Tip label={t("common.generate")} shortcut={t("home.ctrlEnter")} side="top">
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

      {projects.length === 0 && (
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
        <div className="recent">
          <div className="recent-head">
            <h2>{t("home.toolOutputs")}</h2>
            <span className="count">· {toolSessions.length}</span>
          </div>
          <div className="grid">{toolSessions.map(renderTile)}</div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t("home.deleteTitle", { title: confirmDelete.title })}
          message={t("home.deleteMessage")}
          confirmLabel={t("home.deleteConfirm")}
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
