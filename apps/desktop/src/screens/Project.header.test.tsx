/**
 * The project header gives way by wrapping, not by crushing its title.
 *
 * The header is a flex row: the project's name on the left, then the
 * pipeline checklist, the view and density pickers, the overflow menu,
 * "Publish kit" and "Create final video". Everything to the right of the
 * title sets `white-space: nowrap`, so all of it has a floor. The title
 * carried `flex: 1` — basis `0%` — and so had none, which makes it the only
 * item the row can take space from. At 1000x700, the app's own minimum
 * width, that left it ten pixels wide: one clipped glyph of the project
 * name drawn over the checklist beside it.
 *
 * Nothing errored, nothing overflowed the document, and no control was
 * covered — so every machine check in the U8 sweep passed the screen. It
 * was the eyeball pass over the sweep's own frames that caught it, which is
 * the argument for keeping that pass in the phase.
 *
 * The fix is a real flex-basis plus `flex-wrap`, and the two are one idea:
 * an item with a zero basis contributes nothing to the line, so it can
 * never be the item that overflows it and wrapping would never trigger. The
 * toolbar is grouped into a single item so that the wrap is a choice
 * between one line and two rather than a break at whichever control
 * happened to run out of room.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Board, NodeState, Project as ProjectType } from "../api/types";
import { useApp } from "../store";
import { Project } from "./Project";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const CSS = read("../styles/app.css");

/** The body of the first `<selector> { … }` rule in app.css.
 *
 * Anchored to the start of a line, because `.board-header` is also the tail
 * of `.project-shell .board-header` — and a substring search finds that one
 * first and reads a rule that says nothing about wrapping. */
const rule = (selector: string): string => {
  const at = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`, "m").exec(CSS);
  expect(at, `the ${selector} rule is gone`).not.toBeNull();
  const open = CSS.indexOf("{", at!.index);
  return CSS.slice(open, CSS.indexOf("}", open));
};

const node = (id: string, status: string, hash: string | null = null): NodeState =>
  ({
    node_id: id,
    status,
    progress: 0,
    error: null,
    artifact_hash: hash,
    params: {},
    seed: 0,
    model: null,
    pinned: false,
  }) as NodeState;

const mount = () => {
  const project = {
    id: "p1",
    title: "How the sweep found its screens",
    mode: "auto",
    approvals: [],
  } as unknown as ProjectType;
  const board = {
    scenes: [
      {
        scene_id: "s1",
        keyframe: node("s1.keyframe", "final"),
        clip: node("s1.clip", "final", "c".repeat(64)),
        narration: node("s1.narration", "final"),
      },
    ],
    aux: { script: node("script", "final"), timeline: node("timeline", "final") },
    assembled_durations: {},
  } as unknown as Board;
  useApp.setState({
    currentProject: project,
    board,
    jobs: [],
    allJobs: [],
    projects: [],
    actionError: null,
    client: {
      artifactUrl: (_p: string, hash: string) => `http://engine/a/${hash}`,
      getProject: () => Promise.resolve({ project, board }),
      listJobs: () => Promise.resolve([]),
      history: () => Promise.resolve({ undo_depth: 0, redo_depth: 0, savepoints: [] }),
    },
  } as never);
  return render(<Project />);
};

describe("the project header", () => {
  it("keeps the title and the toolbar as two items, not seven", () => {
    const { container } = mount();
    const header = container.querySelector(".board-header");
    expect(header, "the project header is gone").not.toBeNull();
    const tools = container.querySelector(".board-tools");
    expect(tools, "the header toolbar is not grouped").not.toBeNull();
    // The pipeline is the widest of the unshrinkable things beside the
    // title; if it is loose in the header, the row breaks at an arbitrary
    // control instead of between the title and everything else.
    expect(tools!.querySelector(".pipeline"), "the checklist is outside the toolbar").not.toBeNull();
    expect(header!.querySelector(":scope > .board-title")).not.toBeNull();
    expect(header!.querySelector(":scope > .pipeline"), "the checklist is a loose header item").toBeNull();
  });

  it("gives the title a width to lose before it loses any", () => {
    const title = rule(".board-title");
    const basis = /flex:\s*1\s+1\s+(\d+)px/.exec(title);
    expect(basis, "the title's flex basis is not a length").not.toBeNull();
    // The number itself is a judgement, but zero is not: a zero basis is
    // exactly the state that produced a ten-pixel title.
    expect(Number(basis![1])).toBeGreaterThan(0);
  });

  it("lets the header wrap rather than crush", () => {
    expect(rule(".board-header")).toMatch(/flex-wrap:\s*wrap/);
  });
});
