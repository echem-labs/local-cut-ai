/**
 * The two tracks the timeline never drew.
 *
 * The strip showed video blocks and nothing else, so the narration under
 * each scene and the music across all of them were invisible — a scene whose
 * voice never rendered looked exactly like one whose voice was fine, until
 * playback. The engine has served the shape all along
 * (`/artifacts/{hash}/peaks`, computed once and cached) and U3 built both
 * the client for it and the renderer; nothing had put them on the timeline.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NodeState } from "../api/types";
import { useApp } from "../store";
import { AudioLanes } from "./AudioLanes";

const node = (id: string, status: string, hash: string | null = "h".repeat(64)): NodeState =>
  ({
    node_id: id,
    status,
    progress: 1,
    error: null,
    artifact_hash: hash,
    params: {},
    seed: 0,
    model: null,
    pinned: false,
  }) as NodeState;

let artifactPeaks: ReturnType<typeof vi.fn>;

const mount = (props: Partial<Parameters<typeof AudioLanes>[0]> = {}) => {
  artifactPeaks = vi.fn().mockResolvedValue({ bins: 4, duration_s: 3, peaks: [0.2, 0.9, 0.4, 0.7] });
  useApp.setState({
    client: { artifactPeaks },
    currentProject: { id: "p1", title: "t", approvals: [] },
  } as never);
  return render(
    <AudioLanes
      scenes={[
        { sceneId: "s1", narration: node("s1.narration", "draft") },
        { sceneId: "s2", narration: node("s2.narration", "draft") },
      ]}
      widths={[120, 90]}
      music={node("music", "draft")}
      totalWidth={225}
      {...props}
    />,
  );
};

beforeEach(() => useApp.setState({ client: null, currentProject: null } as never));

describe("the audio lanes", () => {
  it("draws a lane for the voice and one for the music", async () => {
    mount();
    expect(screen.getByRole("img", { name: /narration waveform/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /music waveform/i })).toBeInTheDocument();
  });

  it("asks the engine for each artifact's shape", async () => {
    mount();
    // Two narrations plus the music — and no audio decoding in the renderer.
    await waitFor(() => expect(artifactPeaks).toHaveBeenCalledTimes(3));
  });

  it("gives each scene's segment the width of its block", () => {
    // The lanes are only worth anything if they line up with the pictures
    // above them; a segment at the wrong width points at the wrong scene.
    const { container } = mount();
    const segments = container.querySelectorAll<HTMLElement>(".tl-lane .lane-seg");
    expect(segments[0].style.width).toBe("120px");
    expect(segments[1].style.width).toBe("90px");
  });

  it("gives music the whole width, not a segment per scene", () => {
    const { container } = mount();
    const musicLane = container.querySelectorAll(".tl-lane")[1];
    const segments = musicLane.querySelectorAll<HTMLElement>(".lane-seg");
    expect(segments).toHaveLength(1);
    expect(segments[0].style.width).toBe("225px");
  });

  it("leaves a gap where a narration never rendered", async () => {
    // The gap is the information: a scene with no voice must not look like
    // a scene whose voice is simply quiet.
    const { container } = mount({
      scenes: [
        { sceneId: "s1", narration: node("s1.narration", "draft") },
        { sceneId: "s2", narration: node("s2.narration", "queued", null) },
      ],
    });
    await waitFor(() => expect(artifactPeaks).toHaveBeenCalled());
    const segments = container.querySelectorAll(".tl-lane .lane-seg");
    expect(segments[1].className).toContain("empty");
  });

  it("draws nothing at all when the project has no rendered audio", () => {
    // Two labelled rails with no content would claim the project has audio
    // tracks that are silent, which is a different and wrong statement.
    const { container } = mount({
      scenes: [{ sceneId: "s1", narration: node("s1.narration", "queued", null) }],
      widths: [120],
      music: null,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("survives an artifact the engine cannot decode", async () => {
    // 422 (mock placeholder) and 503 (no ffmpeg) both land here. The wave is
    // a reading aid, so the lane stays and simply holds no bars.
    artifactPeaks = vi.fn().mockRejectedValue(new Error("engine 422: not decodable"));
    useApp.setState({
      client: { artifactPeaks },
      currentProject: { id: "p1", title: "t", approvals: [] },
    } as never);
    const { container } = render(
      <AudioLanes
        scenes={[{ sceneId: "s1", narration: node("s1.narration", "draft") }]}
        widths={[120]}
        music={null}
        totalWidth={120}
      />,
    );
    await waitFor(() => expect(artifactPeaks).toHaveBeenCalled());
    expect(container.querySelector(".tl-lane")).toBeInTheDocument();
    expect(container.querySelector(".lane-seg svg")).toBeNull();
  });
});
