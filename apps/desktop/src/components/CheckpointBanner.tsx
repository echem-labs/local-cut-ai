import { useState } from "react";
import type { Checkpoint } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { pendingCheckpoint } from "../lib/checkpoints";
import { ScriptTable, useScreenplay } from "./ToolSession";

/** Beginner-mode gate above the scene board: one message + one accent
 * approve button per checkpoint, gone once both are passed. */
export function CheckpointBanner() {
  const { board, client, currentProject, approve, actionError } = useApp();
  const [showScript, setShowScript] = useState(false);
  const [busy, setBusy] = useState(false);

  const script = board?.aux.script;
  // Shared with the stalled-project notice, which has to know that a gate —
  // not a lost queue — is why nothing is running. Two copies of this answer
  // is how the two halves of a gate come to disagree.
  const stage: Checkpoint | null = pendingCheckpoint(currentProject, board);

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
