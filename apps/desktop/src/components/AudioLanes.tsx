import type { NodeState } from "../api/types";
import { t } from "../i18n";
import { isDone } from "../lib/status";
import { useApp } from "../store";
import { WavePlot, useArtifactPeaks } from "./WavePlot";

/**
 * What the cut sounds like, under the pictures it belongs to.
 *
 * The timeline drew video blocks and nothing else, so the two tracks that
 * decide whether a cut works — the narration under each scene and the music
 * across all of them — were invisible. The engine has served their shape all
 * along (`/artifacts/{hash}/peaks`, computed once and cached), and U3 built
 * the client and the renderer for it; nothing had put them on the timeline.
 *
 * Read-only on purpose. These lanes say where the sound IS, so a scene whose
 * narration never rendered is visible as a gap rather than as silence you
 * discover on playback. Editing audio placement is a different feature and
 * would need a drag model the timeline does not have.
 */
export function AudioLanes({
  scenes,
  widths,
  music,
  totalWidth,
}: {
  /** Per-scene narration node, aligned index-for-index with `widths`. */
  scenes: { sceneId: string; narration: NodeState | null }[];
  widths: number[];
  music: NodeState | null | undefined;
  totalWidth: number;
}) {
  const hasNarration = scenes.some((scene) => scene.narration && isDone(scene.narration.status));
  const hasMusic = !!music && isDone(music.status) && !!music.artifact_hash;
  // Nothing to draw is not an empty lane: two labelled rails with no content
  // claim the project has audio tracks that are silent, which is a different
  // and wrong statement.
  if (!hasNarration && !hasMusic) return null;

  return (
    <div className="tl-audio" style={{ width: totalWidth }}>
      {hasNarration && (
        <div className="tl-lane" role="img" aria-label={t("timeline.narrationLaneAria")}>
          <span className="lane-label">{t("timeline.narrationLane")}</span>
          <div className="lane-track">
            {scenes.map((scene, index) => (
              <LaneSegment
                key={scene.sceneId}
                node={scene.narration}
                width={widths[index]}
                title={t("timeline.narrationOf", { n: scene.sceneId.replace(/^s/, "") })}
              />
            ))}
          </div>
        </div>
      )}
      {hasMusic && (
        <div className="tl-lane" role="img" aria-label={t("timeline.musicLaneAria")}>
          <span className="lane-label">{t("timeline.musicLane")}</span>
          <div className="lane-track">
            {/* One artifact across the whole cut, so it gets the full width
                rather than a segment per scene. */}
            <LaneSegment node={music ?? null} width={totalWidth} title={t("timeline.musicLane")} />
          </div>
        </div>
      )}
    </div>
  );
}

/** One artifact's slice of a lane. A scene with no rendered narration draws
 * an empty box at its own width — the gap is the information. */
function LaneSegment({
  node,
  width,
  title,
}: {
  node: NodeState | null;
  width: number;
  title: string;
}) {
  const projectId = useApp((state) => state.currentProject?.id ?? null);
  const hash = node && isDone(node.status) ? node.artifact_hash : null;
  const peaks = useArtifactPeaks(projectId, hash);

  return (
    <div className={`lane-seg${peaks ? "" : " empty"}`} style={{ width }} title={title}>
      {peaks && peaks.peaks.length > 0 && <WavePlot peaks={peaks.peaks} />}
    </div>
  );
}
