import { useEffect } from "react";
import { QueueTray } from "./components/QueueTray";
import { Home } from "./screens/Home";
import { Project } from "./screens/Project";
import { useApp } from "./store";

/** One window, one persistent left rail. */
export default function App() {
  const { connect, currentProject, closeProject } = useApp();

  useEffect(() => {
    void connect();
  }, [connect]);

  return (
    <div className="app">
      <nav className="rail" aria-label="Navigation">
        <div className="brand">LocalCut</div>
        <button className={currentProject ? "" : "active"} onClick={closeProject}>
          Home
        </button>
        <button className={currentProject ? "active" : ""} disabled={!currentProject}>
          Scenes
        </button>
        <button disabled title="Phase 1">Audio</button>
        <button disabled title="Phase 1">Assets</button>
        <button disabled title="Phase 1">Export</button>
      </nav>
      <main className="content">{currentProject ? <Project /> : <Home />}</main>
      <QueueTray />
    </div>
  );
}
