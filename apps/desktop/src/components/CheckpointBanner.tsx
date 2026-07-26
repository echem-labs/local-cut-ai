import { useState } from "react";
import type { Checkpoint } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { isSettled } from "../lib/status";
import { ScriptTable, useScreenplay } from "./ToolSession";

/** Beginner-mode gate above the scene board: one message + one accent
 * approve button per checkpoint, gone once both are passed. */
export function CheckpointBanner() {
  const { board, client, currentProject, approve, actionError } = useApp();
  const [showScript, setShowScript] = useState(false);
  const [busy, setBusy] = useState(false);

  const approvals = currentProject?.approvals ?? [];
  const script = board?.aux.script;
  const scriptReady = script ? isSettled(script.status) : false;
  // A skipped keyframe counts as ready: the scene is conditioned on an
  // uploaded image, so no keyframe is coming. Waiting for one leaves the
  // storyboard checkpoint — and with it all of beginner mode — unreachable.
  const keyframesReady =
    !!board &&
    board.scenes.length > 0 &&
    board.scenes.every((scene) => !scene.keyframe || isSettled(scene.keyframe.status));

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
            ? t("checkpoint.reviewScript")
            : t("checkpoint.reviewStoryboard")}
        </span>
        <div className="spacer" />
        {stage === "script" && (
          <button className="btn-ghost" onClick={() => setShowScript(!showScript)}>
            {showScript ? t("checkpoint.hideScript") : t("checkpoint.viewScript")}
          </button>
        )}
        <button className="btn-primary" disabled={busy} onClick={() => void run(stage)}>
          {busy
            ? t("checkpoint.approving")
            : stage === "script"
              ? t("checkpoint.approveScript")
              : t("checkpoint.approveStoryboard")}
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
          <div className="hint">{t("checkpoint.loadingScript")}</div>
        ))}
    </div>
  );
}
