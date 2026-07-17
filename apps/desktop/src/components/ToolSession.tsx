import { useEffect, useState } from "react";
import type { Screenplay } from "../api/types";
import { useApp } from "../store";
import { StatusRing } from "./StatusRing";

const READY = ["draft", "final", "pinned"];

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
            <th>Scene</th>
            <th>Narration</th>
            <th>Visual</th>
            <th>Length</th>
          </tr>
        </thead>
        <tbody>
          {screenplay.scenes.map((scene) => (
            <tr key={scene.id}>
              <td>{scene.id}</td>
              <td>{scene.narration}</td>
              <td>{scene.visual}</td>
              <td>~{scene.duration_s}s</td>
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
  const done = node ? READY.includes(node.status) : false;
  const artifactUrl =
    node?.artifact_hash && client && currentProject
      ? client.artifactUrl(currentProject.id, node.artifact_hash)
      : null;
  const screenplay = useScreenplay(tool === "script" && done ? artifactUrl : null);

  if (!tool || !node) return <div className="banner">Preparing the tool session…</div>;

  const turnIntoVideo = async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      await promote();
    } finally {
      setPromoting(false);
    }
  };

  return (
    <div className="tool-session">
      <div className="tool-status">
        <StatusRing status={node.status} progress={node.progress} />
        <span style={{ textTransform: "capitalize" }}>{node.status}</span>
        {node.status === "rendering" && <span>{Math.round(node.progress * 100)}%</span>}
      </div>

      {node.error && <div className="banner error">{node.error}</div>}
      {!done && !node.error && <div className="banner">Generating {tool}…</div>}

      {done && artifactUrl && (
        <>
          {(tool === "thumbnail" || tool === "image") && (
            <img className="tool-preview" src={artifactUrl} alt={`Generated ${tool}`} />
          )}
          {(tool === "voiceover" || tool === "music") && (
            <audio controls src={artifactUrl} aria-label={`${tool} preview`} />
          )}
          {tool === "clip" && (
            <video className="tool-preview" controls src={artifactUrl} aria-label="Clip preview" />
          )}
          {tool === "script" &&
            (screenplay ? (
              <ScriptTable screenplay={screenplay} />
            ) : (
              <div className="banner">Loading script…</div>
            ))}
          <div className="tool-actions">
            <a className="btn-ghost" href={artifactUrl} download>
              Download
            </a>
            {tool === "script" && (
              <button
                className="btn-primary"
                onClick={() => void turnIntoVideo()}
                disabled={promoting}
              >
                {promoting ? "Creating project…" : "Turn into a video"}
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
