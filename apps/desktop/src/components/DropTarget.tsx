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
import { t } from "../i18n";
import { useApp } from "../store";
import { Modal } from "./Modal";

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

/** What a drag is carrying, from the types alone — the files themselves are
 * not readable until the drop. */
function draggedKind(transfer: DataTransfer | null): "image" | "audio" | "mixed" {
  const types = [...(transfer?.items ?? [])].map((item) => item.type);
  if (types.length > 0 && types.every((type) => type.startsWith("image/"))) return "image";
  if (types.length > 0 && types.every((type) => type.startsWith("audio/"))) return "audio";
  return "mixed";
}

export function DropTarget() {
  const { addDroppedImage, applySessionVoiceClone } = useApp();
  const [over, setOver] = useState<"image" | "audio" | "mixed" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<File | null>(null);
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
    };
    const onEnter = (event: DragEvent): void => {
      event.preventDefault();
      depth.current += 1;
      if (event.dataTransfer?.types.includes("Files")) setOver(draggedKind(event.dataTransfer));
    };
    const onLeave = (event: DragEvent): void => {
      event.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(null);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      depth.current = 0;
      setOver(null);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      void accept(files);
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
    // `accept` closes over the two store actions, which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function accept(files: File[]): Promise<void> {
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
    const error = await addDroppedImage(file);
    // A refusal is the app declining to do something ("open a video first"),
    // an error is it trying and failing. Both are the store's message; only
    // the second is a fault.
    if (error) setNotice({ text: error, tone: "error" });
    else if (files.length > 1)
      setNotice({ text: t("drop.onlyFirst", { name: file.name }), tone: "warning" });
    else setNotice({ text: t("drop.addedImage", { name: file.name }), tone: "success" });
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

  return (
    <>
      {over && (
        <div className="drop-overlay" role="note" aria-label={t("drop.overlayAria")}>
          <div className="drop-overlay-card">
            {t(
              over === "image"
                ? "drop.overlayImage"
                : over === "audio"
                  ? "drop.overlayAudio"
                  : "drop.overlayMixed",
            )}
          </div>
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
