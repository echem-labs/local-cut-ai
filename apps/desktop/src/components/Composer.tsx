import { ChevronDown, History, SendHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EditResult } from "../api/types";
import { plural, t } from "../i18n";
import { orderedScenes } from "../lib/order";
import { usePlayback } from "../lib/playback";
import { useApp } from "../store";

interface LogEntry {
  at: number;
  instruction: string;
  summary: string;
  dirty: string[];
  warnings: string[];
}

const logKey = (projectId: string) => `localcut.editlog.${projectId}`;

function loadLog(projectId: string): LogEntry[] {
  try {
    const raw = localStorage.getItem(logKey(projectId));
    const parsed = raw ? (JSON.parse(raw) as LogEntry[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-40) : [];
  } catch {
    return [];
  }
}

/** The one composer (review 3): a scope-aware natural-language edit box
 * that is ALSO the command palette — typed text fuzzy-matches quick
 * commands, anything else goes to the engine's NL editor. Ctrl+K focuses
 * it from anywhere. The activity log above it keeps the session's
 * conversation ("what changed my scene 3?"). */
export function Composer() {
  const { board, currentProject, selectedNode, select, edit, editBusy, regenerate, togglePin } =
    useApp();
  const [text, setText] = useState("");
  const [scopeOverride, setScopeOverride] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const projectId = currentProject?.id ?? null;
  useEffect(() => {
    setLog(projectId ? loadLog(projectId) : []);
    setScopeOverride(null);
    setFeedback(null);
    setError(null);
  }, [projectId]);

  // Ctrl+K focuses the composer from anywhere in the project.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close the scope menu on outside click.
  useEffect(() => {
    if (!scopeOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setScopeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [scopeOpen]);

  const selectedScene = selectedNode?.includes(".") ? selectedNode.split(".")[0] : null;
  // Scope: explicit override wins; else it follows the selection.
  const scope = scopeOverride ?? selectedScene ?? "project";
  const scopeLabel =
    scope === "project"
      ? t("composer.wholeVideo")
      : t("composer.scene", { n: scope.replace(/^s/, "") });

  // Quick commands the palette matches before falling through to NL edit.
  const commands = useMemo(() => {
    const list: { label: string; hint: string; run: () => void }[] = [];
    if (!board || !currentProject) return list;
    const playback = usePlayback.getState();
    const scenes = orderedScenes(board);
    list.push({
      label: t("composer.cmdPlay"),
      hint: t("composer.cmdPlayHint"),
      run: () => {
        if (scenes.length === 0) return;
        const start = selectedScene ?? scenes[0].scene_id;
        select(`${start}.clip`);
        playback.play(start, true);
      },
    });
    if (selectedScene) {
      const scene = scenes.find((s) => s.scene_id === selectedScene);
      if (scene) {
        const sceneNo = selectedScene.replace(/^s/, "");
        list.push({
          label: t("composer.cmdRegen", { n: sceneNo }),
          hint: t("composer.cmdRegenHint"),
          run: () => void regenerate(scene.clip.node_id),
        });
        list.push({
          label: scene.clip.pinned
            ? t("composer.cmdUnpin", { n: sceneNo })
            : t("composer.cmdPin", { n: sceneNo }),
          hint: t("composer.cmdPinHint"),
          run: () => void togglePin(scene.clip.node_id, !scene.clip.pinned),
        });
      }
    }
    return list;
  }, [board, currentProject, selectedScene, select, regenerate, togglePin]);

  const query = text.trim().toLowerCase();
  const matches =
    query.length > 0
      ? commands.filter((command) => command.label.toLowerCase().includes(query))
      : [];
  useEffect(() => setCommandIndex(0), [query]);

  const pushLog = (entry: LogEntry) => {
    if (!projectId) return;
    const next = [...log, entry].slice(-40);
    setLog(next);
    try {
      localStorage.setItem(logKey(projectId), JSON.stringify(next));
    } catch {
      /* storage full — the log is a nicety */
    }
  };

  const submit = async () => {
    const instruction = text.trim();
    if (!instruction || editBusy) return;
    setError(null);
    setFeedback(null);
    try {
      const result: EditResult | null = await edit(instruction, scope);
      if (result) {
        const summary =
          result.ops === 0
            ? t("composer.noChanges") +
              (result.summary ? t("composer.summarySuffix", { summary: result.summary }) : "")
            : plural("composer.rerendering", result.dirty.length, {
                summary: result.summary || t("composer.editApplied"),
              });
        const skipped =
          result.warnings.length > 0 ? plural("composer.skipped", result.warnings.length) : "";
        setFeedback(summary + skipped);
        pushLog({
          at: Date.now(),
          instruction,
          summary:
            result.summary ||
            (result.ops === 0 ? t("composer.noChangesLog") : t("composer.editApplied")),
          dirty: result.dirty,
          warnings: result.warnings,
        });
        if (result.ops > 0) setText("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!board || board.scenes.length === 0) return null;
  const sceneOptions = orderedScenes(board).map((scene) => scene.scene_id);

  return (
    <div className="composer-wrap" ref={rootRef}>
      {logOpen && log.length > 0 && (
        <div className="edit-log" aria-label={t("composer.historyAria")}>
          {[...log].reverse().map((entry) => (
            <div key={entry.at} className="edit-log-entry">
              <div className="you">{entry.instruction}</div>
              <div className="did">
                {entry.summary}
                {entry.dirty.length > 0 && (
                  <span className="chips">
                    {entry.dirty.slice(0, 6).map((id) => (
                      <button
                        key={id}
                        onClick={() => select(id)}
                        title={t("composer.showChanged")}
                      >
                        {id.includes(".")
                          ? t("composer.scene", { n: id.split(".")[0].replace(/^s/, "") })
                          : id}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="composer">
        <div className="composer-scope">
          <button
            className="scope-chip"
            aria-haspopup="listbox"
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen(!scopeOpen)}
            title={t("composer.scopeTitle")}
          >
            {scopeLabel}
            <ChevronDown size={11} strokeWidth={2} />
          </button>
          {scopeOpen && (
            <div className="dropdown-menu" role="listbox" aria-label={t("composer.scopeMenuAria")}>
              <button
                role="option"
                aria-selected={scope === "project"}
                className={scope === "project" ? "selected" : ""}
                onClick={() => {
                  setScopeOverride("project");
                  setScopeOpen(false);
                }}
              >
                <span className="grow">{t("composer.wholeVideo")}</span>
              </button>
              {sceneOptions.map((id) => (
                <button
                  key={id}
                  role="option"
                  aria-selected={scope === id}
                  className={scope === id ? "selected" : ""}
                  onClick={() => {
                    setScopeOverride(id);
                    setScopeOpen(false);
                  }}
                >
                  <span className="grow">{t("composer.scene", { n: id.replace(/^s/, "") })}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="composer-input">
          {matches.length > 0 && (
            <div className="palette" role="listbox" aria-label={t("composer.commandsAria")}>
              {matches.map((command, index) => (
                <button
                  key={command.label}
                  role="option"
                  aria-selected={index === commandIndex}
                  className={index === commandIndex ? "focused" : ""}
                  onMouseEnter={() => setCommandIndex(index)}
                  onClick={() => {
                    command.run();
                    setText("");
                  }}
                >
                  <span className="grow">{command.label}</span>
                  <small>{command.hint}</small>
                </button>
              ))}
              <div className="palette-hint">{t("composer.paletteHint")}</div>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={text}
            rows={2}
            placeholder={t("composer.inputPlaceholder")}
            aria-label={t("composer.inputAria")}
            disabled={editBusy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (matches.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setCommandIndex(
                    (index) => (index + delta + matches.length) % matches.length,
                  );
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                  event.preventDefault();
                  matches[commandIndex].run();
                  setText("");
                  return;
                }
              }
              // Enter applies; Shift+Enter makes a new line.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
              if (event.key === "Escape") setText("");
            }}
          />
        </div>

        {log.length > 0 && (
          <button
            className={`icon-btn-sm${logOpen ? " active" : ""}`}
            aria-label={t("composer.historyAria")}
            aria-pressed={logOpen}
            title={t("composer.historyTitle")}
            onClick={() => setLogOpen(!logOpen)}
          >
            <History size={13} strokeWidth={1.8} />
          </button>
        )}
        <button
          className="composer-send"
          aria-label={t("composer.sendAria")}
          disabled={editBusy || !text.trim() || matches.length > 0}
          onClick={() => void submit()}
          title={t("composer.sendTitle")}
        >
          <SendHorizontal size={13} strokeWidth={2} />
        </button>
      </div>
      {editBusy && <div className="hint composer-hint">{t("composer.thinking")}</div>}
      {feedback && !editBusy && <div className="hint composer-hint">{feedback}</div>}
      {error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
