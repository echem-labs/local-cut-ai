/**
 * Templates and the style preset (U2) — the two places where what the UI
 * chooses has to reach the engine intact.
 *
 * A template is a document the engine writes and reads back; this profile
 * only keeps it, so the properties worth pinning are the ones the engine
 * cannot enforce for us: the saved list is bounded, an import surfaces what
 * it will spend BEFORE the project opens, and every rejection comes back as
 * a message rather than a thrown error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "./i18n";
import { TEMPLATE_LIMIT, loadTemplates } from "./lib/templates";
import { useApp } from "./store";

const PROJECT = { id: "p1", title: "Bee documentary", created_at: 0, updated_at: 0, mode: "prompt" };

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    listJobs: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue({ project: PROJECT, board: { scenes: [] } }),
    history: vi.fn().mockResolvedValue({ undo: 0, redo: 0, save_points: [] }),
    createProject: vi.fn().mockResolvedValue(PROJECT),
    exportTemplate: vi.fn().mockResolvedValue({ version: 1, nodes: {} }),
    createFromTemplate: vi.fn().mockResolvedValue({
      project: PROJECT,
      cloud_models: [],
      dropped_assets: 0,
    }),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  localStorage.clear();
  useApp.setState({
    client: null,
    projects: [],
    allJobs: [],
    templates: [],
    templateNotice: null,
    currentProject: null,
    openProjects: [],
  } as never);
});

describe("saving a template", () => {
  it("keeps what the engine exported, newest first, and survives a reload", async () => {
    useApp.setState({ client: fakeClient() } as never);
    expect(await useApp.getState().saveTemplate("p1", "Explainer shell")).toBeNull();
    expect(useApp.getState().templates[0].name).toBe("Explainer shell");
    // The list is this profile's, not the engine's — so it must be on disk.
    expect(loadTemplates()[0].name).toBe("Explainer shell");
  });

  it("refuses past the limit with a message, not an exception", async () => {
    useApp.setState({
      client: fakeClient(),
      templates: Array.from({ length: TEMPLATE_LIMIT }, (_, i) => ({
        id: `t${i}`,
        name: `t${i}`,
        savedAt: i,
        doc: {},
      })),
    } as never);
    expect(await useApp.getState().saveTemplate("p1", "one more")).toBe(
      t("errors.templateLimit", { limit: TEMPLATE_LIMIT }),
    );
    expect(useApp.getState().templates).toHaveLength(TEMPLATE_LIMIT);
  });

  it("refuses a document too large to keep", async () => {
    const huge = { nodes: "x".repeat(600 * 1024) };
    useApp.setState({
      client: fakeClient({ exportTemplate: vi.fn().mockResolvedValue(huge) }),
    } as never);
    expect(await useApp.getState().saveTemplate("p1", "huge")).toBe(t("errors.templateSize"));
  });

  it("reports the engine's own refusal", async () => {
    useApp.setState({
      client: fakeClient({
        exportTemplate: vi.fn().mockRejectedValue(new Error("engine 404: project not found")),
      }),
    } as never);
    expect(await useApp.getState().saveTemplate("gone", "x")).toContain("project not found");
  });

  it("has no engine to ask when nothing is connected", async () => {
    expect(await useApp.getState().saveTemplate("p1", "x")).toBe(t("errors.engineUnavailable"));
  });
});

describe("starting from a template", () => {
  it("sends the saved document and opens what came back", async () => {
    const client = fakeClient();
    useApp.setState({
      client,
      templates: [{ id: "t1", name: "Explainer", savedAt: 1, doc: { version: 1 } }],
    } as never);
    expect(await useApp.getState().startFromTemplate("t1", "New video")).toBeNull();
    expect(client.createFromTemplate).toHaveBeenCalledWith({ version: 1 }, "New video");
    expect(useApp.getState().currentProject?.id).toBe("p1");
  });

  it("surfaces the spend and the dropped assets before the project opens", async () => {
    const seen: (string | null)[] = [];
    const client = fakeClient({
      createFromTemplate: vi.fn().mockResolvedValue({
        project: PROJECT,
        cloud_models: ["cloud:veo-3"],
        dropped_assets: 2,
      }),
      getProject: vi.fn().mockImplementation(async () => {
        // The notice must already be set by the time the project loads —
        // otherwise it lands after the screen it is warning about.
        seen.push(useApp.getState().templateNotice?.cloudModels[0] ?? null);
        return { project: PROJECT, board: { scenes: [] } };
      }),
    });
    useApp.setState({
      client,
      templates: [{ id: "t1", name: "Veo template", savedAt: 1, doc: {} }],
    } as never);
    await useApp.getState().startFromTemplate("t1");
    expect(seen).toEqual(["cloud:veo-3"]);
    expect(useApp.getState().templateNotice?.droppedAssets).toBe(2);
  });

  it("says nothing when there is nothing to say", async () => {
    useApp.setState({
      client: fakeClient(),
      templates: [{ id: "t1", name: "Plain", savedAt: 1, doc: {} }],
    } as never);
    await useApp.getState().startFromTemplate("t1");
    expect(useApp.getState().templateNotice).toBeNull();
  });

  it("reports a template that is no longer on this machine", async () => {
    useApp.setState({ client: fakeClient() } as never);
    expect(await useApp.getState().startFromTemplate("gone")).toBe(t("errors.templateMissing"));
  });
});

describe("the style preset", () => {
  it("travels to the engine when the UI has one", async () => {
    const client = fakeClient();
    useApp.setState({ client } as never);
    await useApp.getState().createFromPrompt("a bee", 60, "16:9", "prompt", "documentary");
    expect(client.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ style_preset: "documentary" }),
    );
  });

  it("is left out entirely when it is empty, so the engine's default applies", async () => {
    const client = fakeClient();
    useApp.setState({ client } as never);
    await useApp.getState().createFromPrompt("a bee", 60, "16:9", "prompt", "");
    expect(client.createProject).toHaveBeenCalledWith(
      expect.not.objectContaining({ style_preset: expect.anything() }),
    );
  });
});
