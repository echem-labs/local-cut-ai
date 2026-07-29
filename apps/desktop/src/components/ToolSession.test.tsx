import { render, screen } from "@testing-library/react";

import { describe, expect, it } from "vitest";

import type { Screenplay } from "../api/types";
import { NARRATION_PAD_S, SPEECH_WORDS_PER_S, spokenSeconds } from "../lib/formats";
import { ScriptTable, screenplayMarkdown } from "./ToolSession";

/**
 * The Length column showed `duration_s` — the script model's own claim,
 * which small local models pad to whatever number they were asked for
 * (six scenes, each "60s", for a 60s video). Nothing downstream reads that
 * field: a cut lasts as long as its narration takes to speak. The table has
 * to apply the same rule or the preview disagrees with the assembled video.
 */

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

const screenplay: Screenplay = {
  title: "The Fall of Istanbul",
  hook: "The empire's final breath.",
  scenes: [
    // The model's claim says 60s; 35 words actually speak in ~10s.
    { id: "s1", duration_s: 60, narration: words(35), visual: "aerial view", motion: "", onscreen_text: null },
    { id: "s2", duration_s: 60, narration: words(70), visual: "the walls", motion: "", onscreen_text: null },
  ],
};

describe("spokenSeconds", () => {
  it("applies the engine's narration timing rule", () => {
    expect(spokenSeconds(words(35))).toBeCloseTo(35 / SPEECH_WORDS_PER_S + NARRATION_PAD_S);
    // Whitespace runs are not words.
    expect(spokenSeconds("  one   two  ")).toBeCloseTo(2 / SPEECH_WORDS_PER_S + NARRATION_PAD_S);
  });
});

describe("ScriptTable", () => {
  it("shows spoken time per scene, never the model's duration_s claim", () => {
    render(<ScriptTable screenplay={screenplay} targetS={60} />);
    expect(screen.getByText("~10s")).toBeInTheDocument();
    expect(screen.getByText("~20s")).toBeInTheDocument();
    expect(screen.queryByText("~60s")).not.toBeInTheDocument();
  });

  it("totals the spoken time against the requested target", () => {
    render(<ScriptTable screenplay={screenplay} targetS={60} />);
    expect(screen.getByText("~31s spoken · target 60s")).toBeInTheDocument();
  });
});

describe("screenplayMarkdown", () => {
  it("carries title, hook, narration and visuals with spoken lengths", () => {
    const md = screenplayMarkdown(screenplay);
    expect(md).toContain("# The Fall of Istanbul");
    expect(md).toContain("> The empire's final breath.");
    expect(md).toContain("## s1 · ~10s");
    expect(md).toContain("*Visual:* aerial view");
    expect(md.endsWith("\n")).toBe(true);
  });
});
