import { useEffect, useState } from "react";
import type { NodeState } from "../api/types";
import { useApp } from "../store";

/** Right drawer, exists only when something is selected.
 * Prompt/seed visible; steps/CFG/scheduler belong in a later Advanced fold. */
export function Inspector() {
  const { board, selectedNode, select, editPrompt, regenerate, applyTimeline } = useApp();
  const [prompt, setPrompt] = useState("");
  const [trimIn, setTrimIn] = useState("");
  const [trimOut, setTrimOut] = useState("");
  const [overlay, setOverlay] = useState("");

  const node =
    board && selectedNode
      ? [
          ...board.scenes.flatMap((s) => [s.keyframe, s.clip, s.narration]),
          ...Object.values(board.aux),
        ]
          .filter((n): n is NodeState => n !== null)
          .find((n) => n.node_id === selectedNode)
      : undefined;

  // Trim/overlay are presentation data — they live on the timeline node, not
  // the clip, so editing them re-cuts without re-rendering the scene.
  const sceneId = selectedNode?.endsWith(".clip")
    ? selectedNode.slice(0, -".clip".length)
    : null;
  const timelineParams = board?.aux.timeline?.params;

  // Re-seed from the server value only when the selection changes — board
  // refreshes must not clobber in-progress typing.
  useEffect(() => {
    setPrompt(String(node?.params.prompt ?? node?.params.text ?? ""));
    const trims = (timelineParams?.trims ?? {}) as Record<
      string,
      { in?: number; out?: number } | undefined
    >;
    const overlays = (timelineParams?.overlays ?? {}) as Record<string, string>;
    const trim = sceneId ? trims[sceneId] : undefined;
    setTrimIn(trim?.in != null ? String(trim.in) : "");
    setTrimOut(trim?.out != null ? String(trim.out) : "");
    setOverlay(sceneId ? String(overlays[sceneId] ?? "") : "");
  }, [selectedNode]);

  if (!node) return null;

  const patchTrim = (inValue: string, outValue: string) => {
    if (!sceneId) return;
    const trims = { ...((timelineParams?.trims ?? {}) as Record<string, unknown>) };
    const trim: Record<string, number> = {};
    const inNum = Number.parseFloat(inValue);
    const outNum = Number.parseFloat(outValue);
    if (Number.isFinite(inNum)) trim.in = inNum;
    if (Number.isFinite(outNum)) trim.out = outNum;
    if (Object.keys(trim).length > 0) trims[sceneId] = trim;
    else delete trims[sceneId];
    applyTimeline({ trims });
  };

  const patchOverlay = (value: string) => {
    if (!sceneId) return;
    const overlays = { ...((timelineParams?.overlays ?? {}) as Record<string, unknown>) };
    if (value) overlays[sceneId] = value;
    else delete overlays[sceneId];
    applyTimeline({ overlays });
  };

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
      {sceneId && (
        <>
          <div>
            <label>Trim</label>
            <div className="trim-row">
              <input
                type="number"
                min={0}
                step={0.1}
                placeholder="in"
                aria-label="Trim in (seconds)"
                value={trimIn}
                onChange={(event) => {
                  setTrimIn(event.target.value);
                  patchTrim(event.target.value, trimOut);
                }}
              />
              <input
                type="number"
                min={0}
                step={0.1}
                placeholder="out"
                aria-label="Trim out (seconds)"
                value={trimOut}
                onChange={(event) => {
                  setTrimOut(event.target.value);
                  patchTrim(trimIn, event.target.value);
                }}
              />
            </div>
            <div className="hint">Narration length still drives scene duration.</div>
          </div>
          <div>
            <label htmlFor="inspector-overlay">On-screen text</label>
            <input
              id="inspector-overlay"
              value={overlay}
              onChange={(event) => {
                setOverlay(event.target.value);
                patchOverlay(event.target.value);
              }}
            />
          </div>
        </>
      )}
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
