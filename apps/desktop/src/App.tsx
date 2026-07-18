import {
  AudioLines,
  FolderOpen,
  Home as HomeIcon,
  LayoutGrid,
  Moon,
  Settings as SettingsIcon,
  Sun,
  Upload,
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
    selectedNode,
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

  return (
    <div className="app">
      {/* Frameless window: this slim bar is the drag region; the native
          min/max/close buttons overlay its right edge (same background). */}
      <header className="titlebar">
        <BrandMark size={18} />
        <span className="tb-name">LocalCut AI</span>
        {currentProject && <span className="tb-project">{currentProject.title}</span>}
      </header>
      <nav className="rail" aria-label="Navigation">
        <button
          className={firstRunDone && !currentProject && !settingsOpen ? "active" : ""}
          disabled={!firstRunDone}
          onClick={() => {
            closeProject();
            closeSettings();
          }}
        >
          <HomeIcon {...ICON} />
          Home
        </button>
        <div className="group-label">Project</div>
        <button className={currentProject ? "active" : ""} disabled={!currentProject}>
          <LayoutGrid {...ICON} />
          Scenes
        </button>
        <button disabled title="Coming in a later phase">
          <AudioLines {...ICON} />
          Audio
          <span className="soon">soon</span>
        </button>
        <button disabled title="Coming in a later phase">
          <FolderOpen {...ICON} />
          Assets
          <span className="soon">soon</span>
        </button>
        <button disabled title="Coming in a later phase">
          <Upload {...ICON} />
          Export
          <span className="soon">soon</span>
        </button>
        <div className="rail-bottom">
          <Tip label="Engine status" hint="click for engine settings" side="top">
            <button
              className="engine-chip"
              style={{ width: "100%" }}
              disabled={!firstRunDone}
              onClick={() => openSettings("engine")}
              aria-label="Engine status — open engine settings"
            >
              <span className={`pulse${engineError ? " err" : ""}`} />
              <span style={{ minWidth: 0 }}>
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
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <button
            className={settingsOpen && !currentProject ? "active" : ""}
            disabled={!firstRunDone}
            onClick={() => {
              closeProject();
              openSettings("general");
            }}
          >
            <SettingsIcon {...ICON} />
            Settings
          </button>
          <HelpMenu />
        </div>
      </nav>
      {/* The inspector drawer is fixed; the content yields its width so
          nothing (including the scrollbar) hides behind it. */}
      <main
        className={`content${currentProject && selectedNode ? " with-inspector" : ""}`}
      >
        {engineError && <div className="banner error">{engineError}</div>}
        {screen}
      </main>
      <QueueTray />
    </div>
  );
}
