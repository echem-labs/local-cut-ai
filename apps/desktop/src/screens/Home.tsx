import { useState } from "react";
import type { ToolKind } from "../api/types";
import { useApp } from "../store";

const TOOLS: { kind: ToolKind; label: string; glyph: string; placeholder: string }[] = [
  {
    kind: "script",
    label: "Script",
    glyph: "📝",
    placeholder: "e.g. A 60-second script on why octopuses have three hearts",
  },
  {
    kind: "thumbnail",
    label: "Thumbnail",
    glyph: "🖼",
    placeholder: "e.g. A diver face-to-face with a giant octopus, dramatic light",
  },
  {
    kind: "voiceover",
    label: "Voiceover",
    glyph: "🎙",
    placeholder: "Paste the text to narrate…",
  },
];

/** Home: one prompt box — the entire prompt-only mode — plus a
 * Quick Tools row and recent projects. Control budget: ≤6 elements. */
export function Home() {
  const { projects, createFromPrompt, createTool, openProject, system } = useApp();
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(60);
  const [aspect, setAspect] = useState("9:16");
  const [mode, setMode] = useState<"prompt" | "beginner">("prompt");
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<ToolKind | null>(null);
  const [toolInput, setToolInput] = useState("");
  const [voice, setVoice] = useState("");

  const activeTool = TOOLS.find((entry) => entry.kind === tool) ?? null;

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      await createFromPrompt(prompt.trim(), duration, aspect, mode);
    } finally {
      setBusy(false);
    }
  };

  const runTool = async () => {
    if (!tool || !toolInput.trim() || busy) return;
    setBusy(true);
    try {
      await createTool(tool, {
        ...(tool === "voiceover"
          ? { text: toolInput.trim(), ...(voice.trim() ? { voice: voice.trim() } : {}) }
          : { prompt: toolInput.trim() }),
      });
    } finally {
      setBusy(false);
    }
  };

  const real = projects.filter((project) => !project.mode.startsWith("tool:"));
  const toolSessions = projects.filter((project) => project.mode.startsWith("tool:"));
  const ordered = [...real, ...toolSessions];

  return (
    <div className="home">
      <h1>Describe your video…</h1>
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
          <div className="seg-toggle" role="group" aria-label="Generation mode">
            <button
              className={mode === "prompt" ? "active" : ""}
              onClick={() => setMode("prompt")}
            >
              Auto
            </button>
            <button
              className={mode === "beginner" ? "active" : ""}
              onClick={() => setMode("beginner")}
            >
              Review steps
            </button>
          </div>
          <div className="spacer" />
          <button className="btn-primary" onClick={() => void generate()} disabled={busy}>
            {busy ? "Starting…" : "Generate"}
          </button>
        </div>
      </div>

      <div className="quick-tools" role="group" aria-label="Quick tools">
        {TOOLS.map((entry) => (
          <button
            key={entry.kind}
            className={tool === entry.kind ? "active" : ""}
            onClick={() => setTool(tool === entry.kind ? null : entry.kind)}
          >
            {entry.glyph} {entry.label}
          </button>
        ))}
      </div>

      {activeTool && (
        <div className="prompt-box tool-panel">
          <textarea
            placeholder={activeTool.placeholder}
            value={toolInput}
            onChange={(event) => setToolInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void runTool();
            }}
            aria-label={activeTool.kind === "voiceover" ? "Voiceover text" : `${activeTool.label} prompt`}
          />
          <div className="row">
            {activeTool.kind === "voiceover" && (
              <input
                placeholder="Voice (optional)"
                value={voice}
                onChange={(event) => setVoice(event.target.value)}
                aria-label="Voice"
              />
            )}
            <div className="spacer" />
            <button className="btn-primary" onClick={() => void runTool()} disabled={busy}>
              {busy ? "Starting…" : `Generate ${activeTool.label.toLowerCase()}`}
            </button>
          </div>
        </div>
      )}

      {system && (
        <p style={{ color: "var(--text-tertiary)", marginTop: "var(--space-4)" }}>
          {system.hardware.gpus[0]?.name ?? "No GPU detected"} · Tier {system.hardware.tier} ·
          engine: {system.backend_mode}
        </p>
      )}

      {ordered.length > 0 && (
        <div className="recent">
          <h2>Recent projects</h2>
          <div className="grid">
            {ordered.map((project) => (
              <button
                key={project.id}
                className="project-tile"
                onClick={() => void openProject(project.id)}
              >
                <div className="title">{project.title}</div>
                <div className="meta">
                  {new Date(project.created_at * 1000).toLocaleDateString()}
                  {project.mode.startsWith("tool:") && (
                    <span className="tile-badge">{project.mode.slice("tool:".length)}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
