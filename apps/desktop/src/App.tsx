import {
  ChevronsLeft,
  ChevronsRight,
  Home as HomeIcon,
  LayoutGrid,
  Moon,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { applyTheme, resolvedTheme, THEME_EVENT } from "./theme";
import { t } from "./i18n";
import { BrandMark } from "./components/BrandMark";
import { HelpMenu } from "./components/Help";
import { Palette } from "./components/Palette";
import { QueueTray } from "./components/QueueTray";
import { Tip } from "./components/Tooltip";
import { FirstRun } from "./screens/FirstRun";
import { Home } from "./screens/Home";
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
    closeProject,
    closeSettings,
    openSettings,
    engineError,
    firstRunDone,
    settingsOpen,
    system,
    remoteEngine,
  } = useApp();

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
  const inProject = Boolean(currentProject);
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
        {inProject && (
          <button className="active" title={t("nav.scenes")} aria-label={t("nav.scenes")}>
            <LayoutGrid {...ICON} />
            <span className="rail-label">{t("nav.scenes")}</span>
          </button>
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
