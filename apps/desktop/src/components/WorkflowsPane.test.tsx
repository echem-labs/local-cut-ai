/**
 * Settings → Workflows.
 *
 * The load-bearing part is the enable path. A node pack is third-party
 * Python that runs unsandboxed with access to the models, the files and
 * the network, and the engine gates it on an explicit
 * `acknowledge_code_execution` for exactly that reason (doc 07 risk 9).
 * The tests below are mostly about that flag never acquiring a default,
 * the engine's own warning reaching the screen unedited, and the version
 * being the operator's answer rather than a guess.
 *
 * The engine re-checks all of it. That does not make the client's gate
 * decorative: it is what makes the decision *informed*, which is the half
 * an API cannot enforce.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowsPane } from "./WorkflowsPane";
import { t } from "../i18n";
import { useApp } from "../store";

/** The engine's real sentence, as allowlist.py holds it. */
const WARNING =
  "Custom node packs are third-party Python that runs inside ComfyUI, with access to " +
  "your models, your files and the network. Enable a pack only if you installed it " +
  "yourself and trust its source. LocalCut AI does not sandbox or review pack code.";

const PACKS = {
  warning: WARNING,
  builtin_nodes: ["KSampler", "CheckpointLoaderSimple"],
  packs: [
    {
      id: "comfyui-videohelpersuite",
      name: "VideoHelperSuite",
      repo: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite",
      summary: "Video loading and frame batching nodes.",
      nodes: ["VHS_LoadVideo", "VHS_VideoCombine"],
      enabled: false,
      version: null,
    },
    {
      id: "comfyui-controlnet-aux",
      name: "ControlNet Auxiliary",
      repo: "https://github.com/Fannovel16/comfyui_controlnet_aux",
      summary: "",
      nodes: ["DWPreprocessor"],
      enabled: true,
      version: "1.0.7",
    },
  ],
};

const WORKFLOWS = [
  { name: "my-i2v", nodes: 24, placeholders: ["%%PROMPT%%", "%%SEED%%"], readable: true },
  { name: "fixed-look", nodes: 12, placeholders: [], readable: true },
];

let enableNodePack: ReturnType<typeof vi.fn>;
let disableNodePack: ReturnType<typeof vi.fn>;
let refreshComfy: ReturnType<typeof vi.fn>;

async function mount(over: Record<string, unknown> = {}) {
  enableNodePack = vi.fn(async () => null);
  disableNodePack = vi.fn(async () => null);
  refreshComfy = vi.fn(async () => null);
  useApp.setState({
    nodePacks: PACKS,
    workflows: WORKFLOWS,
    refreshComfy,
    enableNodePack,
    disableNodePack,
    importWorkflow: vi.fn(async () => null),
    deleteWorkflow: vi.fn(async () => null),
    client: { reviewWorkflow: vi.fn(async () => ({ warnings: [] })) },
    ...over,
  } as never);
  await act(async () => {
    render(<WorkflowsPane />);
  });
}

/** Open the grant dialog for the pack that is not yet enabled. */
async function openEnable() {
  await act(async () => {
    fireEvent.click(screen.getByText(t("settings.workflows.enable")));
  });
}

const confirmButton = () =>
  screen.getByRole("button", { name: t("settings.workflows.enableConfirm") });

beforeEach(() => {
  useApp.setState({ nodePacks: null, workflows: [] } as never);
});

describe("what the pane shows", () => {
  it("lists each pack with its repo and whether it is enabled", async () => {
    await mount();
    expect(screen.getByText("VideoHelperSuite")).toBeInTheDocument();
    expect(
      screen.getByText("https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite"),
    ).toBeInTheDocument();
    // The grant is pinned to a version, so the row says which one.
    expect(
      screen.getByText(t("settings.workflows.enabledAt", { version: "1.0.7" })),
    ).toBeInTheDocument();
  });

  it("says a workflow with no slots renders the same thing every time", async () => {
    // Otherwise it looks like a broken model rather than a graph that
    // ignores the prompt it is handed.
    await mount();
    expect(screen.getByText(new RegExp(t("settings.workflows.noSlots")))).toBeInTheDocument();
  });
});

describe("enabling a pack", () => {
  it("shows the engine's warning verbatim, not a paraphrase of it", async () => {
    // Straight from the /comfy/node-packs response. The engine ships the
    // sentence with every response precisely so no client can present the
    // action without it — softening it here would defeat that.
    await mount();
    await openEnable();
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("will not enable until the acknowledgement is ticked", async () => {
    await mount();
    await openEnable();
    fireEvent.change(screen.getByLabelText(t("settings.workflows.versionLabel")), {
      target: { value: "1.4.2" },
    });
    // Version alone is not consent.
    expect(confirmButton()).toBeDisabled();
  });

  it("will not enable on the acknowledgement alone", async () => {
    // The engine refuses to guess the installed version, because a pin to
    // a guessed version pins nothing.
    await mount();
    await openEnable();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirmButton()).toBeDisabled();
  });

  it("sends the version and a true acknowledgement once both are given", async () => {
    await mount();
    await openEnable();
    fireEvent.change(screen.getByLabelText(t("settings.workflows.versionLabel")), {
      target: { value: " 1.4.2 " },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(confirmButton());
    });

    expect(enableNodePack).toHaveBeenCalledWith("comfyui-videohelpersuite", "1.4.2", true);
  });

  it("keeps the dialog open and says why when the engine refuses", async () => {
    // Closing on a refusal would leave the pack disabled with nothing on
    // screen to say the grant did not happen.
    await mount({ enableNodePack: vi.fn(async () => "engine 422: acknowledgement required") });
    await openEnable();
    fireEvent.change(screen.getByLabelText(t("settings.workflows.versionLabel")), {
      target: { value: "1.4.2" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(confirmButton());
    });

    expect(await screen.findByText("engine 422: acknowledgement required")).toBeInTheDocument();
    expect(confirmButton()).toBeInTheDocument();
  });

  it("revokes a grant without asking twice", async () => {
    // Turning code execution OFF needs no ceremony — the dangerous
    // direction is the other one.
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.workflows.disable")));
    });
    expect(disableNodePack).toHaveBeenCalledWith("comfyui-controlnet-aux");
  });
});

describe("loading", () => {
  it("asks the engine for packs and workflows together on open", async () => {
    // One refresh, both resources: a document listed without the grants it
    // is judged against renders as broken when the answer is "enable a
    // pack".
    await mount();
    expect(refreshComfy).toHaveBeenCalled();
  });

  it("surfaces an engine that would not answer", async () => {
    await mount({ refreshComfy: vi.fn(async () => "engine 503: unavailable") });
    await waitFor(() =>
      expect(screen.getByText("engine 503: unavailable")).toBeInTheDocument(),
    );
  });
});
