import { useEffect, useState } from "react";
import type { NodeState } from "../api/types";
import { useApp } from "../store";

/** Right drawer, exists only when something is selected.
 * Prompt/seed visible; steps/CFG/scheduler belong in a later Advanced fold. */
export function Inspector() {
  const { board, selectedNode, select, editPrompt, regenerate } = useApp();
  const [prompt, setPrompt] = useState("");

  const node =
    board && selectedNode
      ? [
          ...board.scenes.flatMap((s) => [s.keyframe, s.clip, s.narration]),
          ...Object.values(board.aux),
        ]
          .filter((n): n is NodeState => n !== null)
          .find((n) => n.node_id === selectedNode)
      : undefined;

  // Re-seed from the server value only when the selection changes — board
  // refreshes must not clobber in-progress typing.
  useEffect(() => {
    setPrompt(String(node?.params.prompt ?? node?.params.text ?? ""));
  }, [selectedNode]);

  if (!node) return null;

  return (
    <aside className="inspector" aria-label="Inspector">
      <div style={{ display: "flex", alignItems: "center" }}>
        <h2 style={{ flex: 1 }}>{node.node_id}</h2>
        <button className="btn-ghost" onClick={() => select(null)} aria-label="Close inspector">
          ✕
        </button>
      </div>
      <div>
        <label htmlFor="inspector-prompt">Prompt</label>
        <textarea
          id="inspector-prompt"
          rows={5}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>
      <div>
        <label>Seed</label>
        <input value={node.seed} readOnly />
      </div>
      <button
        className="btn-primary"
        onClick={() => {
          void editPrompt(node.node_id, prompt);
        }}
      >
        Apply & regenerate
      </button>
      <button className="btn-ghost" onClick={() => void regenerate(node.node_id)}>
        New seed 🔄
      </button>
      {node.error && <div className="banner error">{node.error}</div>}
    </aside>
  );
}
