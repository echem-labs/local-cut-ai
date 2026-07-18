import {
  AudioLines,
  Clapperboard,
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

  const gpu = system?.hardware.gpus[0]?.name ?? null;
  const engineDetail = system
    ? `${gpu ?? "No GPU"} · Tier ${system.hardware.tier} · ${system.backend_mode}`
    : engineError
      ? "not connected"
      : "connecting…";

  return (
    <div className="app">
      <nav className="rail" aria-label="Navigation">
        <div className="brand">
          <span className="logo">
            <Clapperboard size={13} strokeWidth={2.2} />
          </span>
          LocalCut
        </div>
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
        </div>
      </nav>
      <main className="content">
        {engineError && <div className="banner error">{engineError}</div>}
        {screen}
      </main>
      <QueueTray />
    </div>
  );
}
