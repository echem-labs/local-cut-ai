import { useState } from "react";
import { useApp } from "../store";

/** Home: one prompt box — the entire prompt-only mode — plus a
 * Quick Tools row and recent projects. Control budget: ≤6 elements. */
export function Home() {
  const { projects, createFromPrompt, openProject, system, engineError } = useApp();
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(60);
  const [aspect, setAspect] = useState("9:16");
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      await createFromPrompt(prompt.trim(), duration, aspect);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <h1>Describe your video…</h1>
      {engineError && <div className="banner error">{engineError}</div>}
      <div className="prompt-box">
        <textarea
          placeholder="e.g. Why octopuses have three hearts — fast-paced, for Shorts"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void generate();
          }}
          aria-label="Video prompt"
        />
        <div className="row">
          <select
            value={aspect}
            onChange={(event) => setAspect(event.target.value)}
            aria-label="Aspect ratio"
          >
            <option value="9:16">9:16 · Shorts</option>
            <option value="16:9">16:9 · YouTube</option>
            <option value="1:1">1:1 · Square</option>
          </select>
          <select
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
            aria-label="Duration"
          >
            <option value={30}>30s</option>
            <option value={60}>60s</option>
            <option value={120}>2min</option>
          </select>
          <div className="spacer" />
          <button className="btn-primary" onClick={() => void generate()} disabled={busy}>
            {busy ? "Starting…" : "Generate"}
          </button>
        </div>
      </div>

      <div className="quick-tools" aria-label="Quick tools">
        <button className="btn-ghost" title="Coming in Phase 1">📝 Script</button>
        <button className="btn-ghost" title="Coming in Phase 1">🖼 Thumbnail</button>
        <button className="btn-ghost" title="Coming in Phase 1">🎙 Voice</button>
      </div>

      {system && (
        <p style={{ color: "var(--text-tertiary)", marginTop: "var(--space-4)" }}>
          {system.hardware.gpus[0]?.name ?? "No GPU detected"} · Tier {system.hardware.tier} ·
          engine: {system.backend_mode}
        </p>
      )}

      {projects.length > 0 && (
        <div className="recent">
          <h2>Recent projects</h2>
          <div className="grid">
            {projects.map((project) => (
              <button
                key={project.id}
                className="project-tile"
                onClick={() => void openProject(project.id)}
              >
                <div className="title">{project.title}</div>
                <div className="meta">
                  {new Date(project.created_at * 1000).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
