import { ChevronDown, History, SendHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EngineError } from "../api/client";
import type { EditProposal, EditResult } from "../api/types";
import { plural, t } from "../i18n";
import { pendingCheckpoint } from "../lib/checkpoints";
import { type LogEntry, MAX_LOG_ENTRIES, loadLog, saveLog } from "../lib/editlog";
import { orderedScenes } from "../lib/order";
import { usePlayback } from "../lib/playback";
import { useApp } from "../store";
import { ModelsPopover } from "./ModelsPopover";

/** Floor for the scope menu's width — the `150px` half of the shared
 * `.dropdown-menu` rule's `min-width: max(100%, 150px)`, which this menu
 * cannot inherit once it is positioned against the viewport. */
const SCOPE_MENU_MIN_W = 150;

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
    enhance,
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
  /** Where the open scope menu sits, in viewport coordinates.
   *
   * It has to be `position: fixed`, because the composer lives in a dockview
   * panel and a panel's overflow clips anything absolutely positioned inside
   * it. The Prompt panel is about one control tall, so a project with seven
   * scenes lost the top of its own list — "Whole video" and the first
   * scenes were cut off, and there was no way to reach them. Same treatment
   * `panel-help-pop` already gets, for the same reason. */
  const [scopeMenu, setScopeMenu] = useState<{
    left: number;
    bottom: number;
    maxHeight: number;
    minWidth: number;
  } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  // The compiled plan waiting for a yes. Cleared on project change, on
  // Discard, and whenever it turns out to be stale.
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  /** The script rewrite waiting for a yes — the note it would be given. */
  const [confirmScript, setConfirmScript] = useState<string | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scopeChipRef = useRef<HTMLButtonElement>(null);

  /** Open the scope menu above the chip, in viewport coordinates, no taller
   * than the room above it. The composer sits at the foot of the window, so
   * upward is the only direction with space — and the ceiling is the window,
   * not the panel. */
  const openScopeMenu = () => {
    const rect = scopeChipRef.current?.getBoundingClientRect();
    if (!rect) return;
    setScopeMenu({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 8,
      maxHeight: Math.max(120, rect.top - 16),
      // What the shared rule says as `min-width: max(100%, 150px)`, computed
      // rather than inherited. A percentage resolves against the containing
      // block, and going from `absolute` (the chip) to `fixed` (the viewport)
      // silently changed which one that is — the menu stretched to the width
      // of the window. The intent is unchanged: at least as wide as the chip
      // it hangs off, never narrower than a readable menu.
      minWidth: Math.max(rect.width, SCOPE_MENU_MIN_W),
    });
    setScopeOpen(true);
  };

  const projectId = currentProject?.id ?? null;
  useEffect(() => {
    setLog(projectId ? loadLog(projectId) : []);
    setScopeOverride(null);
    setFeedback(null);
    setReplyApplied(false);
    setError(null);
    setProposal(null);
    setConfirmScript(null);
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

  // The coordinates were measured when the menu opened, so anything that
  // moves the chip — a window resize, a panel being dragged, a scroll —
  // would strand it. Close instead of trying to follow.
  useEffect(() => {
    if (!scopeOpen) return;
    const close = () => setScopeOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [scopeOpen]);

  const selectedScene = selectedNode?.includes(".") ? selectedNode.split(".")[0] : null;
  /** The screenplay is editable through this box too, but not by the same
   * door. `EDITABLE_PARAMS` has no entry for the script node, so the LLM
   * edit view never shows it — a plan can rewrite a scene's narration and
   * can never rewrite the script it came from. `/script/enhance` is that
   * verb, and until now it existed only on the quick-tool page: a project
   * sitting at its script checkpoint had no way to say "rewrite this,
   * shorter". Offered only once there IS a script to amend. */
  const canEnhanceScript = !!board?.aux.script;
  /** Sitting at the script gate, with nothing else picked, what the box is
   * for IS the script. A selected scene still wins — that is a deliberate
   * click, and this is only a default. */
  const scriptStage = pendingCheckpoint(currentProject, board) === "script";
  const scope =
    scopeOverride ?? selectedScene ?? (scriptStage && canEnhanceScript ? "script" : "project");
  const scopeLabel =
    scope === "script"
      ? t("composer.theScript")
      : scope === "project"
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
    // The script has no dry run — the engine cannot say what a rewritten
    // screenplay will contain without writing one. So the preview this scope
    // CAN offer is what the rewrite costs: a new screenplay re-expands the
    // graph, and every scene it produces is written fresh. Asked first,
    // because the plan card next to it set the expectation that nothing in
    // this box lands unannounced.
    if (scope === "script") {
      setConfirmScript(instruction);
      return;
    }
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

  /** Send the note to `/script/enhance`. Internally a `/patch` on the script
   * node — feedback plus the screenplay it amends — so the re-render, the
   * cycle check and the undo entry all come from the chokepoint rather than
   * a private path. Undo is what makes saying yes here reversible. */
  const rewriteScript = async () => {
    if (!confirmScript || rewriting) return;
    setError(null);
    setRewriting(true);
    const notes = confirmScript;
    const message = await enhance(notes);
    setRewriting(false);
    if (message) {
      setError(message);
      return;
    }
    setConfirmScript(null);
    setFeedback(t("composer.scriptRewriting"));
    pushLog({
      at: Date.now(),
      instruction: notes,
      summary: t("composer.scriptRewritten"),
      dirty: ["script"],
      warnings: [],
    });
    setText("");
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

      {/* What a script rewrite costs, since what it will SAY cannot be
          previewed. Same shape as the plan card beside it and the same
          reason: nothing typed into this box lands unannounced. */}
      {confirmScript && (
        <div className="edit-plan" role="group" aria-label={t("composer.scriptConfirmAria")}>
          <p className="plan-summary">{t("composer.scriptConfirm")}</p>
          <p className="plan-counts">{t("composer.scriptConfirmCost")}</p>
          <div className="plan-actions">
            <button
              className="btn-primary"
              disabled={rewriting}
              title={t("terms.tips.rewriteScript")}
              onClick={() => void rewriteScript()}
            >
              {rewriting ? t("composer.scriptRewritingShort") : t("composer.scriptRewrite")}
            </button>
            <button
              className="btn-ghost"
              disabled={rewriting}
              onClick={() => setConfirmScript(null)}
            >
              {t("composer.discard")}
            </button>
          </div>
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
          {/* `plan-chips`, not the log's `.chips`: that one is styled only as
              a descendant of `.edit-log-entry`, so the same markup here drew
              bare browser buttons. A class that works in one ancestor and
              nowhere else should not be spelled as though it works anywhere. */}
          {proposal.dirty.length > 0 && (
            <div className="plan-chips">
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
            ref={scopeChipRef}
            className="scope-chip"
            aria-haspopup="listbox"
            aria-expanded={scopeOpen}
            onClick={() => (scopeOpen ? setScopeOpen(false) : openScopeMenu())}
            title={t("composer.scopeTitle")}
          >
            {scopeLabel}
            <ChevronDown size={11} strokeWidth={2} />
          </button>
          {scopeOpen && scopeMenu && (
            <div
              className="dropdown-menu scope-menu"
              role="listbox"
              aria-label={t("composer.scopeMenuAria")}
              // `position` rides with the coordinates rather than sitting in
              // the stylesheet: viewport coordinates mean nothing under any
              // other positioning scheme, so a CSS edit must not be able to
              // decouple the two.
              style={{
                position: "fixed",
                left: scopeMenu.left,
                bottom: scopeMenu.bottom,
                maxHeight: scopeMenu.maxHeight,
                minWidth: scopeMenu.minWidth,
              }}
            >
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
              {/* Above the scenes because it is upstream of them: a rewritten
                  script is what the scenes are made FROM. */}
              {canEnhanceScript && (
                <button
                  role="option"
                  aria-selected={scope === "script"}
                  className={scope === "script" ? "selected" : ""}
                  onClick={() => {
                    setScopeOverride("script");
                    setScopeOpen(false);
                  }}
                >
                  <span className="grow">{t("composer.theScript")}</span>
                </button>
              )}
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
