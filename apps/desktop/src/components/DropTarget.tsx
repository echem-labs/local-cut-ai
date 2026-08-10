/**
 * Drop a file on the app and it lands where it belongs.
 *
 * Window-level listeners rather than handlers on a div, for the same reason
 * global keys are: the target has to be the whole window, and a div only
 * receives what is dropped inside it. The default handlers have to be
 * suppressed everywhere regardless — a file dropped on a page Electron has
 * not been told about NAVIGATES THE WINDOW to it, replacing the running app
 * with a picture, with no way back but a reload.
 *
 * Audio goes through a consent dialog rather than straight to the engine. A
 * cloned voice is a real person's voice; `graph/patch.py` refuses a
 * `voice_ref` that is not a consented sample, and this is the surface that
 * earns the affirmation it sends. Dropping a file must not be a way around
 * a question a file picker asks.
 */
import { useEffect, useRef, useState } from "react";

import { dropKind, looksLikeDirectory } from "../lib/dropKind";
import { useDropTarget } from "../lib/dropTarget";
import { t } from "../i18n";
import { useApp } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { NewSceneDialog } from "./NewSceneDialog";

/**
 * How long a notice stays up on its own.
 *
 * A drop is over by the time this appears, so the bar is a receipt rather
 * than a thing to act on — and one left waiting to be dismissed is still on
 * screen during the NEXT drop, describing the wrong file. Long enough to
 * read a refusal, which is the longest thing it says.
 */
const NOTICE_MS = 10_000;

/** What a notice reports. The three the status tokens already name, so a
 *  drop result and a scene's state agree about what green means. */
type Notice = { text: string; tone: "success" | "warning" | "error" };

/**
 * Which scene the pointer was over, if any.
 *
 * Read off the DOM rather than tracked in state: the drop event names the
 * element it landed on, and every scene card already carries `data-scene`
 * for the board's own scroll-into-view. Anywhere else in the project — the
 * gaps in the grid, the timeline, the flowchart — means no scene, which is
 * the "make a new one" case.
 */
function sceneUnder(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-scene]")?.getAttribute("data-scene") ?? null;
}

/** What a drag is carrying, from the types alone — the files themselves are
 * not readable until the drop. */
function draggedKind(transfer: DataTransfer | null): "image" | "audio" | "mixed" {
  const types = [...(transfer?.items ?? [])].map((item) => item.type);
  if (types.length > 0 && types.every((type) => type.startsWith("image/"))) return "image";
  if (types.length > 0 && types.every((type) => type.startsWith("audio/"))) return "audio";
  return "mixed";
}

export function DropTarget() {
  const { uploadSceneImage, conditionScene, applySessionVoiceClone, currentProject } = useApp();
  const [over, setOver] = useState<"image" | "audio" | "mixed" | null>(null);
  /**
   * The scene under the pointer WHILE the drag is still in the air.
   *
   * The overlay used to say "add this image to your project" wherever you
   * were, so the one thing the user had to know — that dropping on a scene
   * means something different from dropping beside it — was the one thing it
   * did not say. A target-aware drop that looks identical to a target-blind
   * one reads as broken however correctly it behaves.
   */
  const [overScene, setOverScene] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  /** An uploaded image waiting for the words that make it a scene. */
  const [pendingScene, setPendingScene] = useState<{
    name: string;
    nodeId: string;
    file: File;
  } | null>(null);
  /** A scene that already has a picture, and the one offered to replace it. */
  const [pendingStill, setPendingStill] = useState<{ sceneId: string; file: File } | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  // Held while the pointer or the keyboard is on the bar. A notice that
  // clears itself on a timer is unreadable if it goes while being read, and
  // the longest thing this says is why a file was refused.
  const [held, setHeld] = useState(false);
  // dragenter/dragleave fire for every element the pointer crosses, so the
  // overlay would flicker on each boundary. Counting them means it closes
  // only when the drag has actually left the window.
  const depth = useRef(0);

  useEffect(() => {
    const onOver = (event: DragEvent): void => {
      // Both of these, on every event: preventing only `drop` still lets the
      // window navigate, because the default action is decided at dragover.
      event.preventDefault();
      // Tracked here rather than at the drop, because the point is to say
      // what WILL happen while there is still a choice about it. React bails
      // out when the value has not changed, so a per-pixel event is cheap.
      const scene = sceneUnder(event.target);
      setOverScene(scene);
      // Published so the card or panel under the pointer can light ITSELF up.
      // A full-window scrim cannot say "this one" — it covers the very thing
      // the answer is about.
      useDropTarget.getState().over(scene);
    };
    const onEnter = (event: DragEvent): void => {
      event.preventDefault();
      depth.current += 1;
      if (event.dataTransfer?.types.includes("Files")) setOver(draggedKind(event.dataTransfer));
    };
    const onLeave = (event: DragEvent): void => {
      event.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) {
        setOver(null);
        setOverScene(null);
        useDropTarget.getState().end();
      }
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      depth.current = 0;
      setOver(null);
      setOverScene(null);
      useDropTarget.getState().end();
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      // Resolved here, synchronously: `event.target` is live only for the
      // duration of the handler, and `accept` awaits an upload.
      void accept(files, sceneUnder(event.target));
    };

    window.addEventListener("dragover", onOver);
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
    // `accept` closes over the store actions above, which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function accept(files: File[], sceneId: string | null): Promise<void> {
    const file = files[0]!;
    if (looksLikeDirectory(file)) {
      setNotice({ text: t("drop.notAFile"), tone: "warning" });
      return;
    }
    const kind = dropKind(file);
    if (kind === "unsupported") {
      setNotice({ text: t("drop.unsupported", { name: file.name }), tone: "warning" });
      return;
    }
    // Audio asks first. Everything else is reversible from the canvas; a
    // voice sample carries an affirmation about someone else.
    if (kind === "audio") {
      setConsented(false);
      setPending(file);
      return;
    }
    // Where it landed decides what it means. On a scene card, the image is
    // that shot; anywhere else in an open project, it is a new scene. Read
    // before any await — `event.target` is gone by the time the upload
    // returns.
    if (sceneId) {
      await useAsStill(sceneId, file);
      return;
    }
    const { nodeId, error } = await uploadSceneImage(file);
    if (error || !nodeId) {
      setNotice({ text: error ?? t("errors.engineUnavailable"), tone: "error" });
      return;
    }
    if (files.length > 1) {
      setNotice({ text: t("drop.onlyFirst", { name: file.name }), tone: "warning" });
    }
    // The scene is not created here: `add_scene` leaves the words blank and
    // the compiler reads blank as "not ready", so a scene made now would sit
    // inert. The dialog collects them and lands the whole thing at once.
    setPendingScene({ name: file.name, nodeId, file });
  }

  /** Make this image the scene's still, asking first if one is already there. */
  async function useAsStill(sceneId: string, file: File): Promise<void> {
    const scene = useApp.getState().board?.scenes.find((entry) => entry.scene_id === sceneId);
    // What the card is DRAWING, which is what the user would be replacing —
    // `still` when they have supplied one before, the generated keyframe
    // otherwise. A scene with no picture yet is nothing to confirm about.
    const shown = scene?.still ?? scene?.keyframe;
    if (shown?.artifact_hash) {
      setPendingStill({ sceneId, file });
      return;
    }
    await applyStill(sceneId, file);
  }

  async function applyStill(sceneId: string, file: File): Promise<void> {
    const error = await conditionScene(sceneId, file);
    setNotice(
      error
        ? { text: error, tone: "error" }
        : {
            text: t("drop.stillApplied", { name: file.name, n: sceneId.replace(/^s/, "") }),
            tone: "success",
          },
    );
  }

  const confirmVoice = async (): Promise<void> => {
    if (!pending || !consented) return;
    setBusy(true);
    const error = await applySessionVoiceClone(pending);
    setBusy(false);
    setPending(null);
    setNotice(
      error
        ? { text: error, tone: "error" }
        : { text: t("drop.voiceApplied", { name: pending.name }), tone: "success" },
    );
  };

  // Clears itself, unless it is being read. Keyed on the notice object, so a
  // second drop restarts the clock rather than inheriting the first's.
  useEffect(() => {
    if (!notice || held) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, held]);

  /**
   * What the overlay promises, which has to be what the drop will do.
   *
   * Four answers, not one: an image over a scene becomes that shot, an image
   * anywhere else in an open project becomes a new one, an image with no
   * project open cannot land at all, and audio is a voice sample either way.
   */
  function overlayMessage(): string {
    if (over === "audio") return t("drop.overlayAudio");
    if (over === "mixed") return t("drop.overlayMixed");
    if (!currentProject) return t("drop.overlayNeedsProject");
    return t("drop.overlayNewScene");
  }

  // A scrim over the whole window answers "where will this land?" with
  // "everywhere", and it covers the very card the answer is about. So it is
  // drawn only for the drop that really is app-wide — a new scene, a voice
  // sample, a file with nowhere to go. When the pointer is ON a scene, that
  // scene lights itself up instead (see `.scene-card.drop-target`), and the
  // window stays legible underneath.
  const showScrim = over !== null && !(over === "image" && overScene && currentProject);

  return (
    <>
      {showScrim && (
        <div className="drop-overlay" role="note" aria-label={t("drop.overlayAria")}>
          <div className="drop-overlay-card">{overlayMessage()}</div>
        </div>
      )}
      {pending && (
        <Modal
          title={t("drop.consentTitle")}
          subtitle={t("drop.consentSubtitle", { name: pending.name })}
          onClose={() => setPending(null)}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setPending(null)}>
                {t("drop.consentCancel")}
              </button>
              <button
                className="btn-primary"
                disabled={!consented || busy}
                onClick={() => void confirmVoice()}
              >
                {t("drop.consentConfirm")}
              </button>
            </>
          }
        >
          <p>{t("drop.consentBody")}</p>
          <label className="consent">
            <input
              type="checkbox"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
            {t("drop.consentCheck")}
          </label>
        </Modal>
      )}
      {pendingScene && (
        <NewSceneDialog
          name={pendingScene.name}
          nodeId={pendingScene.nodeId}
          file={pendingScene.file}
          onClose={() => setPendingScene(null)}
          onAdded={() => {
            const { name } = pendingScene;
            setPendingScene(null);
            setNotice({ text: t("drop.sceneAdded", { name }), tone: "success" });
          }}
        />
      )}
      {pendingStill && (
        <ConfirmDialog
          title={t("drop.replaceTitle")}
          message={t("drop.replaceBody", {
            n: pendingStill.sceneId.replace(/^s/, ""),
            name: pendingStill.file.name,
          })}
          confirmLabel={t("drop.replaceConfirm")}
          onConfirm={() => {
            const { sceneId, file } = pendingStill;
            setPendingStill(null);
            void applyStill(sceneId, file);
          }}
          onCancel={() => setPendingStill(null)}
        />
      )}
      {notice && (
        <div
          className={`banner drop-notice ${notice.tone}`}
          role="status"
          onMouseEnter={() => setHeld(true)}
          onMouseLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          <span>{notice.text}</span>
          <button className="btn-ghost" onClick={() => setNotice(null)}>
            {t("common.dismiss")}
          </button>
        </div>
      )}
    </>
  );
}
