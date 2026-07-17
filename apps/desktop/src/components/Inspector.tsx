import { useEffect, useState } from "react";
import type { NodeState } from "../api/types";
import { EditPrompt } from "./EditPrompt";
import { useApp } from "../store";

/** Right drawer, exists only when something is selected. The advanced fold
 * exposes every generation parameter the engine will honor — params, seed,
 * model override, pinning — all through the same patch ops the NL editor
 * compiles to. */
export function Inspector() {
  const { board, selectedNode, select, applyNode, togglePin, regenerate, applyTimeline } =
    useApp();
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState("");
  const [model, setModel] = useState("");
  const [motion, setMotion] = useState("");
  const [voice, setVoice] = useState("");
  const [duration, setDuration] = useState("");
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
  // Any scene member (keyframe/clip/narration) anchors a scene-scoped edit.
  const editSceneId = selectedNode?.includes(".") ? selectedNode.split(".")[0] : null;
  const timelineParams = board?.aux.timeline?.params;

  // Which content param this node reads, and which extras it understands.
  const contentKey =
    selectedNode?.endsWith(".narration") || selectedNode === "voiceover"
      ? "text"
      : selectedNode === "music"
        ? "brief"
        : "prompt";
  const isClip = selectedNode ? /\.clip\d*$/.test(selectedNode) : false;
  const isNarration = contentKey === "text";
  // Model overrides only make sense where alternative backends exist
  // (e.g. cloud:kling-2.5 for a hero shot, cloud:claude-… for the script).
  const modelEditable = selectedNode
    ? isClip || ["script", "thumbnail"].includes(selectedNode) || selectedNode.endsWith(".keyframe")
    : false;

  // Re-seed from the server value only when the selection changes — board
  // refreshes must not clobber in-progress typing.
  useEffect(() => {
    setPrompt(String(node?.params.prompt ?? node?.params.text ?? node?.params.brief ?? ""));
    setSeed(node ? String(node.seed) : "");
    setModel(node?.model ?? "");
    setMotion(String(node?.params.motion ?? ""));
    setVoice(String(node?.params.voice ?? ""));
    setDuration(node?.params.duration_s != null ? String(node.params.duration_s) : "");
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

  // Re-sync the seed only when the server value itself moved (New seed,
  // NL edit): an unchanged-seed refresh must not clobber a half-typed one,
  // and a stale field must not silently revert a regeneration on Apply.
  useEffect(() => {
    setSeed(node ? String(node.seed) : "");
  }, [node?.seed]);

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

  // Only what actually changed goes on the wire — an untouched field must
  // not dirty the node and trigger a re-render.
  const apply = () => {
    const params: Record<string, unknown> = {};
    if (prompt !== String(node.params[contentKey] ?? "")) params[contentKey] = prompt;
    if (isClip && motion !== String(node.params.motion ?? "")) params.motion = motion;
    if (isClip) {
      const value = Number.parseFloat(duration);
      if (Number.isFinite(value) && value !== node.params.duration_s) params.duration_s = value;
    }
    if (isNarration && voice !== String(node.params.voice ?? "")) params.voice = voice;
    const seedValue = Number.parseInt(seed, 10);
    const modelValue = model.trim() || null;
    void applyNode(node.node_id, {
      params,
      seed: Number.isFinite(seedValue) && seedValue !== node.seed ? seedValue : undefined,
      model: modelEditable && modelValue !== node.model ? modelValue : undefined,
    });
  };

  return (
    <aside className="inspector" aria-label="Inspector">
      <div style={{ display: "flex", alignItems: "center" }}>
        <h2 style={{ flex: 1 }}>{node.node_id}</h2>
        <button
          className="btn-ghost"
          onClick={() => void togglePin(node.node_id, !node.pinned)}
          aria-label={node.pinned ? "Unpin node" : "Pin node"}
          title={node.pinned ? "Unpin — allow regeneration" : "Pin — lock from regeneration"}
        >
          {node.pinned ? "📌 Unpin" : "📌 Pin"}
        </button>
        <button className="btn-ghost" onClick={() => select(null)} aria-label="Close inspector">
          ✕
        </button>
      </div>
      {node.pinned && (
        <div className="hint">Pinned — this node keeps its current output until unpinned.</div>
      )}
      <div>
        <label htmlFor="inspector-prompt">Prompt</label>
        <textarea
          id="inspector-prompt"
          rows={5}
          value={prompt}
          disabled={node.pinned}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>
      {isClip && (
        <div>
          <label htmlFor="inspector-motion">Motion (camera direction)</label>
          <input
            id="inspector-motion"
            value={motion}
            disabled={node.pinned}
            onChange={(event) => setMotion(event.target.value)}
          />
        </div>
      )}
      {isClip && (
        <div>
          <label htmlFor="inspector-duration">Clip duration (s)</label>
          <input
            id="inspector-duration"
            type="number"
            min={1}
            max={15}
            step={0.5}
            value={duration}
            disabled={node.pinned}
            onChange={(event) => setDuration(event.target.value)}
          />
          <div className="hint">Source length — narration still drives scene timing.</div>
        </div>
      )}
      {isNarration && (
        <div>
          <label htmlFor="inspector-voice">Voice</label>
          <input
            id="inspector-voice"
            value={voice}
            disabled={node.pinned}
            onChange={(event) => setVoice(event.target.value)}
          />
        </div>
      )}
      <div>
        <label htmlFor="inspector-seed">Seed</label>
        <input
          id="inspector-seed"
          type="number"
          value={seed}
          disabled={node.pinned}
          onChange={(event) => setSeed(event.target.value)}
        />
      </div>
      {modelEditable && (
        <div>
          <label htmlFor="inspector-model">Model override</label>
          <input
            id="inspector-model"
            value={model}
            placeholder="engine default"
            disabled={node.pinned}
            onChange={(event) => setModel(event.target.value)}
          />
          <div className="hint">e.g. cloud:kling-2.5 for a hero shot (BYOK, billed per clip)</div>
        </div>
      )}
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
      <button className="btn-primary" onClick={apply} disabled={node.pinned}>
        Apply & regenerate
      </button>
      <button
        className="btn-ghost"
        onClick={() => void regenerate(node.node_id)}
        disabled={node.pinned}
      >
        New seed 🔄
      </button>
      {editSceneId && (
        <div>
          <label>Edit scene with a prompt</label>
          <EditPrompt scope={editSceneId} placeholder='"same scene, but at night"' />
        </div>
      )}
      {node.error && <div className="banner error">{node.error}</div>}
    </aside>
  );
}
