/**
 * The waveform is a reading aid, never a gate — the tests pin the two ways
 * that stays true: bars render from the engine's peaks (no client-side
 * audio decoding anywhere), and a session whose artifact the engine cannot
 * decode still gets a working player, just without the picture.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";

import { useApp } from "../store";
import { Waveform } from "./Waveform";

const PEAKS = {
  bins: 4,
  duration_s: 40,
  peaks: [0.1, 0.9, 0.5, 0.2],
};

function mount(peaks: unknown = PEAKS) {
  const artifactPeaks =
    peaks instanceof Error
      ? vi.fn().mockRejectedValue(peaks)
      : vi.fn().mockResolvedValue(peaks);
  useApp.setState({ client: { artifactPeaks } } as never);
  const view = render(
    <Waveform projectId="p1" hash="h1" src="http://engine/a.wav" ariaLabel="music preview" />,
  );
  return { view, artifactPeaks };
}

beforeEach(() => useApp.setState({ client: null } as never));

describe("Waveform", () => {
  it("draws one bar per engine peak and never decodes audio itself", async () => {
    const { view, artifactPeaks } = mount();
    await waitFor(() =>
      expect(view.container.querySelectorAll(".wave-plot rect")).toHaveLength(4),
    );
    // The shared BINS constant: one cache entry engine-side.
    expect(artifactPeaks).toHaveBeenCalledWith("p1", "h1", 192);
  });

  it("keeps the bare player when the artifact is not decodable audio", async () => {
    const { view, artifactPeaks } = mount(new Error("422 not audio"));
    await waitFor(() => expect(artifactPeaks).toHaveBeenCalled());
    expect(view.container.querySelector(".wave-plot")).toBeNull();
    expect(screen.getByLabelText("music preview")).toBeInTheDocument();
  });

  it("is the player when peaks exist: one toggle, native controls hidden", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined as never);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { view } = mount();
    await waitFor(() =>
      expect(view.container.querySelectorAll(".wave-plot rect").length).toBeGreaterThan(0),
    );
    const audio = view.container.querySelector("audio") as HTMLAudioElement;
    expect(audio.hidden).toBe(true);
    expect(audio.hasAttribute("controls")).toBe(false);

    fireEvent.click(screen.getByLabelText("Play"));
    expect(play).toHaveBeenCalled();
    fireEvent(audio, new Event("play"));
    // The toggle now tells the truth mid-play…
    expect(screen.getByLabelText("Pause")).toBeInTheDocument();

    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockReturnValue(false);
    fireEvent.click(screen.getByLabelText("Pause"));
    expect(pause).toHaveBeenCalled();
    fireEvent(audio, new Event("pause"));
    // …and again at rest.
    expect(screen.getByLabelText("Play")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("seeks the player to the clicked fraction of the engine's duration", async () => {
    const { view } = mount();
    await waitFor(() =>
      expect(view.container.querySelectorAll(".wave-plot rect").length).toBeGreaterThan(0),
    );
    const plot = view.container.querySelector(".wave-plot") as HTMLButtonElement;
    plot.getBoundingClientRect = () =>
      ({ left: 0, width: 200, top: 0, height: 64, right: 200, bottom: 64 }) as DOMRect;
    const audio = view.container.querySelector("audio") as HTMLAudioElement;

    fireEvent.click(plot, { clientX: 50 });

    // 50/200 of a 40s track — the engine's duration_s, not the element's
    // (jsdom has none, and a real element may not have metadata yet).
    expect(audio.currentTime).toBeCloseTo(10);
  });

  it("rewinds the readout when the artifact underneath it changes", async () => {
    // The transport belongs to the artifact, not to the component. A
    // regenerate swaps `hash` under a mounted player, and the element's own
    // currentTime resets with its src — but nothing fires `timeupdate` until
    // the new track plays, so a `played` left where the old one stopped
    // paints the new bars and its clock to a position it has never been at.
    const { view } = mount();
    await waitFor(() =>
      expect(view.container.querySelectorAll(".wave-plot rect").length).toBeGreaterThan(0),
    );
    const plot = view.container.querySelector(".wave-plot") as HTMLButtonElement;
    plot.getBoundingClientRect = () =>
      ({ left: 0, width: 200, top: 0, height: 64, right: 200, bottom: 64 }) as DOMRect;
    fireEvent.click(plot, { clientX: 50 });
    expect(view.container.querySelector(".wave-time")?.textContent).toBe("0:10 / 0:40");

    view.rerender(
      <Waveform projectId="p1" hash="h2" src="http://engine/b.wav" ariaLabel="music preview" />,
    );
    await waitFor(() =>
      expect(view.container.querySelectorAll(".wave-plot rect").length).toBeGreaterThan(0),
    );
    expect(view.container.querySelector(".wave-time")?.textContent).toBe("0:00 / 0:40");
  });

  it("previews the seek-to time under the pointer, and clears it on leave", async () => {
    const { view } = mount();
    await waitFor(() =>
      expect(view.container.querySelectorAll(".wave-plot rect").length).toBeGreaterThan(0),
    );
    const plot = view.container.querySelector(".wave-plot") as HTMLButtonElement;
    plot.getBoundingClientRect = () =>
      ({ left: 0, width: 200, top: 0, height: 64, right: 200, bottom: 64 }) as DOMRect;

    fireEvent.mouseMove(plot, { clientX: 100 });
    // Halfway across a 40s track: the tip says where the click would land.
    expect(view.container.querySelector(".wave-seek-tip")?.textContent).toBe("0:20");

    fireEvent.mouseLeave(plot);
    expect(view.container.querySelector(".wave-seek-tip")).toBeNull();
  });
});
