import { ChevronDown, History, SendHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EngineError } from "../api/client";
import type { EditProposal, EditResult } from "../api/types";
import { plural, t } from "../i18n";
import { type LogEntry, MAX_LOG_ENTRIES, loadLog, saveLog } from "../lib/editlog";
import { orderedScenes } from "../lib/order";
import { usePlayback } from "../lib/playback";
import { useApp } from "../store";
import { ModelsPopover } from "./ModelsPopover";

/** The one composer (review 3): a scope-aware natural-language edit box
 * that is ALSO the command palette — typed text fuzzy-matches quick
 * commands, anything else goes to the engine's NL editor. Ctrl+K focuses
 * it from anywhere. The activity log above it keeps the session's
 * conversation ("what changed my scene 3?"). */
export function Composer() {
  const {
    board,
    currentProject,
    selectedNode,
    select,
    proposeEdit,
    applyEditPlan,
    editBusy,
    regenerate,
    togglePin,
    history,
    undoEdit,
  } = useApp();
  const [text, setText] = useState("");
  // Did the reply on screen actually change the graph? Not `ops > 0`: the
  // engine records no history entry for a plan whose ops leave the graph
  // byte-identical (an LLM that echoes a prompt back unchanged still emits
  // one), so the newest recorded mutation is still some EARLIER edit —
  // offering Undo on that reply reverts the earlier one. Only the history
  // top moving proves this reply is what the next undo would revert.
  const [replyApplied, setReplyApplied] = useState(false);
  // Depth alone is not that proof: it stops growing at the engine's
  // UNDO_LIMIT, so the top's identity has to be part of the mark.
  const historyMark = (): string => {
    const top = useApp.getState().history;
    return [top?.undo_depth ?? 0, top?.undo_top?.kind ?? "", top?.undo_top?.summary ?? ""].join(
      " ",
    );
  };
  // Undo covers the edit that just landed: it recorded something, and that
  // something is still the newest recorded mutation (an edit-shaped undo
  // top — a later regenerate or inspector patch retires the offer).
  const undoable = replyApplied && history?.undo_top?.kind === "edit";
  const [scopeOverride, setScopeOverride] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  // The compiled plan waiting for a yes. Cleared on project change, on
  // Discard, and whenever it turns out to be stale.
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const projectId = currentProject?.id ?? null;
  useEffect(() => {
    setLog(projectId ? loadLog(projectId) : []);
    setScopeOverride(null);
    setFeedback(null);
    setReplyApplied(false);
    setError(null);
    setProposal(null);
  }, [projectId]);

  // Ctrl+K belongs to the global command palette now (review 4 §SH4);
  // the composer takes focus via click or the palette's own entries.

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
    const next = [...log, entry].slice(-MAX_LOG_ENTRIES);
    setLog(next);
    saveLog(projectId, next);
  };

  /**
   * Propose, don't apply.
   *
   * The instruction used to go straight to the graph: a sentence typed into
   * a box silently rewrote the project, and the only way to find out what it
   * had done was to read the reply afterwards and press Undo. The engine has
   * always been able to compile a plan and report it without committing
   * anything — `dry_run` saves nothing, enqueues nothing, records no history
   * entry and fires no event — so the plan is shown first and lands only
   * when the user says so.
   */
  const submit = async () => {
    const instruction = text.trim();
    if (!instruction || editBusy) return;
    setError(null);
    setFeedback(null);
    setReplyApplied(false);
    setProposal(null);
    try {
      const proposed = await proposeEdit(instruction, scope);
      if (!proposed) return;
      if (proposed.ops === 0) {
        // Nothing to preview and nothing to apply. Reported as a reply
        // rather than an empty card offering an Apply that would do nothing.
        setFeedback(
          t("composer.noChanges") +
            (proposed.summary ? t("composer.summarySuffix", { summary: proposed.summary }) : ""),
        );
        pushLog({
          at: Date.now(),
          instruction,
          summary: proposed.summary || t("composer.noChangesLog"),
          dirty: [],
          warnings: proposed.warnings,
        });
        return;
      }
      setProposal(proposed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Land the plan on screen. The revision it was compiled against travels
   * with it, so an edit made in another window (or by the CLI) between the
   * preview and this click refuses with a 409 rather than applying to a
   * project the preview no longer describes. */
  const applyProposal = async () => {
    if (!proposal || editBusy) return;
    const instruction = text.trim();
    setError(null);
    try {
      const before = historyMark();
      const result: EditResult | null = await applyEditPlan(proposal, scope);
      if (!result) return;
      setProposal(null);
      setFeedback(
        plural("composer.rerendering", result.dirty.length, {
          summary: result.summary || t("composer.editApplied"),
        }) + (result.warnings.length > 0 ? plural("composer.skipped", result.warnings.length) : ""),
      );
      setReplyApplied(historyMark() !== before);
      pushLog({
        at: Date.now(),
        instruction,
        summary: result.summary || t("composer.editApplied"),
        dirty: result.dirty,
        warnings: result.warnings,
      });
      setText("");
    } catch (err) {
      // A stale plan is its own outcome, not a generic failure: the preview
      // describes a graph that no longer exists, so the plan is dropped and
      // the instruction kept for a re-propose. Anything else leaves the
      // proposal up — the user can try Apply again.
      if (err instanceof EngineError && err.status === 409) {
        setProposal(null);
        setError(t("composer.planStale"));
        return;
      }
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

      {/* What the edit would do, before it does it. `group`, not `dialog`:
          it does not trap focus and the composer stays usable behind it —
          you can reword the instruction and propose again without
          dismissing anything. */}
      {proposal && (
        <div className="edit-plan" role="group" aria-label={t("composer.planAria")}>
          <p className="plan-summary">{proposal.summary || t("composer.editApplied")}</p>
          <p className="plan-counts">
            {plural("composer.planOps", proposal.ops)}
            {proposal.dirty.length > 0 && plural("composer.planDirty", proposal.dirty.length)}
          </p>
          {proposal.dirty.length > 0 && (
            <div className="chips">
              {proposal.dirty.slice(0, 8).map((id) => (
                <button key={id} onClick={() => select(id)} title={t("composer.showChanged")}>
                  {id.includes(".")
                    ? t("composer.scene", { n: id.split(".")[0].replace(/^s/, "") })
                    : id}
                </button>
              ))}
            </div>
          )}
          {/* Warnings are ops the compiler REFUSED — the plan lands without
              them, so they are part of what Apply means, not an aside. */}
          {proposal.warnings.length > 0 && (
            <ul className="plan-warnings">
              {proposal.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="plan-actions">
            <button
              className="btn-primary"
              disabled={editBusy}
              title={t("terms.tips.applyEdit")}
              onClick={() => void applyProposal()}
            >
              {editBusy ? t("composer.applying") : t("composer.apply")}
            </button>
            <button className="btn-ghost" disabled={editBusy} onClick={() => setProposal(null)}>
              {t("composer.discard")}
            </button>
          </div>
        </div>
      )}

      <div className="composer">
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

        <div className="composer-controls">
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

        <div className="spacer" />

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
        <ModelsPopover opens="up" />
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
      </div>
      {editBusy && <div className="hint composer-hint">{t("composer.thinking")}</div>}
      {feedback && !editBusy && (
        <div className="hint composer-hint">
          {feedback}
          {undoable && (
            <button
              className="composer-undo"
              title={t("composer.undoTitle")}
              onClick={() => {
                setFeedback(null);
                setReplyApplied(false);
                void undoEdit().then((message) => setError(message));
              }}
            >
              {t("composer.undo")}
            </button>
          )}
        </div>
      )}
      {error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
