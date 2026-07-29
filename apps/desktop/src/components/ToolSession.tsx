import { useEffect, useState } from "react";
import type { Job, Screenplay } from "../api/types";
import { m, t } from "../i18n";
import { useApp } from "../store";
import { spokenSeconds } from "../lib/formats";
import { isSettled } from "../lib/status";
import { shortDuration } from "../lib/time";
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

/** The screenplay as portable Markdown — what the Copy button puts on the
 * clipboard. Reads fine as plain text too. */
export function screenplayMarkdown(screenplay: Screenplay): string {
  const lines = [`# ${screenplay.title}`, ""];
  if (screenplay.hook) lines.push(`> ${screenplay.hook}`, "");
  for (const scene of screenplay.scenes) {
    lines.push(`## ${scene.id} · ~${Math.round(spokenSeconds(scene.narration))}s`, "");
    lines.push(scene.narration, "");
    if (scene.visual) lines.push(`*Visual:* ${scene.visual}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function ScriptTable({
  screenplay,
  targetS,
}: {
  screenplay: Screenplay;
  targetS?: number;
}) {
  // Spoken time, not the script model's per-scene duration_s claim — nothing
  // downstream reads that field, and the assembled video will not either
  // (see SPEECH_WORDS_PER_S in lib/formats.ts).
  const totalS = screenplay.scenes.reduce(
    (sum, scene) => sum + spokenSeconds(scene.narration),
    0,
  );
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
              <td>{t("toolSession.lengthCell", { d: Math.round(spokenSeconds(scene.narration)) })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        {targetS
          ? t("toolSession.spokenTotalVsTarget", { total: Math.round(totalS), target: targetS })
          : t("toolSession.spokenTotal", { total: Math.round(totalS) })}
      </p>
    </div>
  );
}

/** Focused single-panel view for tool:* micro-projects — one node,
 * one preview, one download, and (for scripts) one promote path. */
export function ToolSession() {
  const { board, client, currentProject, promote, actionError, allJobs, regenerate, enhance } =
    useApp();
  const [promoting, setPromoting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notes, setNotes] = useState("");
  const [enhancing, setEnhancing] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

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

  // The job that produced what's on screen — its model and wall time are the
  // render's provenance. Newest DONE job for the tool node wins (a stale
  // failed retry must not claim a good artifact, and vice versa).
  const renderJob = done
    ? allJobs
        .filter(
          (job) =>
            job.project_id === currentProject?.id &&
            job.spec.node_id === node.node_id &&
            job.status === "done",
        )
        .reduce<Job | null>(
          (best, job) => (best && best.created_at >= job.created_at ? best : job),
          null,
        )
    : null;
  const tookS =
    renderJob?.started_at != null && renderJob?.finished_at != null
      ? renderJob.finished_at - renderJob.started_at
      : null;
  const targetS =
    typeof node.params?.target_duration_s === "number"
      ? node.params.target_duration_s
      : undefined;

  const turnIntoVideo = async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      await promote();
    } finally {
      setPromoting(false);
    }
  };

  const copyScript = async () => {
    if (!screenplay) return;
    try {
      await navigator.clipboard.writeText(screenplayMarkdown(screenplay));
      setCopied(true);
    } catch (err) {
      console.warn("copy failed:", err);
    }
  };

  const sendEnhance = async () => {
    const trimmed = notes.trim();
    if (!trimmed || enhancing) return;
    setEnhancing(true);
    try {
      await enhance(trimmed);
      if (!useApp.getState().actionError) setNotes("");
    } finally {
      setEnhancing(false);
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
        {renderJob?.model && <small className="hint">{renderJob.model}</small>}
        {tookS != null && (
          <small className="hint">{t("toolSession.took", { t: shortDuration(tookS) })}</small>
        )}
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
              <ScriptTable screenplay={screenplay} targetS={targetS} />
            ) : (
              <div className="banner">{t("toolSession.loadingScript")}</div>
            ))}
          <div className="tool-actions">
            <a className="btn-ghost" href={artifactUrl} download>
              {t("common.download")}
            </a>
            {tool === "script" && screenplay && (
              <button className="btn-ghost" onClick={() => void copyScript()}>
                {copied ? t("toolSession.copied") : t("common.copy")}
              </button>
            )}
            <button className="btn-ghost" onClick={() => void regenerate(node.node_id)}>
              {t("toolSession.regenerate")}
            </button>
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
          {tool === "script" && (
            <div className="tool-enhance">
              <input
                value={notes}
                placeholder={t("toolSession.enhancePlaceholder")}
                aria-label={t("toolSession.enhanceAria")}
                onChange={(event) => setNotes(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void sendEnhance();
                }}
              />
              <button
                className="btn-ghost"
                onClick={() => void sendEnhance()}
                disabled={enhancing || !notes.trim()}
              >
                {enhancing ? t("toolSession.enhancing") : t("toolSession.enhance")}
              </button>
            </div>
          )}
          {actionError?.scope === "promote" && (
            <p className="hint error-text" role="alert">
              {actionError.message}
            </p>
          )}
          {actionError?.scope === "enhance" && (
            <p className="hint error-text" role="alert">
              {actionError.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
