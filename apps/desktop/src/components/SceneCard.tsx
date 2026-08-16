import { Pencil, Pin, Play, RotateCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { SceneCardModel } from "../api/types";
import { t } from "../i18n";
import { remainingLabel } from "../lib/eta";
import { displaySeconds } from "../lib/formats";
import { useIsDropTarget } from "../lib/dropTarget";
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

/** Is this drag carrying files from outside the window, rather than a card
 *  being dragged to a new place in the cut? `types` is the only thing that
 *  answers during `dragover` — the files themselves are unreadable until the
 *  drop, by design. */
const isFileDrag = (event: React.DragEvent): boolean =>
  [...(event.dataTransfer?.types ?? [])].includes("Files");

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
  onRemove,
  teachDraft = false,
  onTeachDismiss,
}: {
  scene: SceneCardModel;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Called on drop with true when dropped on the right half (insert after). */
  onDropSide?: (after: boolean) => void;
  /** Asks to take this scene out of the cut. The board owns the confirm and
   * the refusal, because both outlive the card: a removal that goes through
   * unmounts the thing that would have reported it. */
  onRemove?: () => void;
  /** First-ever rendering card carries the one-time draft-quality note. */
  teachDraft?: boolean;
  onTeachDismiss?: () => void;
}) {
  const { client, currentProject, selectedNode, select, regenerate, togglePin, applyNode } =
    useApp();
  const playScene = usePlayback((state) => state.play);
  // A picture is in the air over THIS card. The card says so itself rather
  // than letting a window-wide scrim say it, because a scrim covers the one
  // thing the answer is about.
  const dropTarget = useIsDropTarget(scene.scene_id);
  const [dark, setDark] = useState(false);
  const [dropSide, setDropSide] = useState<"before" | "after" | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubBroken, setScrubBroken] = useState(false);
  const [editingWords, setEditingWords] = useState(false);
  const [wordsDraft, setWordsDraft] = useState("");
  const scrubRef = useRef<HTMLVideoElement>(null);
  const clip = scene.clip;
  // The picture this scene will actually be built from: the image the user
  // supplied when there is one, and the generated keyframe otherwise. Drawing
  // `keyframe` unconditionally showed the model's render over a clip made
  // from the user's photo, because displacing that node leaves its artifact
  // where it was.
  const shown = scene.still ?? scene.keyframe;
  // What CLICKING the card selects, which is not what it draws. The still is
  // an ASSET node: it has no prompt, no seed and no model, so selecting it
  // opened the Inspector's bare aux-node editor — an empty Prompt box over
  // "Apply & regenerate" — instead of the scene's own Image/Motion/Voice
  // panel. A scene built from a dropped picture then looked nothing like the
  // scene beside it, for a difference the user never asked for.
  const primary = scene.keyframe ?? clip;
  const keyframeHash = shown?.artifact_hash ?? null;
  // Both picture nodes, not just the one being drawn. `keyframe` above
  // resolves to the user's still when there is one — but the generated node
  // stays on the graph and stays clickable on the flowchart, where it is the
  // tile marked "not needed". Comparing only against the drawn node meant
  // selecting that tile highlighted no card at all.
  const selected =
    selectedNode === clip.node_id ||
    selectedNode === scene.still?.node_id ||
    selectedNode === scene.keyframe?.node_id;
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
        dropTarget ? "drop-target" : "",
        dropSide ? `drop-${dropSide}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => select(primary.node_id)}
      // A GROUP, not a button, even though the whole card is clickable: play,
      // regenerate, pin, edit, the two failure choices and the narration
      // textarea are all real controls inside it, and ARIA specifies the
      // children of a `button` as presentational — nesting them inside one
      // hides every action on the card from assistive technology, however
      // reachable they stay by Tab. NodeCanvas resolves the same shape the
      // same way. The card keeps its focus and its shortcut keys; its select
      // affordance is the scene name below, which is a real button.
      role="group"
      tabIndex={0}
      aria-label={t("scene.cardAria", { n: sceneNo, status: t(`status.${clip.status}`) })}
      onKeyDown={(event) => {
        // The card's OWN keys, not its children's. React events bubble, so
        // without this every focusable control inside the card carries the
        // board's destructive shortcuts: `r` on the focused scene-name button
        // spends a render and discards the current take, `p` pins, and Enter
        // fires that button's onClick AND this branch, selecting twice for one
        // keystroke. The narration textarea already stops propagation for the
        // same reason; a guard here covers the next control too, rather than
        // making every one of them remember.
        if (event.target !== event.currentTarget) return;
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
        // A drag carrying FILES is not a reorder — it comes from outside the
        // window and means "use this here". Both kinds arrive at these
        // handlers, and React's run BEFORE the window listener that owns
        // file drops, so this card is what has to tell them apart. Judged on
        // the drag's types, because `dataTransfer.files` stays empty until
        // the drop: dragover has nothing else to go on, and the drop has to
        // agree with what dragover already decided.
        if (!onDropSide || isFileDrag(event)) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setDropSide(event.clientX > rect.left + rect.width / 2 ? "after" : "before");
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(event) => {
        // Deliberately NOT prevented for a file: preventing the default is
        // what claims the drop, and the file surface would never hear the
        // one it exists for. The indicator still clears — a file dragged
        // across the board must not leave a reorder marker behind.
        setDropSide(null);
        if (isFileDrag(event)) return;
        event.preventDefault();
        if (onDropSide) {
          const rect = event.currentTarget.getBoundingClientRect();
          onDropSide(event.clientX > rect.left + rect.width / 2);
        }
      }}
    >
      {dropTarget && (
        // `note`, not `status`: this is a label on a thing, not an
        // announcement of something that happened. Pointer-transparent, or it
        // would become the drop's target and take the card's place in
        // `closest("[data-scene]")` — the card would stop being the answer at
        // the exact moment the user let go.
        <div className="drop-here" role="note">
          <span>{t("drop.overlayStill", { n: sceneNo })}</span>
        </div>
      )}
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
          <span className="thumb-progress">
            {t("scene.pct", { pct: Math.round(clip.progress * 100) })}
          </span>
        )}
        {clip.pinned && (
          /* The wrapper takes the badge's place in the corner of the thumb:
             an absolutely-positioned child inside a static wrapper still
             draws in the right spot, but the bubble is placed off the
             WRAPPER's box, which would be back in the flow. */
          <Tip label={t("scene.pinnedTitle")} className="pin-badge-slot">
            <span className="pin-badge">
              <Pin size={11} strokeWidth={1.8} />
            </span>
          </Tip>
        )}
        {!rendering && Number.isFinite(duration) && (
          <span className="dur-badge">{t("scene.durValue", { d: displaySeconds(duration) })}</span>
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
            {/* Last in the row, and the only one that wears a warning
                colour on hover — the same place and the same rule as the
                trash in every other list in the app. Pinning is the app's
                word for "leave this alone", so a pinned scene refuses here
                rather than asking a question the engine will decline. */}
            {onRemove && (
              <Tip
                label={t("scene.actions.remove.label")}
                hint={t("scene.actions.remove.hint")}
              >
                <button
                  className="act-remove"
                  aria-label={t("scene.actions.remove.aria", { n: sceneNo })}
                  disabled={clip.pinned}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove();
                  }}
                >
                  <Trash2 size={11} strokeWidth={2} />
                </button>
              </Tip>
            )}
          </div>
        )}
      </div>
      <div className="body">
        <div className="scene-line">
          {/* The card's own "select this scene" action, as a real control:
              the root is a group now, so without this the only way to open a
              scene in the Inspector would be a click on non-interactive
              chrome — which is not an action assistive tech can find. */}
          <button
            className="scene-name"
            aria-pressed={selected}
            onClick={(event) => {
              event.stopPropagation();
              select(primary.node_id);
              // Hand focus to the card, which is what a selected scene means
              // here: the board's Space and arrow keys are window listeners
              // that bail on `target.tagName === "BUTTON"` so a focused
              // control keeps its own keyboard, and leaving focus on this
              // one killed play-preview and scene-to-scene navigation right
              // after the gesture that advertises itself as "select".
              event.currentTarget.closest<HTMLElement>(".scene-card")?.focus();
            }}
          >
            {t("scene.sceneName", { n: sceneNo })}
          </button>
          {/* design mock: — while rendering/failed, ~4s while queued */}
          <span className="scene-dur">
            {rendering || failed
              ? t("scene.dash")
              : clip.status === "queued" && Number.isFinite(duration)
                ? t("scene.durQueued", { d: displaySeconds(duration) })
                : Number.isFinite(duration)
                  ? t("scene.durValue", { d: displaySeconds(duration) })
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
          (() => {
            const words = (
              <div
                className={`narration${canEditWords ? " editable" : ""}`}
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
            );
            // Only the editable state says anything, so only it is wrapped —
            // a bubble on a read-only line would fire over every card in the
            // storyboard on the way to anything else. The wrapper has to be a
            // block: the line inside it is a two-line `-webkit-box` clamp,
            // and an inline-flex parent takes its width away.
            return canEditWords ? (
              <Tip label={t("scene.narrationEditTitle")} className="narration-slot">
                {words}
              </Tip>
            ) : (
              words
            );
          })()
        )}
      </div>
      {teachDraft && (
        <div className="draft-teach" role="note">
          <span>{t("scene.draftTeach")}</span>
          <Tip label={t("common.gotIt")}>
            <button
              aria-label={t("common.gotIt")}
              onClick={(event) => {
                event.stopPropagation();
                onTeachDismiss?.();
              }}
            >
              ✕
            </button>
          </Tip>
        </div>
      )}
    </div>
  );
}
