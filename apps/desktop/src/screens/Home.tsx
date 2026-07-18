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
import { t, m } from "../i18n";
import { useApp } from "../store";

const TOOL_ICON = { size: 17, strokeWidth: 1.8 } as const;

/** Stable tool identity — display strings (label/tip/placeholder) live in
 * tools.json keyed by kind and are resolved at render time. */
const TOOLS: { kind: ToolKind; icon: typeof FileText }[] = [
  { kind: "script", icon: FileText },
  { kind: "thumbnail", icon: ImageIcon },
  { kind: "voiceover", icon: Mic },
  { kind: "image", icon: Aperture },
  { kind: "music", icon: Music },
  { kind: "clip", icon: Film },
];

/** Stable aspect identity — value drives logic, key resolves the label in
 * aspects.json, both at render time. */
const ASPECTS: { value: string; key: "shorts" | "youtube" | "square"; icon: typeof Smartphone }[] = [
  { value: "9:16", key: "shorts", icon: Smartphone },
  { value: "16:9", key: "youtube", icon: Monitor },
  { value: "1:1", key: "square", icon: Square },
];

/** Stable duration identity — value drives logic, key resolves the label in
 * durations.json, both at render time. */
const DURATIONS: { value: number; key: "d30" | "d60" | "d120"; icon: typeof Clock }[] = [
  { value: 30, key: "d30", icon: Clock },
  { value: 60, key: "d60", icon: Clock },
  { value: 120, key: "d120", icon: Clock },
];

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
        <h1>{t("home.title")}</h1>
      </div>
      <p className="sub">{t("home.subtitle")}</p>

      {!activeTool && (
        <div className="prompt-box">
          <textarea
            ref={promptRef}
            placeholder={t("home.promptPlaceholder")}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void generate();
            }}
            aria-label={t("home.promptAria")}
          />
          <div className="row">
            <Dropdown
              value={aspect}
              onChange={setAspect}
              ariaLabel={t("home.aspectAria")}
              options={ASPECTS.map((entry) => ({
                value: entry.value,
                label: `${entry.value} · ${m().aspects[entry.key]}`,
                icon: entry.icon,
              }))}
            />
            <Dropdown
              value={duration}
              onChange={setDuration}
              ariaLabel={t("home.durationAria")}
              options={DURATIONS.map((entry) => ({
                value: entry.value,
                label: m().durations[entry.key],
                icon: entry.icon,
              }))}
            />
            <div className="seg-toggle" role="group" aria-label={t("home.modeAria")}>
              <button
                className={mode === "prompt" ? "active" : ""}
                onClick={() => setMode("prompt")}
                title={t("home.modeAutoTitle")}
              >
                {t("home.modeAuto")}
              </button>
              <button
                className={mode === "beginner" ? "active" : ""}
                onClick={() => setMode("beginner")}
                title={t("home.modeReviewTitle")}
              >
                {t("home.modeReview")}
              </button>
            </div>
            <div className="spacer" />
            <Tip label={t("home.modelsLabel")} hint={t("home.modelsHint")} side="bottom">
              <button
                className="icon-btn"
                onClick={() => openSettings("models")}
                aria-label={t("home.modelsAria")}
              >
                <Boxes size={15} strokeWidth={1.8} />
              </button>
            </Tip>
            <button className="btn-primary" onClick={() => void generate()} disabled={busy}>
              <Sparkles size={14} strokeWidth={2} />
              {busy ? t("common.starting") : t("common.generate")}
              <kbd>{t("home.ctrlEnter")}</kbd>
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
            <b>{m().tools[activeTool.kind].label}</b>
            <small>
              {m().tools[activeTool.kind].tip} {t("home.toolHeadSuffix")}
            </small>
            <button
              className="icon-btn"
              onClick={() => setTool(null)}
              aria-label={t("home.closeToolAria")}
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
          <textarea
            placeholder={m().tools[activeTool.kind].placeholder}
            value={toolInput}
            onChange={(event) => setToolInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void runTool();
            }}
            aria-label={
              activeTool.kind === "voiceover"
                ? t("home.voiceoverTextAria")
                : t("home.toolPromptAria", { label: m().tools[activeTool.kind].label })
            }
            autoFocus
          />
          <div className="row">
            {activeTool.kind === "voiceover" && (
              <>
                <input
                  placeholder={t("home.voicePlaceholder")}
                  value={voice}
                  onChange={(event) => setVoice(event.target.value)}
                  aria-label={t("home.voiceAria")}
                />
                <Tip label={t("home.voiceInfoLabel")} hint={t("home.voiceInfoHint")} side="top">
                  <span className="info-dot" tabIndex={0} aria-label={t("home.voiceInfoAria")}>
                    <Info size={13} strokeWidth={1.8} />
                  </span>
                </Tip>
              </>
            )}
            {activeTool.kind === "clip" && (
              <>
                <input
                  placeholder={t("home.motionPlaceholder")}
                  value={motion}
                  onChange={(event) => setMotion(event.target.value)}
                  aria-label={t("home.motionAria")}
                />
                <Tip label={t("home.motionInfoLabel")} hint={t("home.motionInfoHint")} side="top">
                  <span className="info-dot" tabIndex={0} aria-label={t("home.motionInfoAria")}>
                    <Info size={13} strokeWidth={1.8} />
                  </span>
                </Tip>
              </>
            )}
            <div className="spacer" />
            <button className="btn-primary" onClick={() => void runTool()} disabled={busy}>
              <Sparkles size={14} strokeWidth={2} />
              {busy
                ? t("common.starting")
                : t("home.generateTool", { tool: m().tools[activeTool.kind].label.toLowerCase() })}
              <kbd>{t("home.ctrlEnter")}</kbd>
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
        <h3>{t("home.quickToolsHeading")}</h3>
        <span className="hint">{t("home.quickToolsHint")}</span>
      </div>
      <div className="quick-tools" role="group" aria-label={t("home.quickToolsAria")}>
        {TOOLS.map((entry) => {
          const Icon = entry.icon;
          const copy = m().tools[entry.kind];
          return (
            <Tip key={entry.kind} label={copy.tip} hint={t("home.noProjectHint")} side="bottom">
              <button
                className={tool === entry.kind ? "active" : ""}
                onClick={() => {
                  setTool(tool === entry.kind ? null : entry.kind);
                  setToolInput("");
                }}
                aria-label={t("home.toolButtonAria", { label: copy.label, tip: copy.tip })}
              >
                <Icon {...TOOL_ICON} />
                {copy.label}
              </button>
            </Tip>
          );
        })}
      </div>

      {ordered.length === 0 && (
        <div className="empty-state">
          <Clapperboard size={22} strokeWidth={1.5} aria-hidden="true" />
          <b>{t("home.emptyTitle")}</b>
          <p>{t("home.emptyBody")}</p>
          <button
            className="btn-ghost"
            onClick={() => {
              setTool(null);
              setPrompt(t("home.samplePrompt"));
              // The prompt box may be replaced by a tool panel right now —
              // focus after the re-render has mounted the textarea.
              requestAnimationFrame(() => promptRef.current?.focus());
            }}
          >
            {t("home.sampleQuote")}
            <ArrowUp size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}

      {ordered.length > 0 && (
        <div className="recent">
          <h2>{t("home.recent")}</h2>
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
