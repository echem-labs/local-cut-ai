/**
 * The session's bottom dock holds the actions AND the composer.
 *
 * The composer is stuck to the bottom of the scroll, and a sticky box is
 * lifted out of the flow it belongs to. While it carried the sticky alone
 * it was pulled up over the action row that flows immediately above it: on
 * a 1000x700 window the U8 sweep found Download, Copy, Regenerate and
 * "Turn into a video" all answering `elementFromPoint` with the composer's
 * own row — drawn where the layout put them, and clickable nowhere. The
 * primary call to action of a script session was invisible until you
 * scrolled, on the smallest window the app will open at.
 *
 * The cure is structural rather than a number: a sticky box cannot cover
 * what it shares a sticky box with, so the two are wrapped together and the
 * dock does the sticking. That is a fact about the TREE, which is why this
 * test asserts on ancestry rather than on any style — jsdom applies no
 * stylesheet, and a rule about the run's shape survives restyling anyway.
 * The stylesheet's half of the contract (the dock sticks, the composer no
 * longer does) is pinned below, read from the CSS the way tokens.test.ts
 * does.
 *
 * What must NOT change is the resting layout: the wrapper repeats
 * .tool-session's own column so a session with nothing to scroll lays out
 * to the same pixels, which is what keeps the U3 parity frames true. That
 * part is the pixel gate's to prove (rig:parity:session), not this file's.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Board, NodeState, Project } from "../api/types";
import { useApp } from "../store";
import { ToolSession } from "./ToolSession";

/** Through a parameter, not as a literal: vite rewrites a STATIC
 * `new URL("...", import.meta.url)` into an asset URL, and the http one it
 * hands back fails `fileURLToPath` with "the URL must be of scheme file".
 * The same indirection is why styles/tokens.test.ts reads its CSS this way. */
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const CSS = read("../styles/app.css");

/** The body of the first `<selector> { … }` rule in app.css. */
const rule = (selector: string): string => {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `the ${selector} rule is gone`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  return CSS.slice(open, CSS.indexOf("}", open));
};

const scriptNode = (): NodeState => ({
  node_id: "script",
  status: "draft",
  progress: 1,
  error: null,
  artifact_hash: "a".repeat(64),
  params: { prompt: "How the sweep found its screens" },
  seed: 7,
  model: null,
  pinned: false,
});

function mountScriptSession() {
  useApp.setState({
    currentProject: {
      id: "p1",
      title: "T",
      created_at: 0,
      updated_at: 0,
      mode: "tool:script",
      approvals: [],
    } as unknown as Project,
    board: { scenes: [], aux: { script: scriptNode() } } as unknown as Board,
    client: {
      artifactUrl: () => "http://engine/a",
      artifactPeaks: vi.fn().mockRejectedValue(new Error("no peaks in tests")),
    },
    jobs: [],
    allJobs: [],
    projects: [],
    actionError: null,
  } as never);
  return render(<ToolSession />);
}

describe("the session dock", () => {
  it("holds the action row and the composer in one sticky run", () => {
    const { container } = mountScriptSession();
    const dock = container.querySelector(".tool-dock");
    expect(dock, "the session has no dock").not.toBeNull();
    const actions = container.querySelector(".tool-actions");
    const composer = container.querySelector(".tool-composer");
    expect(actions, "the session has no action row").not.toBeNull();
    expect(composer, "the session has no composer").not.toBeNull();
    // Both inside the SAME dock: two sticky runs would stack on each other
    // exactly as the composer stacked on the actions.
    expect(dock!.contains(actions!)).toBe(true);
    expect(dock!.contains(composer!)).toBe(true);
  });

  it("keeps every session action inside it, not only the first", async () => {
    // Copy only appears once the screenplay has loaded, and all four of
    // these are named rather than counted: they are exactly the controls
    // the sweep found under the composer.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ title: "T", hook: "", scenes: [] }),
      }),
    );
    const { container } = mountScriptSession();
    const dock = container.querySelector(".tool-dock")!;
    for (const label of ["Download", "Copy", "Regenerate", "Turn into a video"]) {
      const control = await screen.findByText(label);
      expect(dock.contains(control), `${label} is outside the dock`).toBe(true);
    }
  });

  it("puts the sticky on the dock and takes it off the composer", () => {
    expect(rule(".tool-dock")).toMatch(/position:\s*sticky/);
    expect(rule(".tool-dock")).toMatch(/bottom:\s*0/);
    // The composer sticking on its own is the bug, whatever else is true.
    expect(rule(".tool-composer")).not.toMatch(/position:\s*sticky/);
  });

  it("gives the dock a background, so what scrolls under it does not show", () => {
    // .prompt-box brings its own surface; the action row does not, and a
    // docked run that is transparent shows the table through the buttons.
    expect(rule(".tool-dock")).toMatch(/background:\s*var\(--surface-0\)/);
  });
});
