import {
  ChevronsLeft,
  ChevronsRight,
  Home as HomeIcon,
  Moon,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { applyTheme, resolvedTheme, THEME_EVENT } from "./theme";
import { plural, t } from "./i18n";
import { BrandMark } from "./components/BrandMark";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HelpMenu } from "./components/Help";
import { Palette } from "./components/Palette";
import { QueueTray } from "./components/QueueTray";
import { Tip } from "./components/Tooltip";
import { FirstRun } from "./screens/FirstRun";
import { Home, tileStatus } from "./screens/Home";
import { Project } from "./screens/Project";
import { Settings } from "./screens/Settings";
import type { Project as ProjectMeta } from "./api/types";
import { useApp } from "./store";

const ICON = { size: 15, strokeWidth: 1.8 } as const;
const RAIL_KEY = "localcut.rail.expanded";
/** The rail lists this many past tool sessions; the rest are one click away
 * on Home. A rail that grows without bound pushes the bottom cluster into a
 * scroll for someone who simply used the tools a lot. */
const RECENT_LIMIT = 8;

/** One window, one persistent left rail. */
export default function App() {
  const {
    connect,
    currentProject,
    openProjects,
    projects,
    allJobs,
    openProject,
    closeOpenProject,
    closeProject,
    closeSettings,
    openSettings,
    deleteProject,
    engineError,
    firstRunDone,
    settingsOpen,
    system,
    remoteEngine,
  } = useApp();
  const [confirmDelete, setConfirmDelete] = useState<ProjectMeta | null>(null);
  const [railError, setRailError] = useState<string | null>(null);

  useEffect(() => {
    void connect();
  }, [connect]);

  // The tab list scrolls; keep the active tab visible in it (the removed
  // overflow cap used to guarantee this by swapping it into the window).
  // settingsOpen is a dependency: the overlay strips the active class off
  // every tab, and closing it restores the class without the id changing.
  const activeProjectId = currentProject?.id ?? null;
  useEffect(() => {
    if (!activeProjectId || settingsOpen) return;
    document
      .querySelector(".rail-tabs button.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeProjectId, settingsOpen]);

  // Mirrors the resolved theme (Settings toggle and OS changes included).
  const [theme, setTheme] = useState<"dark" | "light">(resolvedTheme);
  useEffect(() => {
    const onChange = () => setTheme(resolvedTheme());
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);

  // First run gates everything; after that the project or Home shows, and
  // Settings renders as an OVERLAY LAYER above either — opening it never
  // unmounts the project (review 4 §SH1).
  const screen = !firstRunDone ? <FirstRun /> : currentProject ? <Project /> : <Home />;

  // "NVIDIA GeForce RTX 3080" → "RTX 3080": the chip is narrow and the
  // vendor prefix says nothing the model number doesn't.
  const gpu = system?.hardware.gpus[0]?.name.replace(/^(NVIDIA|AMD|Intel)\s+(GeForce|Radeon|Arc)?\s*/i, "") ?? null;
  const engineDetail = system
    ? t("nav.engineDetail", {
        gpu: gpu || t("nav.noGpu"),
        tier: system.hardware.tier,
        backend: system.backend_mode,
      })
    : engineError
      ? t("nav.engineNotConnected")
      : t("nav.engineConnecting");

  // ONE activity bar on every screen (review 4 §SH2): the 48px compact
  // rail is the default everywhere; expanding to the labeled 200px rail is
  // a persisted choice that also holds on every screen. VS Code never
  // resizes its activity bar — shell stability is the point.
  const [railExpanded, setRailExpanded] = useState(
    () => localStorage.getItem(RAIL_KEY) === "1",
  );
  const compact = !railExpanded;
  const toggleRail = () => {
    const next = !railExpanded;
    localStorage.setItem(RAIL_KEY, next ? "1" : "0");
    setRailExpanded(next);
  };
  const workspaceMode = currentProject ? !currentProject.mode.startsWith("tool:") : false;

  // Quick-tool history. Every tool run is a real project the engine keeps
  // forever, but the rail only ever showed one while its tab happened to be
  // open — close the tab and the session was reachable only by scrolling to
  // the bottom of Home. Derived from `projects`, never cached locally, so a
  // delete from any surface (or another engine) takes it out of this list
  // through the same refresh that updates Home.
  //
  // Open sessions are left out: the tab above already stands for them, and a
  // row in both lists would make closing a tab look like it deleted one.
  const recentTools = useMemo(() => {
    const open = new Set(openProjects);
    return projects
      .filter((project) => project.mode.startsWith("tool:") && !open.has(project.id))
      .sort((a, b) => (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at));
  }, [projects, openProjects]);

  return (
    <div className="app">
      {/* Frameless window: this slim bar is the drag region; the native
          min/max/close buttons overlay its right edge (same background). */}
      <header className="titlebar">
        <BrandMark size={18} />
        <span className="tb-name">{t("titlebar.appName")}</span>
        {currentProject && <span className="tb-project">{currentProject.title}</span>}
      </header>
      <nav className={`rail${compact ? " compact" : ""}`} aria-label={t("nav.navigationAria")}>
        {compact ? (
          <Tip label={t("nav.home")} hint={t("nav.homeCloseHint")} side="top">
            <button
              className={`rail-mark${!currentProject && !settingsOpen ? " active" : ""}`}
              onClick={() => {
                closeProject();
                closeSettings();
              }}
              aria-label={t("nav.home")}
            >
              <BrandMark size={20} />
            </button>
          </Tip>
        ) : (
          <button
            className={firstRunDone && !currentProject && !settingsOpen ? "active" : ""}
            disabled={!firstRunDone}
            onClick={() => {
              closeProject();
              closeSettings();
            }}
          >
            <HomeIcon {...ICON} />
            <span className="rail-label">{t("nav.home")}</span>
          </button>
        )}
        {firstRunDone && openProjects.length > 0 && (
          <div className="rail-tabs">
            {openProjects.map((id) => {
              const project =
                projects.find((entry) => entry.id === id) ??
                (currentProject?.id === id ? currentProject : null);
              const title = project?.title ?? id;
              const active = currentProject?.id === id && !settingsOpen;
              return (
                <div key={id} className="rail-tab">
                  <button
                    className={active ? "active" : ""}
                    title={title}
                    onClick={() => {
                      closeSettings();
                      if (currentProject?.id !== id) void openProject(id);
                    }}
                  >
                    {compact && (
                      <span className="rail-glyph" aria-hidden="true">
                        {/* spread: [0] would split a surrogate pair (emoji titles) */}
                        {([...title.trim()][0] ?? "?").toUpperCase()}
                      </span>
                    )}
                    <i
                      className={`dot ${project ? tileStatus(project, allJobs) : "draft"}`}
                      aria-hidden="true"
                    />
                    <span className="rail-label">{title}</span>
                  </button>
                  <button
                    className="rail-tab-close"
                    title={t("nav.closeProjectAria", { title })}
                    aria-label={t("nav.closeProjectAria", { title })}
                    onClick={() => closeOpenProject(id)}
                  >
                    <X size={12} strokeWidth={1.8} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {firstRunDone && recentTools.length > 0 && (
          <div className="rail-recent">
            <div className="group-label">{t("nav.recent")}</div>
            {recentTools.slice(0, RECENT_LIMIT).map((project) => {
              const title = project.title;
              return (
                // Two sibling buttons, never a button inside a button: ARIA
                // makes a button's children presentational, so a nested
                // delete would vanish from assistive tech (same reason the
                // project tiles are shaped this way).
                <div key={project.id} className="rail-tab">
                  <button
                    title={title}
                    onClick={() => {
                      closeSettings();
                      void openProject(project.id);
                    }}
                  >
                    {compact && (
                      <span className="rail-glyph" aria-hidden="true">
                        {/* spread: [0] would split a surrogate pair (emoji titles) */}
                        {([...title.trim()][0] ?? "?").toUpperCase()}
                      </span>
                    )}
                    <i className={`dot ${tileStatus(project, allJobs)}`} aria-hidden="true" />
                    <span className="rail-label">{title}</span>
                  </button>
                  <button
                    className="rail-tab-action"
                    title={t("nav.deleteToolAria", { title })}
                    aria-label={t("nav.deleteToolAria", { title })}
                    onClick={() => setConfirmDelete(project)}
                  >
                    <Trash2 size={12} strokeWidth={1.8} />
                  </button>
                </div>
              );
            })}
            {recentTools.length > RECENT_LIMIT && (
              <button
                className="rail-recent-all"
                aria-label={plural("nav.recentAll", recentTools.length)}
                onClick={() => {
                  closeProject();
                  closeSettings();
                }}
              >
                {compact && (
                  <span className="rail-glyph" aria-hidden="true">
                    +{recentTools.length - RECENT_LIMIT}
                  </span>
                )}
                <span className="rail-label">{plural("nav.recentAll", recentTools.length)}</span>
              </button>
            )}
          </div>
        )}
        <div className="rail-bottom">
          <Tip
            label={remoteEngine ? t("nav.remoteEngine") : t("nav.localEngine")}
            hint={
              compact
                ? t("nav.engineSettingsHintCompact", { detail: engineDetail })
                : t("nav.engineSettingsHint")
            }
            side="top"
          >
            <button
              className="engine-chip"
              style={{ width: "100%" }}
              disabled={!firstRunDone}
              onClick={() => openSettings("engine")}
              aria-label={t("nav.engineStatusAria")}
            >
              <span className={`pulse${engineError ? " err" : ""}`} />
              <span className="engine-detail" style={{ minWidth: 0 }}>
                <b>{remoteEngine ? t("nav.remoteEngine") : t("nav.localEngine")}</b>
                <small>{engineDetail}</small>
              </span>
            </button>
          </Tip>
          <HelpMenu compact={compact} />
          <button
            onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
            title={t("nav.toggleThemeTitle")}
            aria-label={theme === "dark" ? t("nav.switchToLight") : t("nav.switchToDark")}
          >
            {theme === "dark" ? <Sun {...ICON} /> : <Moon {...ICON} />}
            <span className="rail-label">{theme === "dark" ? t("nav.lightMode") : t("nav.darkMode")}</span>
          </button>
          <button
            className={settingsOpen ? "active" : ""}
            disabled={!firstRunDone}
            title={t("nav.settings")}
            onClick={() => openSettings("general")}
          >
            <SettingsIcon {...ICON} />
            <span className="rail-label">{t("nav.settings")}</span>
          </button>
          <button
            onClick={toggleRail}
            title={compact ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
            aria-label={compact ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
          >
            {compact ? <ChevronsRight {...ICON} /> : <ChevronsLeft {...ICON} />}
            <span className="rail-label">{t("nav.collapse")}</span>
          </button>
        </div>
      </nav>
      <main className={`content${workspaceMode ? " project-mode" : ""}`}>
        {engineError && <div className="banner error">{engineError}</div>}
        {/* A rejected delete has no room to report itself in the rail, and
            dropping the returned message would make a failed delete look
            like a successful one — the row simply reappears. */}
        {railError && (
          <div className="banner error" role="alert">
            {railError}
          </div>
        )}
        {screen}
        {firstRunDone && settingsOpen && (
          <div className="settings-layer screen-enter">
            <Settings />
          </div>
        )}
      </main>
      {confirmDelete && (
        <ConfirmDialog
          title={t("home.deleteToolTitle", { title: confirmDelete.title })}
          message={t("home.deleteToolMessage")}
          confirmLabel={t("home.deleteToolConfirm")}
          danger
          onConfirm={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            setRailError(null);
            void deleteProject(target.id).then(setRailError);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      <QueueTray />
      <Palette />
    </div>
  );
}
