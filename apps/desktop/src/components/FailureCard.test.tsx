/**
 * The card that turns an out-of-memory failure into choices.
 *
 * `scheduler.py` has published `suggestions` with every exhausted OOM ladder
 * since it was written, under the comment "the UI renders this as choices,
 * not an error code" — and nothing rendered them. The user saw "out of
 * memory after 2 fallback attempts" and had no move except pressing the same
 * button again, which would fail the same way.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelRow, NodeState } from "../api/types";
import { useApp } from "../store";
import { FailureCard } from "./FailureCard";

const node = (overrides: Partial<NodeState> = {}): NodeState =>
  ({
    node_id: "s1.clip",
    status: "failed",
    progress: 0,
    error: "out of memory after 2 fallback attempts: cuda oom",
    artifact_hash: null,
    params: {},
    seed: 0,
    model: null,
    pinned: false,
    ...overrides,
  }) as NodeState;

const model = (id: string, task: string, vram: number, quality: number): ModelRow =>
  ({
    id,
    task,
    requirements: { vram_gb: vram, ram_gb: 8, disk_gb: 4, backends: ["comfyui"] },
    quality_score: quality,
    downloaded: true,
  }) as unknown as ModelRow;

const seed = (state: Record<string, unknown>) =>
  useApp.setState({
    client: null,
    currentProject: { id: "p1", title: "t", approvals: [] },
    models: [],
    jobs: [],
    nodeFailures: {},
    nodeRetries: {},
    ...state,
  } as never);

beforeEach(() => seed({}));

describe("a failure with no advice", () => {
  it("shows the engine's message and nothing else", () => {
    // The common path: a backend threw, an input would not decode. There are
    // no choices to offer, and inventing some would be worse than none.
    seed({});
    render(<FailureCard node={node()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/out of memory after 2 fallback/i);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("renders nothing at all for a node that did not fail", () => {
    const { container } = render(<FailureCard node={node({ status: "draft", error: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("a failure the engine had suggestions for", () => {
  const withSuggestions = {
    nodeFailures: {
      "s1.clip": {
        error: "out of memory after 2 fallback attempts: cuda oom",
        suggestions: ["lower_resolution", "smaller_model", "cloud"],
      },
    },
  };

  it("offers every suggestion the engine sent", () => {
    seed({ ...withSuggestions, models: [model("big", "video.t2v", 24, 9)] });
    render(<FailureCard node={node()} />);

    expect(screen.getByRole("group", { name: /ran out of memory/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /render it smaller/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /cloud provider/i })).toBeEnabled();
  });

  it("names the model it would switch to", () => {
    // A chip reading "use a smaller model" asks the user to trust an unnamed
    // swap. The one it will actually make is knowable, so it is named.
    seed({
      ...withSuggestions,
      models: [model("wan-14b", "video.t2v", 24, 9), model("ltx-2b", "video.t2v", 8, 6)],
      jobs: [
        {
          id: "j1",
          project_id: "p1",
          status: "failed",
          model: "wan-14b",
          created_at: 10,
          spec: { node_id: "s1.clip", kind: "clip" },
        },
      ],
    });
    render(<FailureCard node={node()} />);
    expect(screen.getByRole("button", { name: /ltx-2b/ })).toBeEnabled();
  });

  it("disables the model chip when nothing smaller is installed, and says why", () => {
    // Still shown, not hidden: the engine believes three ways out exist, and
    // a card listing two would quietly disagree with it.
    seed({ ...withSuggestions, models: [] });
    render(<FailureCard node={node()} />);

    const chip = screen.getByTitle(/no smaller model for this step is installed/i);
    expect(chip).toBeDisabled();
  });

  it("stops offering to shrink a node already at the floor", () => {
    seed({ ...withSuggestions, models: [] });
    render(<FailureCard node={node({ params: { resolution_scale: 0.25 } })} />);

    expect(screen.getByRole("button", { name: /render it smaller/i })).toBeDisabled();
    expect(screen.getByTitle(/already at the smallest/i)).toBeInTheDocument();
  });

  it("does not dress an unrecognised code up as one it knows", async () => {
    // A newer engine sending a fourth code fell through to the cloud arm: the
    // chip read "Set up a cloud provider", and pressing it answered "this
    // build does not know how to act on that suggestion". Still shown and
    // still disabled — for the same reason an unservable chip is, the engine
    // believes a way out exists — but labelled as what it is.
    seed({
      nodeFailures: {
        "s1.clip": { error: "cuda oom", suggestions: ["lower_resolution", "reduce_frames"] },
      },
      models: [],
    });
    render(<FailureCard node={node()} />);

    expect(screen.queryByRole("button", { name: /cloud provider/i })).toBeNull();
    const chip = screen.getByTitle(/does not know how to act/i);
    expect(chip).toBeDisabled();
  });

  it("applies the suggestion it was asked to", async () => {
    const applyOomSuggestion = vi.fn().mockResolvedValue(null);
    seed({ ...withSuggestions, models: [], applyOomSuggestion });
    render(<FailureCard node={node()} />);

    await userEvent.click(screen.getByRole("button", { name: /render it smaller/i }));
    expect(applyOomSuggestion).toHaveBeenCalledWith("s1.clip", "lower_resolution");
  });

  it("reports a refusal where the chip was pressed", async () => {
    // The store's convention: null applied, anything else is a message. A
    // chip that silently does nothing is the failure mode this avoids.
    const applyOomSuggestion = vi.fn().mockResolvedValue("the engine could not be reached");
    seed({ ...withSuggestions, models: [], applyOomSuggestion });
    render(<FailureCard node={node()} />);

    await userEvent.click(screen.getByRole("button", { name: /render it smaller/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be reached/i);
  });
});
