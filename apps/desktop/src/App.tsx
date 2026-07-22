import {
  ChevronsLeft,
  ChevronsRight,
  Home as HomeIcon,
  LayoutGrid,
  Moon,
  MoreHorizontal,
  Settings as SettingsIcon,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { applyTheme, resolvedTheme, THEME_EVENT } from "./theme";
import { t } from "./i18n";
import { BrandMark } from "./components/BrandMark";
import { HelpMenu } from "./components/Help";
import { Palette } from "./components/Palette";
import { QueueTray } from "./components/QueueTray";
import { Tip } from "./components/Tooltip";
import { useOutsideClick } from "./lib/useOutsideClick";
import { FirstRun } from "./screens/FirstRun";
import { Home, tileStatus } from "./screens/Home";
import { Project } from "./screens/Project";
import { Settings } from "./screens/Settings";
import { useApp } from "./store";

const ICON = { size: 15, strokeWidth: 1.8 } as const;
const RAIL_KEY = "localcut.rail.expanded";

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
    engineError,
    firstRunDone,
    settingsOpen,
    system,
    remoteEngine,
  } = useApp();
  // Rail-tab overflow popover (open tabs past the visible cap).
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  const tabsMenuRef = useRef<HTMLDivElement>(null);
  useOutsideClick(tabsMenuRef, tabsMenuOpen, () => setTabsMenuOpen(false));

  useEffect(() => {
    void connect();
  }, [connect]);

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
  // Open-project tabs: cap the rail at a handful; the rest live in an
  // overflow menu. The active tab always stays visible — if it sits past
  // the cap, it swaps with the last visible slot.
  const RAIL_TABS_MAX = 5;
  let visibleTabs = openProjects.slice(0, RAIL_TABS_MAX);
  let overflowTabs = openProjects.slice(RAIL_TABS_MAX);
  const activeId = currentProject?.id;
  if (activeId && overflowTabs.includes(activeId)) {
    const swapped = visibleTabs[visibleTabs.length - 1];
    visibleTabs = [...visibleTabs.slice(0, -1), activeId];
    overflowTabs = overflowTabs.map((id) => (id === activeId ? swapped : id));
  }
  const compact = !railExpanded;
  const toggleRail = () => {
    const next = !railExpanded;
    localStorage.setItem(RAIL_KEY, next ? "1" : "0");
    setRailExpanded(next);
  };
  const workspaceMode = currentProject ? !currentProject.mode.startsWith("tool:") : false;

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
        {firstRunDone && visibleTabs.length > 0 && (
          <div className="rail-tabs">
            {visibleTabs.map((id) => {
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
                    <LayoutGrid {...ICON} />
                    {project && (
                      <i
                        className={`dot ${tileStatus(project, allJobs)}`}
                        aria-hidden="true"
                      />
                    )}
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
        {firstRunDone && overflowTabs.length > 0 && (
          <div className="rail-tab-overflow" ref={tabsMenuRef}>
            <button
              aria-haspopup="menu"
              aria-expanded={tabsMenuOpen}
              title={t("nav.moreProjects", { n: overflowTabs.length })}
              onClick={() => setTabsMenuOpen((open) => !open)}
            >
              <MoreHorizontal {...ICON} />
              <span className="rail-label">
                {t("nav.moreProjects", { n: overflowTabs.length })}
              </span>
            </button>
            {tabsMenuOpen && (
              <div className="menu-pop" role="menu">
                {overflowTabs.map((id) => (
                  <button
                    key={id}
                    role="menuitem"
                    onClick={() => {
                      setTabsMenuOpen(false);
                      closeSettings();
                      void openProject(id);
                    }}
                  >
                    {projects.find((entry) => entry.id === id)?.title ?? id}
                  </button>
                ))}
              </div>
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
          <HelpMenu compact={compact} />
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
        {screen}
        {firstRunDone && settingsOpen && (
          <div className="settings-layer screen-enter">
            <Settings />
          </div>
        )}
      </main>
      <QueueTray />
      <Palette />
    </div>
  );
}
