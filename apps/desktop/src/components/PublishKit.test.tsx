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

const onClose = vi.fn();

const mount = (aux: Record<string, NodeState>, extra: Record<string, unknown> = {}) => {
  useApp.setState({
    client: { artifactUrl: (_p: string, hash: string) => `http://engine/a/${hash}` },
    currentProject: { id: "p1", title: "t", approvals: [] },
    board: { scenes: [], aux, assembled_durations: {} } as unknown as Board,
    ...extra,
  } as never);
  render(<PublishKit onClose={onClose} />);
};

beforeEach(() => {
  localStorage.clear();
  onClose.mockClear();
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
    // By field, not by any text: the dialog's own hint names the hashtags
    // it is about to write, which is not the same as offering the field.
    expect(screen.queryByLabelText(/^hashtags$/i)).toBeNull();
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
    expect(await screen.findByLabelText(/^title$/i)).toHaveValue(KIT.title);
    expect(screen.getByLabelText(/^description$/i)).toHaveValue(KIT.description);
  });

  it("puts the # back on the hashtags", async () => {
    // The engine strips it, so bare words would be pasted into a caption box
    // and mean nothing.
    mount(done);
    expect(await screen.findByLabelText(/^hashtags$/i)).toHaveValue("#snakes #nature");
  });

  it("copies a field to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mount(done);
    await screen.findByLabelText(/^title$/i);

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

/**
 * The kit is a staging area for a paste into someone else's upload form, so
 * the text has to be editable — the engine's first guess at a title is a
 * starting point, not a verdict.
 *
 * Where those edits live is forced: `metadata` is a graph node whose
 * ARTIFACT is what the model wrote, and its params are the prompt that
 * produced it, so there is no `set_params` meaning "keep my title instead".
 * localStorage per project, the shape `editlog` already uses.
 */
describe("editing what will be pasted", () => {
  const done = {
    metadata: node("metadata", "final", "m".repeat(64)),
    thumbnail: node("thumbnail", "final", "t".repeat(64)),
  };

  it("copies the edited text, not the engine's", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mount(done);
    const title = await screen.findByLabelText(/^title$/i);

    await userEvent.clear(title);
    await userEvent.type(title, "Snakes, ranked");
    await userEvent.click(screen.getByRole("button", { name: /copy the title/i }));

    expect(writeText).toHaveBeenCalledWith("Snakes, ranked");
  });

  it("keeps an edit for the next time the dialog opens", async () => {
    mount(done);
    const title = await screen.findByLabelText(/^title$/i);
    await userEvent.clear(title);
    await userEvent.type(title, "Snakes, ranked");

    // A fresh mount, as reopening the dialog is.
    screen.getByRole("dialog").remove();
    mount(done);
    expect(await screen.findByLabelText(/^title$/i)).toHaveValue("Snakes, ranked");
  });

  it("leaves untouched fields to follow a regenerate", async () => {
    // Only edited fields are remembered. Storing the whole kit would shadow
    // a rewritten description forever behind one that was never changed.
    mount(done);
    const title = await screen.findByLabelText(/^title$/i);
    await userEvent.clear(title);
    await userEvent.type(title, "Snakes, ranked");

    const draft = JSON.parse(localStorage.getItem("localcut.publishDraft.p1") ?? "{}");
    expect(Object.keys(draft)).toEqual(["title"]);
  });

  it("takes hashtags with or without the hash and stores them bare", async () => {
    mount(done);
    const tags = await screen.findByLabelText(/^hashtags$/i);
    await userEvent.clear(tags);
    await userEvent.type(tags, "#reptiles nature");

    const draft = JSON.parse(localStorage.getItem("localcut.publishDraft.p1") ?? "{}");
    expect(draft.hashtags).toEqual(["reptiles", "nature"]);
  });

  it("closes on Escape without leaving the keystroke for the board", async () => {
    mount(done);
    await screen.findByLabelText(/^title$/i);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * `aria-modal` is a promise about focus, not just a label. The dialog
 * follows the same discipline SavePoints does — Escape closes and consumes
 * the keystroke, Tab stays inside — and wears the app's own modal recipe
 * rather than a hand-rolled grid beside it.
 */
describe("the dialog itself", () => {
  const done = {
    metadata: node("metadata", "final", "m".repeat(64)),
    thumbnail: node("thumbnail", "final", "t".repeat(64)),
  };

  it("keeps Tab inside the dialog", async () => {
    mount(done);
    await screen.findByLabelText(/^title$/i);
    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll<HTMLElement>("button, input, textarea");
    const last = focusable[focusable.length - 1];

    last.focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("wears the app's modal field recipe, not one of its own", async () => {
    // The first version hand-rolled a grid and looked like a different app.
    // `.field` is what every other modal here labels a control with.
    mount(done);
    await screen.findByLabelText(/^title$/i);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelectorAll("label.field")).toHaveLength(3);
    expect(dialog.querySelector(".modal-actions")).not.toBeNull();
  });
});
