/**
 * The last mile: what you paste into the upload form.
 *
 * `POST /package` has existed since the engine grew a publish kit and
 * nothing ever called it, so a finished video left the app as a file and the
 * title, description and hashtags the engine can write from the screenplay
 * were never produced at all.
 *
 * Both halves are ordinary graph nodes, which is what makes the states here
 * worth pinning: asked-for-but-rendering is a real and slow state (two model
 * runs), and a blank card during it reads as broken.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState } from "../api/types";
import { useApp } from "../store";
import { PublishKit } from "./PublishKit";

const node = (id: string, status: string, hash: string | null = null): NodeState =>
  ({
    node_id: id,
    status,
    progress: status === "final" ? 1 : 0,
    error: null,
    artifact_hash: hash,
    params: {},
    seed: 0,
    model: null,
    pinned: false,
  }) as NodeState;

const KIT = {
  title: "Six things about snakes",
  description: "A short film about snakes, and what they are up to.",
  // The engine strips the leading # — the UI is what puts it back.
  hashtags: ["snakes", "nature"],
};

const mount = (aux: Record<string, NodeState>, extra: Record<string, unknown> = {}) => {
  useApp.setState({
    client: { artifactUrl: (_p: string, hash: string) => `http://engine/a/${hash}` },
    currentProject: { id: "p1", title: "t", approvals: [] },
    board: { scenes: [], aux, assembled_durations: {} } as unknown as Board,
    ...extra,
  } as never);
  render(<PublishKit />);
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ json: () => Promise.resolve(KIT) } as unknown as Response),
  );
});

describe("before anything has been packaged", () => {
  it("offers one button and nothing else", () => {
    mount({});
    expect(screen.getByRole("button", { name: /prepare to publish/i })).toBeEnabled();
    expect(screen.queryByText(/hashtags/i)).toBeNull();
  });

  it("asks the engine to build the kit", async () => {
    const preparePublish = vi.fn().mockResolvedValue(null);
    mount({}, { preparePublish });

    await userEvent.click(screen.getByRole("button", { name: /prepare to publish/i }));
    expect(preparePublish).toHaveBeenCalledOnce();
  });

  it("reports the engine's refusal where the button was", async () => {
    // The real one: 409 "script has not rendered yet" — an answer, not a
    // fault, and the user can act on it.
    const preparePublish = vi.fn().mockResolvedValue("script has not rendered yet");
    mount({}, { preparePublish });

    await userEvent.click(screen.getByRole("button", { name: /prepare to publish/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/script has not rendered/i);
  });
});

describe("while the kit is rendering", () => {
  it("says so rather than showing an empty card", () => {
    // Two model runs. A card with three blank fields is indistinguishable
    // from one that failed.
    mount({ metadata: node("metadata", "rendering"), thumbnail: node("thumbnail", "rendering") });
    expect(screen.getByRole("status")).toHaveTextContent(/writing the title/i);
  });
});

describe("once the kit has rendered", () => {
  const done = {
    metadata: node("metadata", "final", "m".repeat(64)),
    thumbnail: node("thumbnail", "final", "t".repeat(64)),
  };

  it("shows each field the engine wrote", async () => {
    mount(done);
    expect(await screen.findByText(KIT.title)).toBeInTheDocument();
    expect(screen.getByText(KIT.description)).toBeInTheDocument();
  });

  it("puts the # back on the hashtags", async () => {
    // The engine strips it, so bare words would be pasted into a caption box
    // and mean nothing.
    mount(done);
    expect(await screen.findByText("#snakes #nature")).toBeInTheDocument();
  });

  it("copies a field to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mount(done);
    await screen.findByText(KIT.title);

    await userEvent.click(screen.getByRole("button", { name: /copy the title/i }));
    expect(writeText).toHaveBeenCalledWith(KIT.title);
  });

  it("shows the thumbnail the engine conditioned on the script", async () => {
    mount(done);
    expect(await screen.findByAltText(/suggested thumbnail/i)).toHaveAttribute(
      "src",
      `http://engine/a/${"t".repeat(64)}`,
    );
  });

  it("does not fetch the metadata until it has actually rendered", async () => {
    // artifact_hash is set from the moment the node is planned; fetching on
    // that alone asks for a file the engine has not written.
    mount({ metadata: node("metadata", "rendering", "m".repeat(64)) });
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(fetch).not.toHaveBeenCalled();
  });
});
