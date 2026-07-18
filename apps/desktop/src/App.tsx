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
import { BrandMark } from "./components/BrandMark";
import { HelpMenu } from "./components/Help";
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

  // First run gates everything; after that, an open project wins over
  // settings, and Home is the fallback.
  const screen = !firstRunDone ? (
    <FirstRun />
  ) : currentProject ? (
    <Project />
  ) : settingsOpen ? (
    <Settings />
  ) : (
    <Home />
  );

  // "NVIDIA GeForce RTX 3080" → "RTX 3080": the chip is narrow and the
  // vendor prefix says nothing the model number doesn't.
  const gpu = system?.hardware.gpus[0]?.name.replace(/^(NVIDIA|AMD|Intel)\s+(GeForce|Radeon|Arc)?\s*/i, "") ?? null;
  const engineDetail = system
    ? `${gpu || "No GPU"} · Tier ${system.hardware.tier} · ${system.backend_mode}`
    : engineError
      ? "not connected"
      : "connecting…";

  // Inside a project the rail collapses to a 48px icon activity bar —
  // chrome recedes; the workspace owns the width. Full rail on Home. A
  // chevron re-expands it in a project, and the choice persists.
  const inProject = Boolean(currentProject);
  const [railExpanded, setRailExpanded] = useState(
    () => localStorage.getItem(RAIL_KEY) === "1",
  );
  const compact = inProject && !railExpanded;
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
        <span className="tb-name">LocalCut AI</span>
        {currentProject && <span className="tb-project">{currentProject.title}</span>}
      </header>
      <nav className={`rail${compact ? " compact" : ""}`} aria-label="Navigation">
        {compact ? (
          <Tip label="Home" hint="close the project" side="top">
            <button
              className="rail-mark"
              onClick={() => {
                closeProject();
                closeSettings();
              }}
              aria-label="Home"
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
            <span className="rail-label">Home</span>
          </button>
        )}
        {inProject && (
          <button className="active" title="Scenes" aria-label="Scenes">
            <LayoutGrid {...ICON} />
            <span className="rail-label">Scenes</span>
          </button>
        )}
        <div className="rail-bottom">
          <Tip
            label={remoteEngine ? "Remote engine" : "Local engine"}
            hint={compact ? `${engineDetail} — click for engine settings` : "click for engine settings"}
            side="top"
          >
            <button
              className="engine-chip"
              style={{ width: "100%" }}
              disabled={!firstRunDone}
              onClick={() => openSettings("engine")}
              aria-label="Engine status — open engine settings"
            >
              <span className={`pulse${engineError ? " err" : ""}`} />
              <span className="engine-detail" style={{ minWidth: 0 }}>
                <b>{remoteEngine ? "Remote engine" : "Local engine"}</b>
                <small>{engineDetail}</small>
              </span>
            </button>
          </Tip>
          <button
            onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
            title="Toggle theme — the follow-system option lives in Settings"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun {...ICON} /> : <Moon {...ICON} />}
            <span className="rail-label">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <button
            className={settingsOpen && !currentProject ? "active" : ""}
            disabled={!firstRunDone}
            title="Settings"
            onClick={() => {
              closeProject();
              openSettings("general");
            }}
          >
            <SettingsIcon {...ICON} />
            <span className="rail-label">Settings</span>
          </button>
          <HelpMenu compact={compact} />
          {inProject && (
            <button
              onClick={toggleRail}
              title={compact ? "Expand the sidebar" : "Collapse the sidebar"}
              aria-label={compact ? "Expand the sidebar" : "Collapse the sidebar"}
            >
              {compact ? <ChevronsRight {...ICON} /> : <ChevronsLeft {...ICON} />}
              <span className="rail-label">Collapse</span>
            </button>
          )}
        </div>
      </nav>
      <main className={`content${workspaceMode ? " project-mode" : ""}`}>
        {engineError && <div className="banner error">{engineError}</div>}
        {screen}
      </main>
      <QueueTray />
    </div>
  );
}
