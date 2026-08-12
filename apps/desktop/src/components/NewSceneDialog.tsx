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
 * draft of them. Where the reading happens — a vision model on this machine
 * or a cloud key — is the engine's decision, and the hint under the button
 * reports whichever it chose. A machine that can do neither never sees the
 * button at all.
 */
import { Cloud, Laptop, Loader2, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { t } from "../i18n";
import { useApp } from "../store";
import { Alert } from "./Alert";
import { Dropdown } from "./Dropdown";
import { Modal } from "./Modal";
import { PhotoThumb } from "./PhotoThumb";
import { Tip } from "./Tooltip";

/** How often to ask whether the model is in memory yet. Cheap (Ollama answers
 *  it while generating) but not free, and the stage it reports changes once
 *  during a read — a second is pointless, ten misses short loads. */
const RESIDENCY_POLL_MS = 2_000;

/** `local:qwen2.5vl` → `qwen2.5vl`. The prefix is routing, not something to
 *  show anyone.
 *
 *  Just the name: where it runs is carried by the option's icon and its
 *  tooltip, and spelled out in full by the hint under the row. Spelling it
 *  into the label too made the trigger long enough to crowd its own caret,
 *  and repeated on screen a sentence that was already there. */
const modelName = (model: string): string => model.replace(/^(local|cloud):/, "");

const isLocal = (model: string): boolean => model.startsWith("local:");

export function NewSceneDialog({
  name,
  nodeId,
  file,
  onClose,
  onAdded,
}: {
  /** The dropped file's name — what the dialog is about, to the user. */
  name: string;
  /** The asset already uploaded, which is what the model will look at. */
  nodeId: string;
  /** The picture itself, shown so the dialog is about something the user can
   *  see. Read from the local File rather than fetched back from the engine:
   *  the bytes are already here, and a thumbnail that needs a round trip is a
   *  thumbnail that can be missing at the moment it matters. */
  file?: File;
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
  // Which model would read the picture, or null for "nothing here can". The
  // KIND is not decoration: the hint under the button is a privacy claim, and
  // promising a cloud provider for a reading that never leaves the machine is
  // exactly the sentence a local-first app must not print.
  const [vision, setVision] = useState<"local" | "cloud" | null>(null);
  // The alternatives, and which one this read will use. Empty until the
  // slower `/vision/models` answers — it probes the LLM server, where the
  // gate above is a disk read, so the button must not wait on it.
  const [models, setModels] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  // Seconds spent so far, and whether the model is in memory yet — together
  // they are the only honest account of the wait this route can give.
  const [elapsed, setElapsed] = useState(0);
  const [loaded, setLoaded] = useState<boolean | null>(null);
  const abort = useRef<AbortController | null>(null);
  const firstField = useRef<HTMLTextAreaElement>(null);

  // Revoked on unmount: an object URL pins its blob in memory until it is,
  // and this dialog opens once per dropped picture.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreview(null);
    };
  }, [file]);

  // Nothing that can see, no button. Offering a control that can only fail is
  // worse than not offering it — the engine refuses with a message about
  // Settings that the user has to read to discover the button never worked.
  //
  // The ENGINE decides, and this only relays it. Deriving the rule here from
  // the provider slate meant writing it twice in two languages, and the copy
  // in the renderer knew only about BYOK keys: a machine with a local vision
  // model set up to do this for free was told to go and buy a cloud key.
  //
  // Asked rather than read from the store because nothing else in the app
  // needs the answer, and a field kept fresh for one dialog is a field that
  // goes stale everywhere else.
  useEffect(() => {
    if (!client) return;
    let live = true;
    void client
      .visionModel()
      .then(({ model, kind }) => {
        if (live) setVision(model === null ? null : kind);
      })
      .catch(() => {
        // An answer we could not fetch is not a reason to block the dialog —
        // the fields are the point and they work without it.
        if (live) setVision(null);
      });
    return () => {
      live = false;
    };
  }, [client]);

  // The alternatives, for the picker. A second question because it is a
  // slower one: this probes the LLM server for which of its models can see,
  // and hanging the button's appearance on that would leave a machine that
  // can obviously read the picture looking like one that cannot.
  useEffect(() => {
    if (!client) return;
    let live = true;
    void client
      .visionModels()
      .then(({ models: offered, default: fallback }) => {
        if (!live) return;
        setModels(offered);
        setChosen(fallback);
      })
      .catch(() => {
        // No list is not a broken dialog — the button still works, and the
        // engine still picks the same model it would have picked.
        if (live) setModels([]);
      });
    return () => {
      live = false;
    };
  }, [client]);

  // A read outlives nothing: closing the dialog aborts it, so a cancelled
  // wait does not go on holding the model and then resolve into a component
  // that is gone.
  useEffect(() => () => abort.current?.abort(), []);

  // What the wait is actually spent on, and how long it has been.
  //
  // The read is a single opaque POST — it answers when the whole description
  // is ready and says nothing on the way — so a spinner alone is the only
  // thing the dialog could honestly show, and a spinner is indistinguishable
  // from a hang. The stage comes from a separate cheap question the LLM
  // server answers WHILE it generates: is the model in memory yet? Loading is
  // where the minutes go, and saying so turns an alarming wait into an
  // expected one.
  useEffect(() => {
    if (!writing) {
      setElapsed(0);
      setLoaded(null);
      return;
    }
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    let live = true;
    const poll = async (): Promise<void> => {
      // Only a local read has a residency to report; a cloud one is over the
      // network the whole time and has no stage to name.
      if (!client || !chosen?.startsWith("local:")) return;
      try {
        const { loaded: resident } = await client.visionResidency(chosen);
        if (live) setLoaded(resident);
      } catch {
        // The stage line is a courtesy. Losing it says nothing about the read
        // itself, which is still running on its own request.
      }
    };
    void poll();
    const probe = setInterval(() => void poll(), RESIDENCY_POLL_MS);
    return () => {
      live = false;
      clearInterval(tick);
      clearInterval(probe);
    };
  }, [writing, client, chosen]);

  const generate = async (): Promise<void> => {
    const controller = new AbortController();
    abort.current = controller;
    setWriting(true);
    setError(null);
    // `chosen` is a name the ENGINE offered, never one composed here.
    const result = await suggestScene(nodeId, chosen ?? undefined, controller.signal);
    abort.current = null;
    setWriting(false);
    if (controller.signal.aborted) return;
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

      {/* Thumbnail and the read controls share a row: the picture is about
          100px tall and the space beside it was empty, while the button below
          it pushed both text areas — the fields this dialog exists to fill —
          further down than the window could show. */}
      <div className="scene-read">
        {preview && (
          // A thumbnail, not the picture: rendered at its natural width it
          // pushed the dialog wider than the window, so reading a field meant
          // scrolling sideways. Small states WHICH image this is about, which
          // is all that is needed inline; the full view is one click away.
          <PhotoThumb src={preview} alt={name} title={name} />
        )}

        {vision && (
          <div className="scene-read-controls">
            <div className="scene-read-actions">
              <button
                className="btn-outline"
                onClick={() => void generate()}
                disabled={writing || busy}
              >
                {writing ? (
                  <Loader2 size={14} strokeWidth={2} className="spin" aria-hidden />
                ) : (
                  <Sparkles size={14} strokeWidth={2} aria-hidden />
                )}
                {writing ? t("drop.sceneGenerating") : t("drop.sceneGenerate")}
              </button>
              {writing && (
                // Beside the thing it stops, not in the footer: the footer's
                // buttons act on the SCENE, and a read the user has given up
                // on must not look like one of them.
                //
                // An icon button, so it reads as a control ON the running
                // action rather than a second choice with equal weight to
                // it — a word-for-word button next to "Reading the image…"
                // gave a two-second interruption the same size as the work.
                // The label survives as `aria-label` and in the tip.
                <Tip label={t("drop.sceneStop")} hint={t("drop.sceneStopHint")}>
                  <button
                    className="icon-btn"
                    aria-label={t("drop.sceneStop")}
                    onClick={() => abort.current?.abort()}
                  >
                    <Square size={13} strokeWidth={2} aria-hidden />
                  </button>
                </Tip>
              )}
            </div>

            {/* One choice is not a choice — the picker appears only when the
                engine offered somewhere else to send this.

                `Dropdown`, not a bare `<select>`: a native select draws in the
                OS's own chrome, which in a dark dialog is a grey slab that
                belongs to no part of this app. The label sits beside it the
                way Settings' own model rows do, not above it, because this is
                one short choice rather than a form. */}
            {models.length > 1 && (
              <div className="scene-read-model">
                <span className="scene-read-model-label">{t("drop.sceneModelLabel")}</span>
                <Dropdown
                  value={chosen ?? ""}
                  options={models.map((model) => ({
                    value: model,
                    label: modelName(model),
                    icon: isLocal(model) ? Laptop : Cloud,
                    hint: isLocal(model)
                      ? t("drop.sceneModelLocal")
                      : t("drop.sceneModelCloud"),
                  }))}
                  variant="field"
                  ariaLabel={t("drop.sceneModelLabel")}
                  tip={t("drop.sceneModelTip")}
                  tipHint={t("drop.sceneModelTipHint")}
                  onChange={(value) => setChosen(String(value))}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Prose runs the full width of the dialog, under the thumbnail rather
          than beside it. Confined to the column right of a 128px picture,
          both of these wrapped to three or four short ragged lines while the
          space under the thumbnail sat empty — and the stage line's elapsed
          counter, pinned to the right of that narrow column, read as though
          it belonged to the sentence rather than to the wait. */}
      {vision && (
        <div className="hint scene-read-note">
          {/* Tracks the CHOSEN model, not the engine's original pick: this
              line is a privacy claim, and it would be a false one the moment
              the user switches a local read to a cloud provider and it still
              says nothing leaves the machine. */}
          {(chosen ? isLocal(chosen) : vision === "local")
            ? t("drop.sceneGenerateHintLocal")
            : t("drop.sceneGenerateHintCloud")}
        </div>
      )}

      {writing && (
        <div className="scene-read-status" role="status">
          <span>
            {/* Three states, and the difference matters: loading is the slow
                one and it is expected, reading is nearly done, and a server
                that cannot say which must not be reported as either. */}
            {loaded === false
              ? t("drop.sceneStageLoading", { name: modelName(chosen ?? "") })
              : loaded === true
                ? t("drop.sceneStageReading")
                : t("drop.sceneStageWorking")}
          </span>
          <span className="scene-read-elapsed">{t("drop.sceneElapsed", { seconds: elapsed })}</span>
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

      {/* `Alert`, not the heavy `.banner error` box: this is a refusal to
          read in the place the read was asked for, which is exactly what that
          component is the app's recipe for — and it can be dismissed, so a
          message about a read the user has moved on from stops sitting over
          the fields they are now typing in. */}
      {error && (
        <div className="scene-read-error">
          <Alert message={error} onDismiss={() => setError(null)} />
        </div>
      )}
    </Modal>
  );
}
