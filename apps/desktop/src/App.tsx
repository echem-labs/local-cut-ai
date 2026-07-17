import { useEffect } from "react";
import { QueueTray } from "./components/QueueTray";
import { FirstRun } from "./screens/FirstRun";
import { Home } from "./screens/Home";
import { Project } from "./screens/Project";
import { Settings } from "./screens/Settings";
import { useApp } from "./store";

/** One window, one persistent left rail. */
export default function App() {
  const {
    connect,
    currentProject,
    closeProject,
    closeSettings,
    engineError,
    firstRunDone,
    settingsOpen,
  } = useApp();

  useEffect(() => {
    void connect();
  }, [connect]);

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

  return (
    <div className="app">
      <nav className="rail" aria-label="Navigation">
        <div className="brand">LocalCut</div>
        <button
          className={firstRunDone && !currentProject && !settingsOpen ? "active" : ""}
          disabled={!firstRunDone}
          onClick={() => {
            closeProject();
            closeSettings();
          }}
        >
          Home
        </button>
        <button className={currentProject ? "active" : ""} disabled={!currentProject}>
          Scenes
        </button>
        <button disabled title="Phase 1">Audio</button>
        <button disabled title="Phase 1">Assets</button>
        <button disabled title="Phase 1">Export</button>
      </nav>
      <main className="content">
        {engineError && <div className="banner error">{engineError}</div>}
        {screen}
      </main>
      <QueueTray />
    </div>
  );
}
