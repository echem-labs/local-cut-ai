import { Pencil, Pin, Play, RotateCw, SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import type { SceneCardModel } from "../api/types";
import { t } from "../i18n";
import { remainingLabel } from "../lib/eta";
import { usePlayback } from "../lib/playback";
import { useApp } from "../store";
import { StatusPill } from "./StatusRing";
import { Tip } from "./Tooltip";

/** Average luminance of a loaded <img>, 0–1, or null when the canvas is
 * tainted (cross-origin without CORS) — dark detection is best-effort. */
function luminanceOf(img: HTMLImageElement): number | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 5;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 8, 5);
    const { data } = ctx.getImageData(0, 0, 8, 5);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return sum / (data.length / 4) / 255;
  } catch {
    return null;
  }
}

/** Scene card — the thumb has a designed treatment for every state
 * (review 3): queued = numbered slate, rendering = shimmer + live %,
 * draft/final = artifact + duration badge, failed = dimmed frame under
 * recovery choices, near-black artifacts get a number slate overlay so the
 * board never reads as a void. Draggable to reorder the cut. */
export function SceneCard({
  scene,
  dragging = false,
  onDragStart,
  onDragEnd,
  onDropSide,
  teachDraft = false,
  onTeachDismiss,
}: {
  scene: SceneCardModel;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Called on drop with true when dropped on the right half (insert after). */
  onDropSide?: (after: boolean) => void;
  /** First-ever rendering card carries the one-time draft-quality note. */
  teachDraft?: boolean;
  onTeachDismiss?: () => void;
}) {
  const { client, currentProject, selectedNode, select, regenerate, togglePin, applyNode } =
    useApp();
  const playScene = usePlayback((state) => state.play);
  const [dark, setDark] = useState(false);
  const [dropSide, setDropSide] = useState<"before" | "after" | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubBroken, setScrubBroken] = useState(false);
  const [editingWords, setEditingWords] = useState(false);
  const [wordsDraft, setWordsDraft] = useState("");
  const scrubRef = useRef<HTMLVideoElement>(null);
  const clip = scene.clip;
  const keyframe = scene.keyframe;
  const primary = keyframe ?? clip;
  const keyframeHash = keyframe?.artifact_hash ?? null;
  const selected = selectedNode === clip.node_id || selectedNode === keyframe?.node_id;
  const narrationText = scene.narration ? String(scene.narration.params.text ?? "") : "";
  const failed = clip.status === "failed";
  const rendering = clip.status === "rendering";
  const sceneNo = scene.scene_id.replace(/^s/, "");
  const duration = Number(clip.params.duration_s);
  const hasThumb = keyframeHash && client && currentProject;
  const clipUrl =
    clip.artifact_hash && client && currentProject
      ? client.artifactUrl(currentProject.id, clip.artifact_hash)
      : null;
  const timeLeft =
    rendering && currentProject
      ? remainingLabel(currentProject.id, clip.node_id, clip.progress)
      : null;

  // Inline narration editing (review 3 / Descript's insight): change the
  // words where you read them — the narration node re-renders on commit.
  // The ref makes close idempotent: Enter commits then blur re-fires on
  // unmount, and Escape must discard even though blur still commits.
  const editorLiveRef = useRef(false);
  const editorOpenedAtRef = useRef(0);
  const canEditWords =
    Boolean(scene.narration) && !rendering && !failed && !scene.narration?.pinned;
  const closeEditor = (commit: boolean) => {
    if (!editorLiveRef.current) return;
    editorLiveRef.current = false;
    setEditingWords(false);
    const next = wordsDraft.trim();
    if (commit && scene.narration && next && next !== narrationText) {
      void applyNode(scene.narration.node_id, { params: { text: next } });
    }
  };

  return (
    <div
      data-scene={scene.scene_id}
      className={[
        "scene-card",
        selected ? "selected" : "",
        rendering ? "rendering" : "",
        dragging ? "dragging" : "",
        dropSide ? `drop-${dropSide}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => select(primary.node_id)}
      role="button"
      tabIndex={0}
      aria-label={t("scene.cardAria", { n: sceneNo, status: t(`status.${clip.status}`) })}
      onKeyDown={(event) => {
        if (event.key === "Enter") select(primary.node_id);
        if (event.key.toLowerCase() === "r" && !clip.pinned) void regenerate(clip.node_id);
        if (event.key.toLowerCase() === "p") void togglePin(clip.node_id, !clip.pinned);
      }}
      draggable={Boolean(onDragStart)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragEnd={() => {
        setDropSide(null);
        onDragEnd?.();
      }}
      onDragOver={(event) => {
        if (!onDropSide) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setDropSide(event.clientX > rect.left + rect.width / 2 ? "after" : "before");
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(event) => {
        event.preventDefault();
        if (onDropSide) {
          const rect = event.currentTarget.getBoundingClientRect();
          onDropSide(event.clientX > rect.left + rect.width / 2);
        }
        setDropSide(null);
      }}
    >
      <div
        className="thumb"
        onMouseEnter={() => setScrubbing(true)}
        onMouseLeave={() => setScrubbing(false)}
        onMouseMove={(event) => {
          // Hover-scrub: mouse-X seeks a muted preview of the clip.
          const video = scrubRef.current;
          if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const frac = Math.max(0, Math.min(0.999, (event.clientX - rect.left) / rect.width));
          video.currentTime = frac * video.duration;
        }}
      >
        {hasThumb ? (
          <img
            src={client.artifactUrl(currentProject.id, keyframeHash)}
            alt={t("scene.stillAlt", { n: sceneNo })}
            className={failed ? "dim" : ""}
            crossOrigin="anonymous"
            onLoad={(event) => {
              const lum = luminanceOf(event.currentTarget);
              setDark(lum !== null && lum < 0.05);
            }}
          />
        ) : (
          <div className="thumb-slate" aria-hidden="true">
            <span className="num">{sceneNo}</span>
          </div>
        )}
        {clipUrl && !scrubBroken && scrubbing && !failed && (
          <video
            ref={scrubRef}
            className="scrub-video"
            src={clipUrl}
            muted
            preload="metadata"
            aria-hidden="true"
            onError={() => setScrubBroken(true)}
          />
        )}
        {/* near-black artifact: keep the frame but overlay a soft number
            slate so the card still reads as content */}
        {hasThumb && dark && !failed && (
          <div className="thumb-slate ghost" aria-hidden="true">
            <span className="num">{sceneNo}</span>
          </div>
        )}
        <StatusPill status={clip.status} progress={clip.progress} onThumb />
        {rendering && clip.progress > 0 && (
          <span className="thumb-progress">{Math.round(clip.progress * 100)}%</span>
        )}
        {clip.pinned && (
          <span className="pin-badge" title={t("scene.pinnedTitle")}>
            <Pin size={11} strokeWidth={1.8} />
          </span>
        )}
        {!rendering && Number.isFinite(duration) && (
          <span className="dur-badge">{t("scene.durValue", { d: duration })}</span>
        )}
        {/* failure ladder lives ON the dimmed frame (design mock): the
            thumb stays the stage, the choices sit at its foot */}
        {failed && (
          <div className="fail-acts">
            <button
              onClick={(event) => {
                event.stopPropagation();
                void regenerate(clip.node_id);
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <RotateCw size={11} strokeWidth={2} />
                {t("scene.failed.tryAgain")}
              </span>
              <small>{t("scene.failed.newTake")}</small>
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                select(clip.node_id);
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <SlidersHorizontal size={11} strokeWidth={2} />
                {t("scene.failed.adjust")}
              </span>
              <small>{t("scene.failed.adjustSub")}</small>
            </button>
          </div>
        )}
        {!failed && (
          <div className="acts">
            <Tip
              label={t("scene.actions.play.label")}
              hint={t("scene.actions.play.hint")}
              shortcut="Space"
            >
              <button
                aria-label={t("scene.actions.play.aria")}
                onClick={(event) => {
                  event.stopPropagation();
                  select(primary.node_id);
                  playScene(scene.scene_id, false);
                }}
              >
                <Play size={11} strokeWidth={2} />
              </button>
            </Tip>
            <Tip
              label={t("scene.actions.regenerate.label")}
              hint={t("scene.actions.regenerate.hint")}
              shortcut="R"
            >
              <button
                aria-label={t("scene.actions.regenerate.aria")}
                disabled={clip.pinned}
                onClick={(event) => {
                  event.stopPropagation();
                  void regenerate(clip.node_id);
                }}
              >
                <RotateCw size={12} strokeWidth={2} />
              </button>
            </Tip>
            <Tip
              label={clip.pinned ? t("scene.actions.pin.unpinLabel") : t("scene.actions.pin.label")}
              hint={t("scene.actions.pin.hint")}
              shortcut="P"
            >
              <button
                aria-label={clip.pinned ? t("scene.actions.pin.unpinAria") : t("scene.actions.pin.aria")}
                aria-pressed={clip.pinned}
                className={clip.pinned ? "on" : ""}
                onClick={(event) => {
                  event.stopPropagation();
                  void togglePin(clip.node_id, !clip.pinned);
                }}
              >
                <Pin size={11} strokeWidth={2} />
              </button>
            </Tip>
            <Tip label={t("scene.actions.edit.label")} hint={t("scene.actions.edit.hint")}>
              <button
                aria-label={t("scene.actions.edit.aria")}
                onClick={(event) => {
                  event.stopPropagation();
                  select(primary.node_id);
                }}
              >
                <Pencil size={11} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        )}
      </div>
      <div className="body">
        <div className="scene-line">
          <span className="scene-name">{t("scene.sceneName", { n: sceneNo })}</span>
          {/* design mock: — while rendering/failed, ~4s while queued */}
          <span className="scene-dur">
            {rendering || failed
              ? t("scene.dash")
              : clip.status === "queued" && Number.isFinite(duration)
                ? t("scene.durQueued", { d: duration })
                : Number.isFinite(duration)
                  ? t("scene.durValue", { d: duration })
                  : t("scene.dash")}
          </span>
        </div>
        {editingWords ? (
          <textarea
            className="narration-edit"
            value={wordsDraft}
            rows={2}
            autoFocus
            aria-label={t("scene.narrationAria", { n: sceneNo })}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setWordsDraft(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation(); // the card's R/P/Enter keys must not fire
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                closeEditor(true);
              }
              if (event.key === "Escape") closeEditor(false);
            }}
            onBlur={(event) => {
              // Selecting the scene can ADD the Details panel, and dockview
              // re-parents the board DOM — blurring this textarea with focus
              // going nowhere right as it opens. Refocus instead of treating
              // that as a commit-and-close.
              if (Date.now() - editorOpenedAtRef.current < 800 && !event.relatedTarget) {
                event.currentTarget.focus();
                return;
              }
              closeEditor(true);
            }}
          />
        ) : (
          <div
            className={`narration${canEditWords ? " editable" : ""}`}
            title={canEditWords ? t("scene.narrationEditTitle") : undefined}
            onClick={
              canEditWords
                ? (event) => {
                    event.stopPropagation();
                    // a narration click still selects the scene, exactly as
                    // it did when the click bubbled to the card root
                    select(primary.node_id);
                    setWordsDraft(narrationText);
                    editorLiveRef.current = true;
                    editorOpenedAtRef.current = Date.now();
                    setEditingWords(true);
                  }
                : undefined
            }
          >
            {rendering
              ? `${t("scene.rendering")}${clip.progress > 0 ? t("scene.renderingPct", { pct: Math.round(clip.progress * 100) }) : t("scene.ellipsis")}${timeLeft ? t("scene.renderingTime", { timeLeft }) : ""}`
              : failed
                ? t("scene.notRendered")
                : narrationText || t("scene.ellipsis")}
          </div>
        )}
      </div>
      {teachDraft && (
        <div className="draft-teach" role="note">
          <span>{t("scene.draftTeach")}</span>
          <button
            aria-label={t("common.gotIt")}
            title={t("common.gotIt")}
            onClick={(event) => {
              event.stopPropagation();
              onTeachDismiss?.();
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
