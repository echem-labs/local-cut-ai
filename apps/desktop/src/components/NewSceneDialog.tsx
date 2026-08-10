/**
 * The two things a scene made from a dropped picture still needs.
 *
 * `add_scene` leaves prompt and narration blank, and the compiler reads
 * blank as "not ready" and never enqueues it — so a scene built from a photo
 * would sit inert until somebody typed. Asking here is the only moment the
 * user is already thinking about this image.
 *
 * The Generate button is an offer, never a gate: the fields work perfectly
 * well typed by hand, and the button is what turns the picture into a first
 * draft of them. It always spends a cloud key, because there is no local
 * model that can see — so it says so under the button rather than surprising
 * anyone, and a machine with no key never sees the button at all.
 */
import { useEffect, useRef, useState } from "react";

import { t } from "../i18n";
import { useApp } from "../store";
import { Modal } from "./Modal";

export function NewSceneDialog({
  name,
  nodeId,
  onClose,
  onAdded,
}: {
  /** The dropped file's name — what the dialog is about, to the user. */
  name: string;
  /** The asset already uploaded, which is what the model will look at. */
  nodeId: string;
  onClose: () => void;
  /** The scene landed. Failure never reaches here — it stays in the dialog,
   *  beside the fields the user would edit to retry. */
  onAdded: () => void;
}) {
  const { addSceneFromImage, suggestScene, client } = useApp();
  const [narration, setNarration] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canGenerate, setCanGenerate] = useState(false);
  const firstField = useRef<HTMLTextAreaElement>(null);

  // No key, no button. Offering a control that can only fail is worse than
  // not offering it — the engine refuses with a message about Settings that
  // the user has to read to discover the button never worked here.
  //
  // Asked rather than read from the store because nothing else in the app
  // needs the provider slate outside Settings, and a field kept fresh for
  // one dialog is a field that goes stale everywhere else.
  useEffect(() => {
    if (!client) return;
    let live = true;
    void client
      .listProviders()
      .then((providers) => {
        if (!live) return;
        setCanGenerate(
          providers.some((p) => p.configured && p.capabilities.includes("vision")),
        );
      })
      .catch(() => {
        // A slate we could not fetch is not a reason to block the dialog —
        // the fields are the point and they work without it.
        if (live) setCanGenerate(false);
      });
    return () => {
      live = false;
    };
  }, [client]);

  const generate = async (): Promise<void> => {
    setWriting(true);
    setError(null);
    const result = await suggestScene(nodeId);
    setWriting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // Filled in, not appended: this is a draft the user edits, and the
    // fields are empty in the case the button exists for.
    setNarration(result.narration ?? "");
    setPrompt(result.prompt ?? "");
  };

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const message = await addSceneFromImage(nodeId, {
      narration: narration.trim(),
      prompt: prompt.trim(),
    });
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    onAdded();
  };

  const ready = narration.trim().length > 0 && prompt.trim().length > 0;

  return (
    <Modal
      title={t("drop.sceneTitle")}
      subtitle={t("drop.sceneSubtitle", { name })}
      size="m"
      onClose={onClose}
      initialFocus={firstField}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            {t("drop.sceneCancel")}
          </button>
          <button className="btn-primary" onClick={() => void add()} disabled={!ready || busy}>
            {busy ? t("drop.sceneAdding") : t("drop.sceneAdd")}
          </button>
        </>
      }
    >
      <p>{t("drop.sceneBody")}</p>

      {canGenerate && (
        <div className="field">
          <button className="btn-outline" onClick={() => void generate()} disabled={writing || busy}>
            {writing ? t("drop.sceneGenerating") : t("drop.sceneGenerate")}
          </button>
          <div className="hint">{t("drop.sceneGenerateHint")}</div>
        </div>
      )}

      <label className="field">
        <span>{t("drop.sceneNarration")}</span>
        <textarea
          ref={firstField}
          rows={3}
          value={narration}
          disabled={writing}
          placeholder={t("drop.sceneNarrationPlaceholder")}
          onChange={(event) => setNarration(event.target.value)}
        />
      </label>

      <label className="field">
        <span>{t("drop.scenePrompt")}</span>
        <textarea
          rows={2}
          value={prompt}
          disabled={writing}
          placeholder={t("drop.scenePromptPlaceholder")}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>

      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
