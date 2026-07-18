import {
  Aperture,
  ArrowUp,
  Boxes,
  Clapperboard,
  Clock,
  FileText,
  Film,
  Image as ImageIcon,
  Info,
  Mic,
  Monitor,
  Music,
  Smartphone,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { Dropdown } from "../components/Dropdown";
import { Tip } from "../components/Tooltip";
import type { ToolKind } from "../api/types";
import { useApp } from "../store";

const TOOL_ICON = { size: 17, strokeWidth: 1.8 } as const;

const TOOLS: {
  kind: ToolKind;
  label: string;
  icon: typeof FileText;
  tip: string;
  placeholder: string;
}[] = [
  {
    kind: "script",
    label: "Script",
    icon: FileText,
    tip: "Topic → structured script",
    placeholder: "e.g. A 60-second script on why octopuses have three hearts",
  },
  {
    kind: "thumbnail",
    label: "Thumbnail",
    icon: ImageIcon,
    tip: "Prompt → platform-ready thumbnail",
    placeholder: "e.g. A diver face-to-face with a giant octopus, dramatic light",
  },
  {
    kind: "voiceover",
    label: "Voiceover",
    icon: Mic,
    tip: "Text → narration audio",
    placeholder: "Paste the text to narrate…",
  },
  {
    kind: "image",
    label: "Image",
    icon: Aperture,
    tip: "Prompt → single image",
    placeholder: "e.g. Bioluminescent waves on a black-sand beach at night",
  },
  {
    kind: "music",
    label: "Music",
    icon: Music,
    tip: "Brief → music track",
    placeholder: "e.g. Lo-fi beat, warm keys, gentle vinyl crackle, 60 seconds",
  },
  {
    kind: "clip",
    label: "Clip",
    icon: Film,
    tip: "Prompt → single video clip",
    placeholder: "e.g. A hummingbird hovering at a red flower, macro detail",
  },
];

const ASPECTS = [
  { value: "9:16", label: "Shorts", icon: Smartphone },
  { value: "16:9", label: "YouTube", icon: Monitor },
  { value: "1:1", label: "Square", icon: Square },
];

const DURATIONS = [
  { value: 30, label: "30s", icon: Clock },
  { value: 60, label: "60s", icon: Clock },
  { value: 120, label: "2min", icon: Clock },
];

/** One-click teaching prompt for the empty state — fills, never generates. */
const SAMPLE_PROMPT = "Why octopuses have three hearts — fast-paced, for Shorts";

/** Deterministic stand-in art per project until real keyframe thumbs. */
const thumbClass = (id: string): string => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `g${Math.abs(hash) % 4}`;
};

/** Home: one prompt surface — the video prompt, or the active quick tool's
 * panel in its place (never both) — plus the Quick Tools row and recent
 * projects. Control budget: ≤6 elements. */
export function Home() {
  const { projects, createFromPrompt, createTool, openProject, openSettings, actionError } =
    useApp();
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(60);
  const [aspect, setAspect] = useState("9:16");
  const [mode, setMode] = useState<"prompt" | "beginner">("prompt");
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<ToolKind | null>(null);
  const [toolInput, setToolInput] = useState("");
  const [voice, setVoice] = useState("");
  const [motion, setMotion] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);

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
        ...(tool === "clip" && motion.trim() ? { motion: motion.trim() } : {}),
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
      <div className="home-header">
        <h1>What are we making today?</h1>
      </div>
      <p className="sub">
        Describe it — script, storyboard, clips, narration and music are generated on this machine.
      </p>

      {!activeTool && (
        <div className="prompt-box">
          <textarea
            ref={promptRef}
            placeholder="e.g. Why octopuses have three hearts — fast-paced, for Shorts"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void generate();
            }}
            aria-label="Video prompt"
          />
          <div className="row">
            <Dropdown
              value={aspect}
              onChange={setAspect}
              ariaLabel="Aspect ratio"
              options={ASPECTS.map((entry) => ({
                value: entry.value,
                label: `${entry.value} · ${entry.label}`,
                icon: entry.icon,
              }))}
            />
            <Dropdown
              value={duration}
              onChange={setDuration}
              ariaLabel="Duration"
              options={DURATIONS.map((entry) => ({
                value: entry.value,
                label: entry.label,
                icon: entry.icon,
              }))}
            />
            <div className="seg-toggle" role="group" aria-label="Generation mode">
              <button
                className={mode === "prompt" ? "active" : ""}
                onClick={() => setMode("prompt")}
                title="Generate end-to-end without stopping"
              >
                Auto
              </button>
              <button
                className={mode === "beginner" ? "active" : ""}
                onClick={() => setMode("beginner")}
                title="Pause to review the script and storyboard before rendering"
              >
                Review steps
              </button>
            </div>
            <div className="spacer" />
            <Tip label="Models" hint="downloads, status & library" side="bottom">
              <button
                className="icon-btn"
                onClick={() => openSettings("models")}
                aria-label="Model library"
              >
                <Boxes size={15} strokeWidth={1.8} />
              </button>
            </Tip>
            <button className="btn-primary" onClick={() => void generate()} disabled={busy}>
              <Sparkles size={14} strokeWidth={2} />
              {busy ? "Starting…" : "Generate"}
              <kbd>Ctrl ↵</kbd>
            </button>
          </div>
          {actionError?.scope === "create" && (
            <p className="hint error-text" role="alert">
              {actionError.message}
            </p>
          )}
        </div>
      )}

      {activeTool && (
        <div className="prompt-box tool-panel">
          <div className="tool-head">
            <activeTool.icon size={15} strokeWidth={1.8} />
            <b>{activeTool.label}</b>
            <small>
              {activeTool.tip} · no project needed — export directly, or turn it into a video later
            </small>
            <button
              className="icon-btn"
              onClick={() => setTool(null)}
              aria-label="Close tool, back to video prompt"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
          <textarea
            placeholder={activeTool.placeholder}
            value={toolInput}
            onChange={(event) => setToolInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void runTool();
            }}
            aria-label={activeTool.kind === "voiceover" ? "Voiceover text" : `${activeTool.label} prompt`}
            autoFocus
          />
          <div className="row">
            {activeTool.kind === "voiceover" && (
              <>
                <input
                  placeholder='Voice — e.g. "energetic female" or af_bella'
                  value={voice}
                  onChange={(event) => setVoice(event.target.value)}
                  aria-label="Voice"
                />
                <Tip
                  label="Which narrator speaks"
                  hint='a style like "deep male" or a Kokoro id · empty = default'
                  side="top"
                >
                  <span className="info-dot" tabIndex={0} aria-label="About the voice field">
                    <Info size={13} strokeWidth={1.8} />
                  </span>
                </Tip>
              </>
            )}
            {activeTool.kind === "clip" && (
              <>
                <input
                  placeholder="Camera motion — e.g. slow push-in, orbit left"
                  value={motion}
                  onChange={(event) => setMotion(event.target.value)}
                  aria-label="Camera motion"
                />
                <Tip
                  label="How the camera moves"
                  hint="push-in, pan, orbit, handheld, static · empty = model decides"
                  side="top"
                >
                  <span className="info-dot" tabIndex={0} aria-label="About the camera motion field">
                    <Info size={13} strokeWidth={1.8} />
                  </span>
                </Tip>
              </>
            )}
            <div className="spacer" />
            <button className="btn-primary" onClick={() => void runTool()} disabled={busy}>
              <Sparkles size={14} strokeWidth={2} />
              {busy ? "Starting…" : `Generate ${activeTool.label.toLowerCase()}`}
              <kbd>Ctrl ↵</kbd>
            </button>
          </div>
          {actionError?.scope === "tool" && (
            <p className="hint error-text" role="alert">
              {actionError.message}
            </p>
          )}
        </div>
      )}

      <div className="tools-head">
        <h3>Quick tools</h3>
        <span className="hint">one artifact, no project — script, thumbnail, voice and more</span>
      </div>
      <div className="quick-tools" role="group" aria-label="Quick tools">
        {TOOLS.map((entry) => {
          const Icon = entry.icon;
          return (
            <Tip key={entry.kind} label={entry.tip} hint="no project needed" side="bottom">
              <button
                className={tool === entry.kind ? "active" : ""}
                onClick={() => {
                  setTool(tool === entry.kind ? null : entry.kind);
                  setToolInput("");
                }}
                aria-label={`${entry.label} — ${entry.tip}`}
              >
                <Icon {...TOOL_ICON} />
                {entry.label}
              </button>
            </Tip>
          );
        })}
      </div>

      {ordered.length === 0 && (
        <div className="empty-state">
          <Clapperboard size={22} strokeWidth={1.5} aria-hidden="true" />
          <b>Your videos land here</b>
          <p>Describe an idea above and Generate — or warm up with a sample:</p>
          <button
            className="btn-ghost"
            onClick={() => {
              setTool(null);
              setPrompt(SAMPLE_PROMPT);
              // The prompt box may be replaced by a tool panel right now —
              // focus after the re-render has mounted the textarea.
              requestAnimationFrame(() => promptRef.current?.focus());
            }}
          >
            “Why octopuses have three hearts”
            <ArrowUp size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
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
                <div className={`tile-thumb ${thumbClass(project.id)}`}>
                  {project.mode.startsWith("tool:") && (
                    <Film size={18} strokeWidth={1.5} aria-hidden="true" />
                  )}
                </div>
                <div className="tile-body">
                  <div className="title">{project.title}</div>
                  <div className="meta">
                    {new Date(project.created_at * 1000).toLocaleDateString()}
                    {project.mode.startsWith("tool:") && (
                      <span className="tile-badge">{project.mode.slice("tool:".length)}</span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
