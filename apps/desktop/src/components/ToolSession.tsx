import { useEffect, useState } from "react";
import type { Screenplay } from "../api/types";
import { m, t } from "../i18n";
import { useApp } from "../store";
import { isSettled } from "../lib/status";
import { StatusRing } from "./StatusRing";

export function useScreenplay(url: string | null): Screenplay | null {
  const [screenplay, setScreenplay] = useState<Screenplay | null>(null);

  useEffect(() => {
    setScreenplay(null);
    if (!url) return;
    let stale = false;
    fetch(url)
      .then((response) => response.json())
      .then((data) => {
        if (!stale) setScreenplay(data as Screenplay);
      })
      .catch((err) => console.warn("script artifact fetch failed:", err));
    return () => {
      stale = true;
    };
  }, [url]);

  return screenplay;
}

export function ScriptTable({ screenplay }: { screenplay: Screenplay }) {
  return (
    <div className="script-view">
      <h2>{screenplay.title}</h2>
      {screenplay.hook && <p className="hook">{screenplay.hook}</p>}
      <table className="script-table">
        <thead>
          <tr>
            <th>{t("toolSession.table.scene")}</th>
            <th>{t("toolSession.table.narration")}</th>
            <th>{t("toolSession.table.visual")}</th>
            <th>{t("toolSession.table.length")}</th>
          </tr>
        </thead>
        <tbody>
          {screenplay.scenes.map((scene) => (
            <tr key={scene.id}>
              <td>{scene.id}</td>
              <td>{scene.narration}</td>
              <td>{scene.visual}</td>
              <td>{t("toolSession.lengthCell", { d: scene.duration_s })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Focused single-panel view for tool:* micro-projects — one node,
 * one preview, one download, and (for scripts) one promote path. */
export function ToolSession() {
  const { board, client, currentProject, promote, actionError } = useApp();
  const [promoting, setPromoting] = useState(false);

  const tool = currentProject?.mode.startsWith("tool:")
    ? currentProject.mode.slice("tool:".length)
    : null;
  const node = tool ? board?.aux[tool] : undefined;
  // The clip tool is a keyframe→clip graph: while the keyframe renders (the
  // long pole) the clip sits queued, so show the keyframe's live progress —
  // and its error, which would otherwise be hidden behind the clip's
  // secondary "missing upstream artifact" failure.
  const upstream = tool === "clip" ? board?.aux.keyframe : undefined;
  // A skipped keyframe is not the long pole — it is not being rendered at
  // all — so the display falls through to the tool node rather than pinning
  // itself to a stage that will never progress.
  const progressNode = upstream && !isSettled(upstream.status) ? upstream : node;
  const done = node ? isSettled(node.status) : false;
  const artifactUrl =
    node?.artifact_hash && client && currentProject
      ? client.artifactUrl(currentProject.id, node.artifact_hash)
      : null;
  const screenplay = useScreenplay(tool === "script" && done ? artifactUrl : null);

  if (!tool || !node) return <div className="banner">{t("toolSession.preparing")}</div>;

  const turnIntoVideo = async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      await promote();
    } finally {
      setPromoting(false);
    }
  };

  // Whichever node drives the display: the keyframe while it renders, else
  // the tool node. `?? node` narrows the type (node is non-null past the
  // guard) — progressNode itself is computed before it.
  const shown = progressNode ?? node;
  // Route the stage through the catalog (the raw "keyframe"/tool id was
  // untranslatable and disagreed with QueueTray's nodeLabel).
  const stageLabel =
    shown === upstream
      ? m().terms.kinds.keyframe
      : (m().tools as Record<string, { label: string }>)[tool].label;
  return (
    <div className="tool-session">
      <div className="tool-status">
        <StatusRing status={shown.status} progress={shown.progress} />
        <span style={{ textTransform: "capitalize" }}>{m().status[shown.status]}</span>
        {shown.status === "rendering" && <span>{Math.round(shown.progress * 100)}%</span>}
      </div>

      {shown.error && <div className="banner error">{shown.error}</div>}
      {!done && !shown.error && (
        <div className="banner">{t("toolSession.generating", { stage: stageLabel })}</div>
      )}

      {done && artifactUrl && (
        <>
          {(tool === "thumbnail" || tool === "image") && (
            <img
              className="tool-preview"
              src={artifactUrl}
              alt={t("toolSession.generatedAlt", { tool })}
            />
          )}
          {(tool === "voiceover" || tool === "music") && (
            <audio controls src={artifactUrl} aria-label={t("toolSession.audioAria", { tool })} />
          )}
          {tool === "clip" && (
            <video
              className="tool-preview"
              controls
              src={artifactUrl}
              aria-label={t("toolSession.clipPreview")}
            />
          )}
          {tool === "script" &&
            (screenplay ? (
              <ScriptTable screenplay={screenplay} />
            ) : (
              <div className="banner">{t("toolSession.loadingScript")}</div>
            ))}
          <div className="tool-actions">
            <a className="btn-ghost" href={artifactUrl} download>
              {t("common.download")}
            </a>
            {tool === "script" && (
              <button
                className="btn-primary"
                onClick={() => void turnIntoVideo()}
                disabled={promoting}
              >
                {promoting ? t("toolSession.creatingProject") : t("toolSession.turnIntoVideo")}
              </button>
            )}
          </div>
          {actionError?.scope === "promote" && (
            <p className="hint error-text" role="alert">
              {actionError.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
