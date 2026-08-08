/**
 * About — the pane someone reads when things have already gone wrong.
 *
 * The facts it states are load-bearing in a way most UI is not: a version
 * line, a hardware summary and a folder path are what a bug report is
 * built from, and each is wrong in a way nobody can see from the outside.
 * So the tests here mostly assert that an unknown stays visibly unknown
 * rather than rendering as blank, and that the three shell errands hand
 * over exactly what the shell expects.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AboutPane } from "./AboutPane";
import { t } from "../i18n";
import { useApp } from "../store";

const SYSTEM = {
  hardware: {
    os: "linux",
    arch: "x64",
    ram_gb: 32,
    disk_free_gb: 410,
    gpus: [{ name: "RTX 3080 Laptop GPU", vram_gb: 8 }],
    primary_gpu: { name: "RTX 3080 Laptop GPU", vram_gb: 8 },
    tier: "A",
  },
  recommendations: [],
  backend_mode: "local",
  backends: { chain: ["local", "mock"], comfy_kinds_auto: true, tasks: [] },
};

const STORAGE = {
  data_dir: "/home/dev/.localcut",
  projects: [{ id: "p1", title: "A tour", bytes: 2_000_000 }],
  models_bytes: 1_000_000,
  cache_bytes: 0,
  disk_free_bytes: 1_000_000_000,
  disk_total_bytes: 2_000_000_000,
};

let bridge: Record<string, ReturnType<typeof vi.fn> | boolean>;
const onShowLicenses = vi.fn();

/** The shell bridge, with every errand answering success by default. */
function stubBridge(overrides: Record<string, unknown> = {}) {
  bridge = {
    openLogsFolder: vi.fn(async () => ({ ok: true, error: null })),
    exportSupportBundle: vi.fn(async () => ({ path: "/home/dev/support.zip", error: null })),
    checkForUpdates: vi.fn(async () => ({ latest: null, url: null, error: null })),
    updatesConfigured: false,
    ...overrides,
  } as never;
  (window as unknown as { localcut: unknown }).localcut = bridge;
}

async function mount(state: Record<string, unknown> = {}) {
  useApp.setState({
    system: SYSTEM,
    storage: STORAGE,
    engineVersions: { ok: true, engine_version: "0.1.0", api_version: 1 },
    client: { baseUrl: "http://127.0.0.1:7830" },
    remoteEngine: false,
    refreshStorage: vi.fn(async () => {}),
    ...state,
  } as never);
  await act(async () => {
    render(<AboutPane onShowLicenses={onShowLicenses} />);
  });
}

beforeEach(() => {
  stubBridge();
  localStorage.clear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
  delete (window as unknown as { localcut?: unknown }).localcut;
});

describe("what version this is", () => {
  it("states app, engine and API on one line", async () => {
    await mount();
    expect(
      screen.getByText(t("settings.about.versionLine", { app: "0.1.0", engine: "0.1.0", api: "v1" })),
    ).toBeInTheDocument();
  });

  it("shows a dash for an engine that has not answered yet", async () => {
    // Not an empty string: About is read while the engine is down, and a
    // blank where a version belongs looks like a version of "".
    await mount({ engineVersions: null });
    const dash = t("settings.engine.dash");
    expect(
      screen.getByText(t("settings.about.versionLine", { app: "0.1.0", engine: dash, api: dash })),
    ).toBeInTheDocument();
  });
});

describe("this machine", () => {
  it("names the tier, the backend chain and the engine", async () => {
    await mount();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("local, mock")).toBeInTheDocument();
    expect(
      screen.getByText(t("settings.about.engineLocal", { url: "http://127.0.0.1:7830" })),
    ).toBeInTheDocument();
  });

  it("says the engine is paired rather than local when it is remote", async () => {
    // The distinction is the whole point of the row: a path and a byte
    // count below it describe a different machine in this case.
    await mount({ remoteEngine: true, client: { baseUrl: "https://gpu-box:7830" } });
    expect(
      screen.getByText(t("settings.about.engineRemote", { url: "https://gpu-box:7830" })),
    ).toBeInTheDocument();
  });

  it("names the data folder and what is in it", async () => {
    await mount();
    expect(screen.getByText(/\/home\/dev\/\.localcut/)).toBeInTheDocument();
  });

  it("says so when the engine is too old to report its folder", async () => {
    const { data_dir: _omitted, ...older } = STORAGE;
    await mount({ storage: older });
    expect(screen.getByText(new RegExp(t("settings.about.dataFolderUnknown")))).toBeInTheDocument();
  });
});

describe("the update check", () => {
  it("is absent until a release feed is configured", async () => {
    // Hidden, not disabled: a button that can only ever fail is worse than
    // no button, and this is the shipping state until the repo is public.
    await mount();
    expect(screen.queryByText(t("settings.about.checkUpdates"))).not.toBeInTheDocument();
  });

  it("reports being up to date when the feed matches this build", async () => {
    stubBridge({
      updatesConfigured: true,
      checkForUpdates: vi.fn(async () => ({ latest: "0.1.0", url: "", error: null })),
    });
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.checkUpdates")));
    });
    expect(screen.getByText(t("settings.about.upToDate"))).toBeInTheDocument();
  });

  it("offers a newer version with a link to it", async () => {
    stubBridge({
      updatesConfigured: true,
      checkForUpdates: vi.fn(async () => ({
        latest: "0.2.0",
        url: "https://example/rel",
        error: null,
      })),
    });
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.checkUpdates")));
    });
    const link = screen.getByText(t("settings.about.updateAvailable", { version: "0.2.0" }));
    expect(link).toHaveAttribute("href", "https://example/rel");
  });

  it("does not offer a feed that has rolled backwards", async () => {
    // An update that walks the user to an older build is worse than none.
    stubBridge({
      updatesConfigured: true,
      checkForUpdates: vi.fn(async () => ({ latest: "0.0.9", url: "x", error: null })),
    });
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.checkUpdates")));
    });
    expect(screen.getByText(t("settings.about.upToDate"))).toBeInTheDocument();
  });

  it("shows why a check failed", async () => {
    stubBridge({
      updatesConfigured: true,
      checkForUpdates: vi.fn(async () => ({ latest: null, url: null, error: "HTTP 503" })),
    });
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.checkUpdates")));
    });
    expect(screen.getByText("HTTP 503")).toBeInTheDocument();
  });
});

describe("support", () => {
  it("copies a diagnostics block naming the app, engine and hardware", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.copy")));
    });

    const copied = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(copied).toContain("0.1.0");
    expect(copied).toContain("RTX 3080 Laptop GPU");
    expect(copied).toContain("http://127.0.0.1:7830");
  });

  it("hands the shell the versions and system report it cannot fetch itself", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.exportBundle")));
    });

    // The shell adds the logs; only the renderer has these two.
    expect(bridge.exportSupportBundle).toHaveBeenCalledWith({
      versions: { app: "0.1.0", ok: true, engine_version: "0.1.0", api_version: 1 },
      system: SYSTEM,
    });
    await waitFor(() =>
      expect(
        screen.getByText(t("settings.about.bundleSaved", { path: "/home/dev/support.zip" })),
      ).toBeInTheDocument(),
    );
  });

  it("says nothing at all when the save was cancelled", async () => {
    // Cancelling is a decision, not a failure — neither a path nor an error.
    stubBridge({ exportSupportBundle: vi.fn(async () => ({ path: null, error: null })) });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.exportBundle")));
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("surfaces a bundle the shell could not write", async () => {
    stubBridge({
      exportSupportBundle: vi.fn(async () => ({ path: null, error: "EACCES: permission denied" })),
    });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.exportBundle")));
    });
    expect(await screen.findByText("EACCES: permission denied")).toBeInTheDocument();
  });

  it("opens the log folder, and reports a folder the OS would not open", async () => {
    stubBridge({
      openLogsFolder: vi.fn(async () => ({ ok: false, error: "no application is registered" })),
    });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.openLogs")));
    });

    expect(bridge.openLogsFolder).toHaveBeenCalledWith();
    expect(await screen.findByText("no application is registered")).toBeInTheDocument();
  });

  it("opens the one shortcut overlay rather than listing keys again", async () => {
    // HelpMenu hosts it. A second copy of the shortcut list here is exactly
    // the drift the shared modal exists to prevent.
    const opened = vi.fn();
    window.addEventListener("localcut:open-shortcuts", opened);
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByText(t("settings.about.shortcuts")));
    });
    expect(opened).toHaveBeenCalled();
    window.removeEventListener("localcut:open-shortcuts", opened);
  });

  it("hands the licenses modal back to Settings, which owns it", async () => {
    await mount();
    fireEvent.click(screen.getByText(t("settings.about.licenses")));
    expect(onShowLicenses).toHaveBeenCalled();
  });
});
