import { useState } from "react";
import type { Checkpoint } from "../api/types";
import { useApp } from "../store";
import { ScriptTable, useScreenplay } from "./ToolSession";

const READY = ["draft", "final", "pinned"];

/** Beginner-mode gate above the scene board: one message + one accent
 * approve button per checkpoint, gone once both are passed. */
export function CheckpointBanner() {
  const { board, client, currentProject, approve, actionError } = useApp();
  const [showScript, setShowScript] = useState(false);
  const [busy, setBusy] = useState(false);

  const approvals = currentProject?.approvals ?? [];
  const script = board?.aux.script;
  const scriptReady = script ? READY.includes(script.status) : false;
  const keyframesReady =
    !!board &&
    board.scenes.length > 0 &&
    board.scenes.every((scene) => !scene.keyframe || READY.includes(scene.keyframe.status));

  const stage: Checkpoint | null = !approvals.includes("script")
    ? scriptReady
      ? "script"
      : null
    : !approvals.includes("storyboard") && keyframesReady
      ? "storyboard"
      : null;

  const scriptUrl =
    script?.artifact_hash && client && currentProject
      ? client.artifactUrl(currentProject.id, script.artifact_hash)
      : null;
  const screenplay = useScreenplay(stage === "script" && showScript ? scriptUrl : null);

  if (!stage) return null;

  const run = async (checkpoint: Checkpoint) => {
    if (busy) return;
    setBusy(true);
    try {
      await approve(checkpoint);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="banner checkpoint">
      <div className="row">
        <span>
          {stage === "script"
            ? "Review the script, then approve to generate the storyboard."
            : "Review the keyframes, then approve to render video."}
        </span>
        <div className="spacer" />
        {stage === "script" && (
          <button className="btn-ghost" onClick={() => setShowScript(!showScript)}>
            {showScript ? "Hide script" : "View script"}
          </button>
        )}
        <button className="btn-primary" disabled={busy} onClick={() => void run(stage)}>
          {busy
            ? "Approving…"
            : stage === "script"
              ? "Approve script"
              : "Approve storyboard"}
        </button>
      </div>
      {actionError?.scope === "approve" && (
        <p className="hint error-text" role="alert">
          {actionError.message}
        </p>
      )}
      {stage === "script" &&
        showScript &&
        (screenplay ? (
          <ScriptTable screenplay={screenplay} />
        ) : (
          <div className="hint">Loading script…</div>
        ))}
    </div>
  );
}
