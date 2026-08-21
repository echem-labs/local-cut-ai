import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Voice, Voices } from "../api/types";
import { useApp } from "../store";
import { VoicePicker, ambiguousNames, groupByLanguage, languageLabel } from "./VoicePicker";

/**
 * The pack ships fifty-four voices whose derived names are NOT unique — three
 * Santas, two Alphas, two Doras — and whose language is an id the client has
 * to label. Both are properties a picker has to survive, and neither is
 * visible from the five voices the swatches happen to offer.
 */

function voice(id: string, name: string, code: string | null, gender: string | null): Voice {
  return { id, name, language_code: code, gender };
}

const PACK: Voice[] = [
  voice("af_sarah", "Sarah", "en-us", "female"),
  voice("am_santa", "Santa", "en-us", "male"),
  voice("bf_emma", "Emma", "en-gb", "female"),
  voice("em_santa", "Santa", "es", "male"),
  voice("jf_alpha", "Alpha", "ja", "female"),
  voice("hf_alpha", "Alpha", "hi", "female"),
  voice("jenny", "jenny", null, null),
];

function payload(extra: Partial<Voices> = {}): Voices {
  return { available: true, voices: PACK, default: "af_sarah", ...extra };
}

function mountClient() {
  useApp.setState({
    client: {
      voicePreviewUrl: (id: string) => `http://engine/voices/${id}/preview`,
    },
  } as never);
}

describe("telling voices apart", () => {
  it("prints the id only for names another installed voice also has", () => {
    const ambiguous = ambiguousNames(PACK);
    // Two Santas and two Alphas: without the id these are four rows a user
    // cannot choose between.
    expect([...ambiguous].sort()).toEqual(["am_santa", "em_santa", "hf_alpha", "jf_alpha"]);
    // Unique names stay clean — the id would be noise on every other row.
    expect(ambiguous.has("af_sarah")).toBe(false);
    expect(ambiguous.has("bf_emma")).toBe(false);
  });

  it("groups by language label, with the unrecognised group last", () => {
    const groups = groupByLanguage(PACK);
    // By the words on screen, not the codes behind them: sorting on the code
    // puts Mandarin above both Englishes (`cmn` < `en-`), which is not an
    // order a reader can see a reason for.
    expect(groups.map(([code]) => languageLabel(code))).toEqual([
      "American English",
      "British English",
      "Hindi",
      "Japanese",
      "Spanish",
      "unknown",
    ]);
    // The codes fall wherever their labels put them — `es` after `ja` here.
    expect(groups.map(([code]) => code)).toEqual(["en-us", "en-gb", "hi", "ja", "es", null]);
    expect(groups.at(-1)?.[1].map((v) => v.id)).toEqual(["jenny"]);
  });

  it("labels a language from the catalog and falls back to the code itself", () => {
    expect(languageLabel("en-gb")).toBe("British English");
    // A code the catalog has not learned yet renders as the code. A blank
    // column would be worse: the row would say nothing at all.
    expect(languageLabel("qq-zz")).toBe("qq-zz");
    expect(languageLabel(null)).toBe("unknown");
  });
});

describe("the picker", () => {
  // In teardown, not at the end of the test that stubs: an assertion that
  // throws before the last line would otherwise leave the fake `Audio`
  // installed for every test after it in this file.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers every installed voice and reports the pick by id", async () => {
    mountClient();
    const onPick = vi.fn();
    render(
      <VoicePicker
        voices={payload()}
        value={null}
        scope="node"
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByText("Emma"));
    // The id, never the name: two voices share a name and only the id is an
    // identifier the engine can synthesize.
    expect(onPick).toHaveBeenCalledWith("bf_emma", false);
  });

  it("offers going back to the project's voice, and reports that as null", async () => {
    mountClient();
    const onPick = vi.fn();
    render(
      <VoicePicker
        voices={payload()}
        value="bf_emma"
        scope="project"
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByText("Follow the project"));
    // null, not "" — the store clears the key with it, which is what puts
    // the node back on the hash its brief-only render already used.
    expect(onPick).toHaveBeenCalledWith(null, false);
  });

  it("offers no such row where there is no project behind the node", () => {
    mountClient();
    render(
      <VoicePicker
        voices={payload()}
        value="bf_emma"
        scope="node"
        onPick={vi.fn()}
        onClose={() => {}}
      />,
    );
    // Home's quick tool and a tool session each speak for one node, and
    // "the project" there is that node's own session — a fallback the row
    // would name and the surface does not have. Dropping a pick on those
    // two is the swatch row's job, which is beside the picker rather than
    // inside it.
    expect(screen.queryByText("Follow the project")).toBeNull();
  });

  it("offers the pick to every scene, and reports which was asked for", async () => {
    mountClient();
    const onPick = vi.fn();
    render(
      <VoicePicker
        voices={payload()}
        value={null}
        scope="project"
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    // Unasked, a pick is this scene's alone: the project's other scenes
    // are not something a click on one row should quietly rewrite.
    await userEvent.click(screen.getByText("Emma"));
    expect(onPick).toHaveBeenLastCalledWith("bf_emma", false);

    await userEvent.click(screen.getByLabelText("Use this voice for every scene"));
    await userEvent.click(screen.getByText("Sarah"));
    expect(onPick).toHaveBeenLastCalledWith("af_sarah", true);
  });

  it("keeps that offer to itself where there are no other scenes", () => {
    mountClient();
    render(
      <VoicePicker
        voices={payload()}
        value={null}
        scope="node"
        onPick={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Use this voice for every scene")).toBeNull();
  });

  it("auditions a voice from the engine rather than a bundled file", async () => {
    mountClient();
    const play = vi.fn().mockResolvedValue(undefined);
    const sources: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        constructor(src: string) {
          sources.push(src);
        }
        play = play;
        pause = vi.fn();
        addEventListener = vi.fn();
      },
    );
    render(
      <VoicePicker
        voices={payload()}
        value={null}
        scope="node"
        onPick={vi.fn()}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByLabelText("Hear Emma"));
    expect(sources).toEqual(["http://engine/voices/bf_emma/preview"]);
  });

  it("puts the row back when playback is refused rather than leaving a stop", async () => {
    mountClient();
    // A rejected play() fires no `error` event - autoplay policy and a
    // missing output device both land here - so nothing else can clear the
    // row, and it would keep offering a Stop that stops nothing.
    vi.stubGlobal(
      "Audio",
      class {
        play = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
        pause = vi.fn();
        addEventListener = vi.fn();
      },
    );
    render(
      <VoicePicker
        voices={payload()}
        value={null}
        scope="node"
        onPick={vi.fn()}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByLabelText("Hear Emma"));
    await vi.waitFor(() => expect(screen.getByLabelText("Hear Emma")).toBeTruthy());
    expect(screen.queryByLabelText("Stop Emma")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("says an unreadable pack is empty rather than reporting a search miss", () => {
    mountClient();
    // `available: true` with no voices is a pack that could not be read, not
    // a query that matched nothing - and the query here is empty.
    render(
      <VoicePicker
        voices={payload({ voices: [], default: null })}
        value={null}
        scope="node"
        onPick={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("No voices in the installed pack")).toBeTruthy();
  });

  it("searches the id as well as the name", async () => {
    mountClient();
    render(
      <VoicePicker
        voices={payload()}
        value={null}
        scope="node"
        onPick={vi.fn()}
        onClose={() => {}}
      />,
    );
    // "bf" is how someone who knows the pack asks for British female; a
    // picker matching only the display name would answer nothing.
    await userEvent.type(screen.getByLabelText(/Search voices/), "bf_");
    expect(screen.getByText("Emma")).toBeTruthy();
    expect(screen.queryByText("Sarah")).toBeNull();
  });

  it("says a pick cannot be honored rather than showing an empty list", () => {
    mountClient();
    render(
      <VoicePicker
        voices={payload({ available: false, voices: [], default: null })}
        value={null}
        scope="node"
        onPick={vi.fn()}
        onClose={() => {}}
      />,
    );
    // "none installed" would be a guess: the chain may narrate elsewhere.
    expect(screen.getByText("Narration is not using the voice pack")).toBeTruthy();
    expect(screen.queryByLabelText(/Search voices/)).toBeNull();
  });
});
