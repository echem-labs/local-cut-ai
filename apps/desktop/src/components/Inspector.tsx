import { ChevronRight, Pin, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { NodeState } from "../api/types";
import { inspectorTitle } from "../help/terms";
import { ConfirmDialog } from "./ConfirmDialog";
import { FailureCard } from "./FailureCard";
import { PhotoThumb } from "./PhotoThumb";
import { t } from "../i18n";
import { useIsDropTarget } from "../lib/dropTarget";
import { CLIP_MAX_S, CLIP_MIN_S, SPEED_MAX, SPEED_MIN } from "../lib/formats";
import { useWorkspace } from "../lib/workspace";
import { PanelHelp } from "./Help";
import { Monitor } from "./Monitor";
import { StatusPill } from "./StatusRing";
import { InfoDot, Tip } from "./Tooltip";
import { useApp } from "../store";

type SceneTab = "image" | "motion" | "voice";

/** One scene editor (review 3): the drawer is titled by the scene, not a
 * node id, and Image · Motion · Voice tabs replace the per-node-type
 * variants — laymen never learn node kinds. Advanced holds seed, model,
 * trim and on-screen text. Natural-language edits live in the composer,
 * not here. Aux nodes (script, music, …) get the simple field editor. */
export function Inspector() {
  const {
    board,
    selectedNode,
    select,
    applyNode,
    togglePin,
    regenerate,
    applyTimeline,
    conditionScene,
    clearSceneStill,
    applyClonedVoice,
    selectTake,
    rerollWithSeed,
    client,
    currentProject,
  } = useApp();
  const view = useWorkspace((state) => state.view);
  const [tab, setTab] = useState<SceneTab>("image");
  const [advanced, setAdvanced] = useState(false);
  const [cloneConsent, setCloneConsent] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState("");
  const [model, setModel] = useState("");
  const [motion, setMotion] = useState("");
  const [voice, setVoice] = useState("");
  const [speed, setSpeed] = useState("");
  const [duration, setDuration] = useState("");
  const [trimIn, setTrimIn] = useState("");
  const [trimOut, setTrimOut] = useState("");
  const [overlay, setOverlay] = useState("");
  // A take the board still lists can be gone by the time it is clicked (the
  // per-node list is capped, and another window may have regenerated past
  // it). The engine refuses with a reason; discarding it left the chip
  // looking simply dead.
  const [takeError, setTakeError] = useState<string | null>(null);
  // Why "use my photo" needs its own: `conditionScene` reports a refusal by
  // returning the message, and this caller used to `.catch` it — dead code
  // against a promise that never rejects, so an upload the engine turned
  // down said nothing at all here while the same failure through a drop
  // showed a banner. Beside the input rather than in the shared banner far
  // below, so the answer is where the question was asked.
  const [photoError, setPhotoError] = useState<string | null>(null);

  const sceneId = selectedNode?.includes(".") ? selectedNode.split(".")[0] : null;
  // A picture is in the air over this panel, and it belongs to the scene the
  // panel is showing — so the panel says so itself rather than being covered
  // by a window-wide scrim that cannot name a target.
  const dropTarget = useIsDropTarget(sceneId);
  const [removingPhoto, setRemovingPhoto] = useState(false);
  const scene = sceneId ? (board?.scenes.find((s) => s.scene_id === sceneId) ?? null) : null;
  // The user's OWN picture for this scene, when there is one. `still` is
  // present only when the clip's keyframe port holds something other than
  // the generated node, so its presence IS the "they supplied one" test.
  const stillUrl =
    scene?.still?.artifact_hash && client && currentProject
      ? client.artifactUrl(currentProject.id, scene.still.artifact_hash)
      : null;
  const auxNode: NodeState | null =
    !sceneId && selectedNode ? (board?.aux[selectedNode] ?? null) : null;

  // The default tab follows what was clicked (a card selects the still, a
  // timeline block selects the clip); switching tabs is purely visual.
  useEffect(() => {
    if (!selectedNode) return;
    if (selectedNode.endsWith(".narration")) setTab("voice");
    else if (/\.clip\d*$/.test(selectedNode)) setTab("motion");
    else setTab("image");
  }, [selectedNode]);

  const activeNode: NodeState | null = scene
    ? tab === "image"
      ? scene.keyframe
      : tab === "motion"
        ? scene.clip
        : scene.narration
    : auxNode;

  const activeId = activeNode?.node_id ?? null;
  const retry = useApp((state) => (activeId ? state.nodeRetries[activeId] : undefined));
  // A rung with no scale (offload only) still ran at whatever the spec asked
  // for, which is full size unless the node says otherwise.
  const retryPct = (scale: number | undefined) => `${Math.round((scale ?? 1) * 100)}%`;

  // Which content param the active node reads.
  const contentKey =
    tab === "voice" || selectedNode === "voiceover"
      ? "text"
      : selectedNode === "music"
        ? "brief"
        : "prompt";
  const modelEditable = activeId
    ? /\.clip\d*$/.test(activeId) ||
      activeId.endsWith(".keyframe") ||
      ["script", "thumbnail"].includes(activeId)
    : false;

  // Each field re-seeds on active-node change AND when ITS OWN server value
  // moves — never when a sibling field does, so unsaved typing survives
  // board refreshes (the isolation pattern this drawer has always used).
  useEffect(() => {
    setPrompt(
      String(
        activeNode?.params.prompt ?? activeNode?.params.text ?? activeNode?.params.brief ?? "",
      ),
    );
  }, [activeId, activeNode?.params.prompt, activeNode?.params.text, activeNode?.params.brief]);
  useEffect(() => {
    setModel(activeNode?.model ?? "");
  }, [activeId, activeNode?.model]);
  useEffect(() => {
    setMotion(String(activeNode?.params.motion ?? ""));
  }, [activeId, activeNode?.params.motion]);
  useEffect(() => {
    setVoice(String(activeNode?.params.voice ?? ""));
  }, [activeId, activeNode?.params.voice]);
  useEffect(() => {
    setSpeed(activeNode?.params.speed != null ? String(activeNode.params.speed) : "1.0");
  }, [activeId, activeNode?.params.speed]);
  useEffect(() => {
    setDuration(
      activeNode?.params.duration_s != null ? String(activeNode.params.duration_s) : "",
    );
  }, [activeId, activeNode?.params.duration_s]);
  useEffect(() => {
    setSeed(activeNode ? String(activeNode.seed) : "");
  }, [activeId, activeNode?.seed]);

  // Trim/overlay live on the timeline node; edited optimistically, so they
  // re-seed only when the scene changes.
  const timelineParams = board?.aux.timeline?.params;
  // This scene's server-side trim/overlay, as strings. Re-seeded on scene
  // change AND when the scene's own stored values arrive: keying only on
  // sceneId meant selecting a scene before the board had loaded left both
  // fields showing "" while the server held real values — and then setting
  // one bound sent {out: 5} with no `in`, silently dropping the other.
  const storedTrim = (
    (timelineParams?.trims ?? {}) as Record<string, { in?: number; out?: number } | undefined>
  )[sceneId ?? ""];
  const storedOverlay = sceneId
    ? String(((timelineParams?.overlays ?? {}) as Record<string, string>)[sceneId] ?? "")
    : "";
  const storedIn = storedTrim?.in != null ? String(storedTrim.in) : "";
  const storedOut = storedTrim?.out != null ? String(storedTrim.out) : "";
  useEffect(() => {
    setTrimIn(storedIn);
    setTrimOut(storedOut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId, storedIn, storedOut]);
  useEffect(() => {
    setOverlay(storedOverlay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId, storedOverlay]);

  // Esc closes the drawer — but only when it genuinely owns the keystroke.
  useEffect(() => {
    if (!selectedNode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Don't steal Escape from a modal/overlay that owns it (ConfirmDialog,
      // command palette, Settings) or from a field being typed in — each of
      // those would silently deselect the scene out from under the user.
      if (document.querySelector(".modal-backdrop, .cmdk, .settings-layer")) return;
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) {
        return;
      }
      select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNode, select]);

  if (!selectedNode || (!scene && !auxNode)) return null;

  const patchTrim = (inValue: string, outValue: string) => {
    if (!sceneId) return;
    const trims = { ...((timelineParams?.trims ?? {}) as Record<string, unknown>) };
    const trim: Record<string, number> = {};
    // An empty box means CLEARED, and only that. The "not loaded yet" reading
    // — which used to make editing one bound wipe the other — is gone: the
    // seeding effect above re-runs on `storedIn`/`storedOut`, so both fields
    // hold the server's values from the moment the board arrives. Falling back
    // to the stored value here instead would make a trim impossible to remove:
    // emptying the field would silently re-send the value it just erased.
    const inNum = Number.parseFloat(inValue);
    const outNum = Number.parseFloat(outValue);
    // Negative trims are meaningless; the engine clamps them anyway.
    if (Number.isFinite(inNum) && inNum >= 0) trim.in = inNum;
    if (Number.isFinite(outNum) && outNum > 0) trim.out = outNum;
    // An out before the in is not a trim, it is an empty window.
    if (trim.in !== undefined && trim.out !== undefined && trim.out <= trim.in) {
      delete trim.out;
    }
    if (Object.keys(trim).length > 0) trims[sceneId] = trim;
    else delete trims[sceneId];
    applyTimeline({ trims });
  };

  const patchOverlay = (value: string) => {
    if (!sceneId) return;
    const overlays = { ...((timelineParams?.overlays ?? {}) as Record<string, unknown>) };
    if (value) overlays[sceneId] = value;
    else delete overlays[sceneId];
    applyTimeline({ overlays });
  };

  // Only what actually changed goes on the wire.
  const apply = () => {
    if (!activeNode) return;
    const params: Record<string, unknown> = {};
    if (prompt !== String(activeNode.params[contentKey] ?? "")) params[contentKey] = prompt;
    if (tab === "motion") {
      if (motion !== String(activeNode.params.motion ?? "")) params.motion = motion;
      // Clamped, not merely parsed. A number input does not stop a typed or
      // pasted value from leaving its min/max, and nothing downstream
      // validated it: zero and negative durations reached the engine, where
      // ComfyUI fails the job outright and ffmpeg silently clamps, while a
      // huge value turns into a frame count that OOMs the GPU.
      const value = Number.parseFloat(duration);
      if (Number.isFinite(value)) {
        const clamped = Math.min(CLIP_MAX_S, Math.max(CLIP_MIN_S, value));
        if (clamped !== activeNode.params.duration_s) params.duration_s = clamped;
      }
    }
    if (tab === "voice") {
      if (voice !== String(activeNode.params.voice ?? "")) params.voice = voice;
      const rate = Number.parseFloat(speed);
      if (Number.isFinite(rate)) {
        const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate));
        if (clamped !== (activeNode.params.speed ?? 1.0)) params.speed = clamped;
      }
    }
    const seedValue = Number.parseInt(seed, 10);
    const modelValue = model.trim() || null;
    void applyNode(activeNode.node_id, {
      params,
      seed: Number.isFinite(seedValue) && seedValue !== activeNode.seed ? seedValue : undefined,
      model: modelEditable && modelValue !== activeNode.model ? modelValue : undefined,
    });
  };

  const statusNode = scene ? scene.clip : auxNode;
  const pinned = activeNode?.pinned ?? false;

  const tabs: { id: SceneTab; label: string; present: boolean }[] = [
    { id: "image", label: t("inspector.tabs.image"), present: Boolean(scene?.keyframe) },
    { id: "motion", label: t("inspector.tabs.motion"), present: Boolean(scene?.clip) },
    { id: "voice", label: t("inspector.tabs.voice"), present: Boolean(scene?.narration) },
  ];

  // Tab word for the "no {tab} part" notice — a literal-keyed map keeps t()
  // typed and avoids branching on a translated string.
  const partWord: Record<SceneTab, string> = {
    image: t("inspector.partWords.image"),
    motion: t("inspector.partWords.motion"),
    voice: t("inspector.partWords.voice"),
  };

  return (
    // Named as this scene, so an image dropped anywhere on the panel becomes
    // ITS picture rather than a new scene. The panel is where you are when
    // you are thinking about one shot — the drop surface reads `data-scene`
    // off whatever the pointer is over, and the board card was the only
    // element carrying it, so dropping on the open scene's own details did
    // the one thing the user cannot have meant.
    <aside
      className={`inspector${dropTarget ? " drop-target" : ""}`}
      aria-label={t("inspector.aria")}
      data-scene={sceneId ?? undefined}
    >
      {dropTarget && (
        <div className="drop-here" role="note">
          <span>{t("drop.overlayStill", { n: (sceneId ?? "").replace(/^s/, "") })}</span>
        </div>
      )}
      {/* one-monitor rule: the Player view's big monitor owns playback */}
      {scene && view === "storyboard" && <Monitor />}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <h2 style={{ flex: 1, display: "inline-flex", alignItems: "center", gap: 8 }}>
          {inspectorTitle(selectedNode)}
          {statusNode && <StatusPill status={statusNode.status} progress={statusNode.progress} />}
        </h2>
        <PanelHelp panel="inspector" />
        {activeNode && (
          <Tip
            label={pinned ? t("inspector.unpin") : t("inspector.pin")}
            hint={pinned ? t("inspector.unpinTitle") : t("terms.tips.pin")}
          >
            <button
              className={`icon-btn-sm${pinned ? " active" : ""}`}
              onClick={() => void togglePin(activeNode.node_id, !pinned)}
              aria-label={pinned ? t("inspector.unpin") : t("inspector.pin")}
              aria-pressed={pinned}
            >
              <Pin size={13} strokeWidth={1.8} />
            </button>
          </Tip>
        )}
        <Tip label={t("inspector.closeTitle")}>
          <button
            className="icon-btn-sm"
            onClick={() => select(null)}
            aria-label={t("inspector.closeAria")}
          >
            <X size={13} strokeWidth={2} />
          </button>
        </Tip>
      </div>

      {scene && (
        <div className="tabs inspector-tabs" role="tablist" aria-label={t("inspector.tablistAria")}>
          {tabs.map(
            (entry) =>
              entry.present && (
                <button
                  key={entry.id}
                  role="tab"
                  aria-selected={tab === entry.id}
                  className={tab === entry.id ? "active" : ""}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                </button>
              ),
          )}
        </div>
      )}

      {pinned && (
        <div className="hint">{t("inspector.pinnedNotice")}</div>
      )}

      {!activeNode && scene && (
        <div className="hint">{t("inspector.noPart", { tab: partWord[tab] })}</div>
      )}

      {activeNode && (
        <>
          <div>
            <label htmlFor="inspector-prompt">
              {tab === "voice" || contentKey === "text"
                ? t("inspector.narratorLabel")
                : contentKey === "brief"
                  ? t("inspector.musicBrief")
                  : t("inspector.promptLabel")}
            </label>
            <textarea
              id="inspector-prompt"
              rows={4}
              value={prompt}
              disabled={pinned}
              onChange={(event) => setPrompt(event.target.value)}
            />
            {tab === "voice" && <div className="hint">{t("inspector.narrationLengthHint")}</div>}
          </div>

          {tab === "motion" && (
            <>
              <div>
                <label htmlFor="inspector-motion" className="with-info">
                  {t("inspector.cameraMovement")}
                  <InfoDot label={t("inspector.cameraInfoLabel")} hint={t("terms.tips.motion")} />
                </label>
                <input
                  id="inspector-motion"
                  value={motion}
                  disabled={pinned}
                  placeholder={t("inspector.motionPlaceholder")}
                  onChange={(event) => setMotion(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="inspector-duration">{t("inspector.lengthLabel")}</label>
                <input
                  id="inspector-duration"
                  type="number"
                  min={CLIP_MIN_S}
                  max={CLIP_MAX_S}
                  step={0.5}
                  value={duration}
                  disabled={pinned}
                  onChange={(event) => setDuration(event.target.value)}
                />
                <div className="hint">{t("terms.tips.length")}</div>
              </div>
            </>
          )}

          {tab === "voice" && (
            <div>
              <label htmlFor="inspector-voice" className="with-info">
                {t("inspector.voiceLabel")}
                <InfoDot label={t("inspector.voiceInfoLabel")} hint={t("terms.tips.voice")} />
              </label>
              {/* No tooltip: it carried the same words as its own
                  placeholder, so it repeated what the empty field already
                  says and said nothing once the field was filled. The ⓘ
                  beside the label is where the explanation lives. */}
              <input
                id="inspector-voice"
                value={voice}
                disabled={pinned}
                placeholder={t("inspector.voicePlaceholder")}
                onChange={(event) => setVoice(event.target.value)}
              />
            </div>
          )}

          {tab === "image" && sceneId && (
            <div>
              {/* "Use my photo" is the wrong sentence once there IS one — it
                  offers what is already done. With a picture in place the
                  section is about THAT picture, and the input beneath it
                  swaps one for another. */}
              <label htmlFor="inspector-asset">
                {t(stillUrl ? "inspector.yourPhoto" : "inspector.useMyPhoto")}
              </label>
              {stillUrl && scene?.still && (
                <PhotoThumb
                  src={stillUrl}
                  alt={t("inspector.photoAlt", { n: (sceneId ?? "").replace(/^s/, "") })}
                  title={t("inspector.photoTitle", { n: (sceneId ?? "").replace(/^s/, "") })}
                  // Only when there is a generated keyframe to hand back to:
                  // removing the still rewires the clip to it, and a scene
                  // whose generated node is gone would be left with no
                  // picture at all — which the compiler reads as not ready.
                  onRemove={scene.keyframe ? () => setRemovingPhoto(true) : undefined}
                />
              )}
              <input
                id="inspector-asset"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = ""; // same file re-selectable later
                  if (file) {
                    setPhotoError(null);
                    void conditionScene(sceneId, file).then(setPhotoError);
                  }
                }}
              />
              {photoError && (
                <div role="status" className="banner error">
                  {photoError}
                </div>
              )}
              <div className="hint">{t("terms.tips.ownImage")}</div>
            </div>
          )}

          <div>
            <button
              className="adv-toggle"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              <ChevronRight
                size={13}
                strokeWidth={2}
                style={{
                  transform: advanced ? "rotate(90deg)" : undefined,
                  transition: "transform var(--motion-fast)",
                }}
              />
              {t("inspector.advanced")}
              {!advanced && (
                <small>
                  {scene ? t("inspector.advancedSummary") : t("inspector.advancedSummaryAux")}
                </small>
              )}
            </button>
            {advanced && (
              <div className="adv-body">
                <div>
                  <label htmlFor="inspector-seed" className="with-info">
                    {t("inspector.seedLabel")}
                    <InfoDot label={t("inspector.seedInfoLabel")} hint={t("terms.tips.seed")} />
                  </label>
                  <input
                    id="inspector-seed"
                    type="number"
                    value={seed}
                    disabled={pinned}
                    onChange={(event) => setSeed(event.target.value)}
                  />
                </div>
                {modelEditable && (
                  <div>
                    <label htmlFor="inspector-model" className="with-info">
                      {t("inspector.modelLabel")}
                      <InfoDot label={t("inspector.modelInfoLabel")} hint={t("terms.tips.model")} />
                    </label>
                    <input
                      id="inspector-model"
                      value={model}
                      placeholder={t("inspector.modelPlaceholder")}
                      disabled={pinned}
                      onChange={(event) => setModel(event.target.value)}
                    />
                    <div className="hint">{t("inspector.cloudModelHint")}</div>
                  </div>
                )}
                {tab === "voice" && (
                  <div>
                    <label htmlFor="inspector-speed">{t("inspector.speakingSpeed")}</label>
                    <input
                      id="inspector-speed"
                      type="number"
                      min={SPEED_MIN}
                      max={SPEED_MAX}
                      step={0.05}
                      value={speed}
                      disabled={pinned}
                      onChange={(event) => setSpeed(event.target.value)}
                    />
                    <div className="hint">{t("terms.tips.speed")}</div>
                  </div>
                )}
                {tab === "voice" && (
                  <div>
                    <label>{t("inspector.voiceCloning")}</label>
                    <label
                      className="hint"
                      style={{ display: "flex", gap: "6px", alignItems: "center" }}
                    >
                      <input
                        type="checkbox"
                        checked={cloneConsent}
                        onChange={(event) => setCloneConsent(event.target.checked)}
                      />
                      {t("inspector.cloneConsent")}
                    </label>
                    <input
                      type="file"
                      accept=".wav,.mp3,.flac,.m4a"
                      disabled={!cloneConsent}
                      aria-label={t("inspector.voiceSampleAria")}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) {
                          void applyClonedVoice(file).catch((err) =>
                            console.warn("voice cloning failed:", err),
                          );
                        }
                      }}
                    />
                    <div className="hint">{t("inspector.cloneHint")}</div>
                  </div>
                )}
                {sceneId && (
                  <>
                    <div>
                      <label className="with-info">
                        {t("inspector.trimLabel")}
                        <InfoDot label={t("inspector.trimInfoLabel")} hint={t("terms.tips.trim")} />
                      </label>
                      <div className="trim-row">
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          placeholder={t("inspector.trimStartPlaceholder")}
                          aria-label={t("inspector.trimStartAria")}
                          value={trimIn}
                          onChange={(event) => {
                            setTrimIn(event.target.value);
                            patchTrim(event.target.value, trimOut);
                          }}
                        />
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          placeholder={t("inspector.trimEndPlaceholder")}
                          aria-label={t("inspector.trimEndAria")}
                          value={trimOut}
                          onChange={(event) => {
                            setTrimOut(event.target.value);
                            patchTrim(trimIn, event.target.value);
                          }}
                        />
                      </div>
                      <div className="hint">{t("inspector.trimHint")}</div>
                    </div>
                    <div>
                      <label htmlFor="inspector-overlay" className="with-info">
                        {t("inspector.onScreenText")}
                        <InfoDot label={t("inspector.onScreenInfoLabel")} hint={t("terms.tips.overlay")} />
                      </label>
                      <input
                        id="inspector-overlay"
                        value={overlay}
                        onChange={(event) => {
                          setOverlay(event.target.value);
                          patchOverlay(event.target.value);
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* commits sit below Advanced (review 3 §3C order) */}
          <button className="btn-outline" onClick={apply} disabled={pinned}>
            {t("inspector.applyRegenerate")}
          </button>
          <Tip label={t("inspector.newTake")} hint={t("terms.tips.newTake")} className="take-tip">
            <button
              className="btn-ghost"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
              onClick={() => void regenerate(activeNode.node_id)}
              disabled={pinned}
            >
              <RotateCw size={12} strokeWidth={1.8} />
              {t("inspector.newTake")}
            </button>
          </Tip>

          {(activeNode.takes?.length ?? 0) > 1 && (
            <div className="take-row" role="group" aria-label={t("inspector.takesAria")}>
              <span className="field-label">{t("inspector.takes")}</span>
              {activeNode.takes?.map((take, index) => {
                // Selecting restores the take's whole identity, model
                // included, so a cloud take CAN re-render on the user's own
                // API key — but only when its artifact is gone. While
                // `available`, the restored identity hashes to a file already
                // in the cache and the engine queues no job at all, so the
                // switch is free however it was originally rendered. Warning
                // there talked users out of the common case: the round trip
                // back to a take they had just left.
                const billed =
                  !take.current && !take.available && (take.model ?? "").startsWith("cloud:");
                return (
                  // The reroll control is a SIBLING of the take chip, never
                  // inside it: ARIA specifies a button's children as
                  // presentational, so a nested control is unreachable to a
                  // screen reader however reachable it stays by Tab.
                  <span className="take" key={take.output_hash}>
                    {/* The current take's chip and an unavailable one are both
                        disabled, and Chromium sends a disabled control no
                        pointer events — so the `title` that explained WHY
                        never appeared on either. The wrapper takes the hover
                        instead. */}
                    <Tip
                      label={t("inspector.takeChip", { n: index + 1 })}
                      hint={
                        take.current
                          ? t("inspector.takeCurrentTitle")
                          : take.available
                            ? t("inspector.takeSwitchTitle")
                            : billed
                              ? t("inspector.takeCloudTitle", { model: take.model ?? "" })
                              : t("inspector.takeMissingTitle")
                      }
                    >
                      <button
                        className={`chip${take.current ? " selected" : ""}${billed ? " billed" : ""}`}
                        disabled={pinned || take.current}
                        aria-pressed={take.current}
                        onClick={() => {
                          setTakeError(null);
                          void selectTake(activeNode.node_id, take.output_hash).then(setTakeError);
                        }}
                      >
                        {t("inspector.takeChip", { n: index + 1 })}
                        {billed && <span aria-hidden="true"> ☁</span>}
                      </button>
                    </Tip>
                    {/* Render again on THIS take's seed. The point is not to
                        reproduce the take — a seed with unchanged params is
                        already on disk — but to re-roll the CURRENT prompt,
                        motion and model against a seed whose composition the
                        user liked, so the parameter change is the only
                        difference between the two.

                        One atomic call: `RegenerateBody.seed` exists exactly
                        for this, and doing it as set_seed-then-regenerate
                        would leave the node carrying the borrowed seed if the
                        second half failed. */}
                    <Tip
                      label={t("inspector.rerollSeedAria", { n: String(index + 1) })}
                      hint={t("inspector.rerollSeedTitle", { seed: String(take.seed) })}
                    >
                      <button
                        type="button"
                        className="take-reroll"
                        disabled={pinned}
                        aria-label={t("inspector.rerollSeedAria", { n: String(index + 1) })}
                        onClick={() => {
                          setTakeError(null);
                          void rerollWithSeed(activeNode.node_id, take.seed).then(setTakeError);
                        }}
                      >
                        <RotateCw size={11} strokeWidth={2.2} aria-hidden="true" />
                      </button>
                    </Tip>
                  </span>
                );
              })}
            </div>
          )}
          {takeError && (
            <div role="status" className="banner error">
              {takeError}
            </div>
          )}

          {/* What the engine said about this node's last render, and what it
              suggested doing about it. FailureCard falls back to the plain
              notice when there is no advice, which is the common case: only
              an exhausted OOM ladder offers choices. */}
          <FailureCard node={activeNode} />

          {/* A retry in flight is running SMALLER than the attempt that
              failed. "Rendering" alone hides that, so the result arriving is
              a surprise rather than the thing that was announced. */}
          {retry && (
            <p className="node-retry" role="status">
              {retry.fallback.offload
                ? t("failure.retryingOffload", {
                    pct: retryPct(retry.fallback.resolution_scale),
                    n: String(retry.attempt),
                  })
                : t("failure.retrying", {
                    pct: retryPct(retry.fallback.resolution_scale),
                    n: String(retry.attempt),
                  })}
            </p>
          )}
        </>
      )}
      {removingPhoto && sceneId && (
        // Asked, because the picture is the user's own file and the app
        // cannot get it back: the asset stays on the flowchart, but nothing
        // on this panel would lead them there.
        <ConfirmDialog
          title={t("inspector.photoRemoveTitle")}
          message={t("inspector.photoRemoveBody", { n: sceneId.replace(/^s/, "") })}
          confirmLabel={t("inspector.photoRemoveConfirm")}
          onConfirm={() => {
            setRemovingPhoto(false);
            setPhotoError(null);
            void clearSceneStill(sceneId).then(setPhotoError);
          }}
          onCancel={() => setRemovingPhoto(false)}
        />
      )}
    </aside>
  );
}
