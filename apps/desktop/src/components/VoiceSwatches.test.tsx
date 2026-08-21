import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Voices } from "../api/types";
import { VoiceSwatches } from "./VoiceSwatches";

/**
 * The five-swatch fast path, shared by Home's voiceover panel and a
 * voiceover session. Both surfaces hold a brief AND may hold a picked id,
 * and the engine reads the pick first — so which swatch looks chosen is
 * not simply "the one whose brief matches".
 */

const PACK: Voices = {
  available: true,
  voices: [
    { id: "af_sarah", name: "Sarah", language_code: "en-us", gender: "female" },
    { id: "bf_emma", name: "Emma", language_code: "en-gb", gender: "female" },
  ],
  default: "af_sarah",
};

function swatchOf(name: string): HTMLElement {
  const button = screen.getByLabelText(`Use the ${name} voice`);
  const swatch = button.closest(".voice-swatch");
  if (!swatch) throw new Error(`no swatch around ${name}`);
  return swatch as HTMLElement;
}

describe("the voice swatches", () => {
  it("reports the brief a swatch stands for, not the voice behind it", () => {
    const onPickBrief = vi.fn();
    render(
      <VoiceSwatches
        voices={PACK}
        brief=""
        voiceId={null}
        onPickBrief={onPickBrief}
        onOpenPicker={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Use the Onyx voice"));
    // The brief is what the engine is asked for; `am_onyx` is only what
    // this swatch's bundled sample happens to be.
    expect(onPickBrief).toHaveBeenCalledWith("deep");
  });

  it("shows a matching brief as chosen", () => {
    render(
      <VoiceSwatches
        voices={PACK}
        brief="deep"
        voiceId={null}
        onPickBrief={vi.fn()}
        onOpenPicker={vi.fn()}
      />,
    );
    expect(swatchOf("Onyx").className).toContain("active");
    expect(swatchOf("Emma").className).not.toContain("active");
  });

  it("shows none as chosen while a picked voice outranks the brief", () => {
    render(
      <VoiceSwatches
        voices={PACK}
        brief="deep"
        voiceId="bf_emma"
        onPickBrief={vi.fn()}
        onOpenPicker={vi.fn()}
      />,
    );
    // A node can carry both: picking from the full pack leaves whatever
    // brief was already there. Lighting the brief's swatch would name
    // Onyx as the chosen voice while Emma is the one that speaks.
    expect(swatchOf("Onyx").className).not.toContain("active");
  });

  it("names the picked voice on the way into the full pack", () => {
    render(
      <VoiceSwatches
        voices={PACK}
        brief=""
        voiceId="bf_emma"
        onPickBrief={vi.fn()}
        onOpenPicker={vi.fn()}
      />,
    );
    // Otherwise a pick made from the picker is invisible the moment it
    // closes: no swatch is lit and nothing else on the row names it.
    expect(screen.getByText("Voice: Emma")).toBeInTheDocument();
  });

  it("offers the full pack only when the pack can be read", () => {
    const { rerender } = render(
      <VoiceSwatches
        voices={{ available: false, voices: [], default: null }}
        brief=""
        voiceId={null}
        onPickBrief={vi.fn()}
        onOpenPicker={vi.fn()}
      />,
    );
    // The five swatches are bundled audio and work with no pack at all —
    // only the way into the other forty-nine depends on one.
    expect(screen.getByLabelText("Use the Onyx voice")).toBeInTheDocument();
    expect(screen.queryByText(/All \d+ voices/)).toBeNull();

    rerender(
      <VoiceSwatches
        voices={PACK}
        brief=""
        voiceId={null}
        onPickBrief={vi.fn()}
        onOpenPicker={vi.fn()}
      />,
    );
    expect(screen.getByText("All 2 voices…")).toBeInTheDocument();
  });

  it("asks nothing of the engine before it is asked for", () => {
    const onOpenPicker = vi.fn();
    render(
      <VoiceSwatches
        voices={PACK}
        brief=""
        voiceId={null}
        onPickBrief={vi.fn()}
        onOpenPicker={onOpenPicker}
      />,
    );
    fireEvent.click(screen.getByText("All 2 voices…"));
    expect(onOpenPicker).toHaveBeenCalled();
  });
});
