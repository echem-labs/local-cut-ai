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
});
