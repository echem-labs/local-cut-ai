import { ChevronRight, Pin, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { NodeState } from "../api/types";
import { inspectorTitle } from "../help/terms";
import { t } from "../i18n";
import { useWorkspace } from "../lib/workspace";
import { PanelHelp } from "./Help";
import { Monitor } from "./Monitor";
import { StatusPill } from "./StatusRing";
import { InfoDot } from "./Tooltip";
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
    applyClonedVoice,
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

  const sceneId = selectedNode?.includes(".") ? selectedNode.split(".")[0] : null;
  const scene = sceneId ? (board?.scenes.find((s) => s.scene_id === sceneId) ?? null) : null;
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
  useEffect(() => {
    const trims = (timelineParams?.trims ?? {}) as Record<
      string,
      { in?: number; out?: number } | undefined
    >;
    const overlays = (timelineParams?.overlays ?? {}) as Record<string, string>;
    const trim = sceneId ? trims[sceneId] : undefined;
    setTrimIn(trim?.in != null ? String(trim.in) : "");
    setTrimOut(trim?.out != null ? String(trim.out) : "");
    setOverlay(sceneId ? String(overlays[sceneId] ?? "") : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId]);

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
    const inNum = Number.parseFloat(inValue);
    const outNum = Number.parseFloat(outValue);
    if (Number.isFinite(inNum)) trim.in = inNum;
    if (Number.isFinite(outNum)) trim.out = outNum;
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
      const value = Number.parseFloat(duration);
      if (Number.isFinite(value) && value !== activeNode.params.duration_s)
        params.duration_s = value;
    }
    if (tab === "voice") {
      if (voice !== String(activeNode.params.voice ?? "")) params.voice = voice;
      const rate = Number.parseFloat(speed);
      if (Number.isFinite(rate) && rate !== (activeNode.params.speed ?? 1.0)) params.speed = rate;
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
    <aside className="inspector" aria-label={t("inspector.aria")}>
      {/* one-monitor rule: the Player view's big monitor owns playback */}
      {scene && view === "storyboard" && <Monitor />}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <h2 style={{ flex: 1, display: "inline-flex", alignItems: "center", gap: 8 }}>
          {inspectorTitle(selectedNode)}
          {statusNode && <StatusPill status={statusNode.status} progress={statusNode.progress} />}
        </h2>
        <PanelHelp panel="inspector" />
        {activeNode && (
          <button
            className={`icon-btn-sm${pinned ? " active" : ""}`}
            onClick={() => void togglePin(activeNode.node_id, !pinned)}
            aria-label={pinned ? t("inspector.unpin") : t("inspector.pin")}
            aria-pressed={pinned}
            title={pinned ? t("inspector.unpinTitle") : t("terms.tips.pin")}
          >
            <Pin size={13} strokeWidth={1.8} />
          </button>
        )}
        <button
          className="icon-btn-sm"
          onClick={() => select(null)}
          aria-label={t("inspector.closeAria")}
          title={t("inspector.closeTitle")}
        >
          <X size={13} strokeWidth={2} />
        </button>
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
                  min={1}
                  max={15}
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
              <input
                id="inspector-voice"
                value={voice}
                disabled={pinned}
                placeholder={t("inspector.voicePlaceholder")}
                title={t("inspector.voicePlaceholder")}
                onChange={(event) => setVoice(event.target.value)}
              />
            </div>
          )}

          {tab === "image" && sceneId && (
            <div>
              <label htmlFor="inspector-asset">{t("inspector.useMyPhoto")}</label>
              <input
                id="inspector-asset"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = ""; // same file re-selectable later
                  if (file) {
                    void conditionScene(sceneId, file).catch((err) =>
                      console.warn("asset conditioning failed:", err),
                    );
                  }
                }}
              />
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
                      min={0.5}
                      max={1.5}
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
            title={t("terms.tips.newTake")}
          >
            <RotateCw size={12} strokeWidth={1.8} />
            {t("inspector.newTake")}
          </button>

          {activeNode.error && <div className="banner error">{activeNode.error}</div>}
        </>
      )}
    </aside>
  );
}
