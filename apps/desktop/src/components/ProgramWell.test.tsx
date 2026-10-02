/**
 * A program's well in each state it can be in, and the one action each
 * state offers: set it up, stop the setup, try again after a failure,
 * remove LocalCut's copy, or do it by hand.
 *
 * Two contexts with one rule between them. On the first run nothing has
 * failed yet, so a program that is simply not there is a to-do: no red edge
 * and no stage rows. In Settings, or after a setup that failed, it is a
 * problem with the machine, and the well says what it costs.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProgramInfo, ProgramsReport, ReadinessRow } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { ProgramWell } from "./ProgramWell";

const MB = 2 ** 20;

function ffmpeg(over: Partial<ProgramInfo> = {}): ProgramInfo {
  return {
    id: "ffmpeg",
    state: "missing",
    problem: "not_found",
    source: "path",
    location: "ffmpeg",
    setting: "LOCALCUT_FFMPEG_BIN",
    version: null,
    checks: { draws_text: null },
    managed: null,
    setup: {
      available: true,
      unavailable_reason: null,
      takes_effect: true,
      version: "8.1.3",
      url: "https://example.test/ffmpeg.tar.xz",
      download_bytes: 137_034_436,
      install_bytes: 283_955_728,
      job: null,
      last: null,
    },
    ...over,
  };
}

const ollama = (over: Partial<ProgramInfo> = {}): ProgramInfo => ({
  id: "ollama",
  state: "missing",
  problem: "unreachable",
  source: "default",
  location: "http://127.0.0.1:11434/v1",
  setting: "LOCALCUT_LLM_URL",
  version: null,
  checks: { server: null, model: "qwen3:14b", model_present: null },
  managed: null,
  setup: {
    available: false,
    unavailable_reason: "program_not_supported",
    takes_effect: false,
    version: null,
    url: null,
    download_bytes: null,
    install_bytes: null,
    job: null,
    last: null,
  },
  ...over,
});

const report = (rows: ProgramInfo[], platform = "linux-x64"): ProgramsReport => ({
  platform,
  programs_dir: "/home/me/.localcut/programs",
  programs_bytes: 0,
  disk_free_bytes: 20_000 * MB,
  bin_dir: "/home/me/.localcut/bin",
  models_dir: "/home/me/.localcut/models",
  programs: rows,
});

const exportFails: ReadinessRow = {
  kind: "export",
  model: null,
  backend: null,
  verdict: "will_fail",
  reason: "no_ffmpeg",
  data: {},
  fix: { type: "setup_program", program: "ffmpeg", size_bytes: 137_034_436 },
};

let actions: {
  setupProgram: ReturnType<typeof vi.fn>;
  cancelProgramSetup: ReturnType<typeof vi.fn>;
  removeProgram: ReturnType<typeof vi.fn>;
  openSettings: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  actions = {
    setupProgram: vi.fn(async () => null),
    cancelProgramSetup: vi.fn(async () => null),
    removeProgram: vi.fn(async () => null),
    openSettings: vi.fn(),
  };
  useApp.setState({
    readiness: [exportFails],
    system: null,
    refreshPrograms: vi.fn(async () => {}),
    refreshReadiness: vi.fn(async () => {}),
    ...actions,
  } as never);
});

function mount(
  program: ProgramInfo,
  options: { context?: "settings" | "wizard"; host?: string | null; platform?: string } = {},
) {
  return render(
    <ProgramWell
      program={program}
      report={report([program], options.platform)}
      context={options.context ?? "settings"}
      host={options.host ?? null}
    />,
  );
}

/** The well itself. Its "Do it myself" disclosure is a group too, which is
 * why this asks by the well's own name. */
const well = () => screen.getByRole("group", { name: /^(FFmpeg|Ollama|ComfyUI), / });

const gearName = t("programs.menu.aria", { name: "FFmpeg" });

describe("a program that is not there", () => {
  it("says so, and offers to set it up at the download's size", () => {
    mount(ffmpeg());
    expect(well()).toHaveTextContent("Not found on this computer.");
    const button = screen.getByRole("button", { name: /Set up FFmpeg/ });
    expect(button).toHaveTextContent("131 MB");
    fireEvent.click(button);
    expect(actions.setupProgram).toHaveBeenCalledWith("ffmpeg");
  });

  it("is a problem in Settings: a red edge, and the stages it costs", () => {
    mount(ffmpeg(), { context: "settings" });
    expect(well().className).toContain("edge-fail");
    expect(within(well()).getByText("Final video")).toBeInTheDocument();
  });

  it("is a to-do on the first run: no edge and no stage rows", () => {
    mount(ffmpeg(), { context: "wizard" });
    expect(well().className).not.toContain("edge-fail");
    expect(within(well()).queryByText("Final video")).toBeNull();
  });

  it("says what LocalCut cannot set up for you yet, and how to do it by hand", () => {
    mount(ollama());
    expect(screen.queryByRole("button", { name: /Set up Ollama/ })).toBeNull();
    expect(well()).toHaveTextContent(
      t("programs.unavailable.program_not_supported", { name: "Ollama" }),
    );
    expect(within(well()).getByText("ollama pull qwen3:14b")).toBeInTheDocument();
  });
});

describe("a setup that is running", () => {
  const running = ffmpeg({
    setup: {
      ...ffmpeg().setup,
      job: {
        id: "j1",
        phase: "downloading",
        done: 68 * MB,
        total: 137_034_436,
        bytes_per_s: 2 * MB,
      },
    },
  });

  it("shows the phase, the bytes, the time left and a bar", () => {
    mount(running);
    expect(well().className).toContain("edge-busy");
    expect(well()).toHaveTextContent("Downloading FFmpeg");
    expect(well()).toHaveTextContent("68 MB of 131 MB, less than a minute");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "52");
  });

  it("can be stopped", () => {
    mount(running);
    fireEvent.click(screen.getByRole("button", { name: t("common.cancel") }));
    expect(actions.cancelProgramSetup).toHaveBeenCalledWith("ffmpeg");
  });

  it("cannot be stopped once it is moving into place", () => {
    mount(
      ffmpeg({
        setup: {
          ...ffmpeg().setup,
          job: { id: "j1", phase: "installing", done: 0, total: 0, bytes_per_s: null },
        },
      }),
    );
    expect(well()).toHaveTextContent("Moving FFmpeg into place");
    expect(screen.getByRole("button", { name: t("common.cancel") })).toBeDisabled();
  });
});

describe("a setup that failed", () => {
  const failed = ffmpeg({
    setup: {
      ...ffmpeg().setup,
      last: { job: "j1", outcome: "failed", reason: "checksum_mismatch", error: "sha" },
    },
  });

  it("says what happened, then what to do, then offers to try again", () => {
    mount(failed, { context: "wizard" });
    // Red even on the first run: this is the one thing that did fail.
    expect(well().className).toContain("edge-fail");
    expect(well()).toHaveTextContent(t("programs.failures.checksum_mismatch"));
    expect(well()).toHaveTextContent(/Nothing from it was kept or run/);
    fireEvent.click(screen.getByRole("button", { name: `${t("programs.setup.retry")} 131 MB` }));
    expect(actions.setupProgram).toHaveBeenCalledWith("ffmpeg");
  });

  it("opens the steps for doing it by hand", () => {
    mount(failed);
    expect(well().querySelector("details")).toHaveAttribute("open");
  });

  it("stops talking about the failure once the program works", () => {
    mount({ ...failed, state: "ready", problem: null, checks: { draws_text: true } });
    expect(well()).not.toHaveTextContent(/Setup stopped/);
  });
});

describe("a program that works", () => {
  const managed = ffmpeg({
    state: "ready",
    problem: null,
    source: "managed",
    location: "/home/me/.localcut/programs/ffmpeg/ffmpeg",
    version: "8.1.3",
    checks: { draws_text: true },
    managed: {
      location: "/home/me/.localcut/programs/ffmpeg",
      bytes: 283_956_127,
      version: "8.1.3",
      current: true,
      in_use: true,
    },
  });

  it("goes quiet: its version, where it came from, and what it checked", () => {
    mount(managed, { context: "wizard" });
    expect(well().className).toContain("quiet");
    expect(well()).toHaveTextContent("8.1.3");
    expect(well()).toHaveTextContent("Set up by LocalCut. Captions and titles render.");
    expect(within(well()).getByText(t("programs.states.ready"))).toBeInTheDocument();
  });

  it("lets Settings remove LocalCut's copy, after saying what that means", async () => {
    mount(managed, { context: "settings" });
    fireEvent.click(screen.getByRole("button", { name: gearName }));
    fireEvent.click(screen.getByRole("menuitem", { name: t("programs.menu.remove") }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/never an install of your own/);
    fireEvent.click(within(dialog).getByRole("button", { name: /Remove 271 MB/ }));
    await vi.waitFor(() => expect(actions.removeProgram).toHaveBeenCalledWith("ffmpeg"));
  });

  it("closes its menu on Escape and leaves the screen under it open", () => {
    // Settings closes on Escape from a window listener of its own.
    const closeSettings = vi.fn();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && closeSettings();
    window.addEventListener("keydown", onKey);
    mount(managed, { context: "settings" });
    fireEvent.click(screen.getByRole("button", { name: gearName }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(closeSettings).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onKey);
  });

  it("names your own Ollama by its address", () => {
    mount(
      ollama({
        state: "ready",
        problem: null,
        version: "0.35.0",
        checks: { server: "ollama", model: "qwen3:14b", model_present: true },
      }),
    );
    expect(well()).toHaveTextContent("Your own Ollama, at 127.0.0.1:11434.");
  });

  it("asks for the script model when the server lacks it", () => {
    mount(
      ollama({
        state: "ready",
        problem: null,
        checks: { server: "ollama", model: "qwen3:14b", model_present: false },
      }),
    );
    expect(well()).toHaveTextContent(/doesn't have qwen3:14b/);
    expect(within(well()).getByText("ollama pull qwen3:14b")).toBeInTheDocument();
  });

  it("offers LocalCut's copy in place of one that cannot draw text", () => {
    mount(ffmpeg({ state: "ready", problem: null, checks: { draws_text: false } }));
    expect(well()).toHaveTextContent(/can't draw captions or titles/);
    expect(screen.getByRole("button", { name: /Set up FFmpeg/ })).toBeInTheDocument();
  });
});

describe("a paired engine", () => {
  it("is that machine's program, set up there, with its system's steps", () => {
    // A Linux GPU box seen from a Windows desktop: the steps are apt's.
    mount(ffmpeg(), { host: "gpu-box.local", platform: "linux-x64" });
    expect(well()).toHaveTextContent("Not found on gpu-box.local.");
    expect(screen.getByRole("button", { name: /Set up on gpu-box\.local/ })).toBeInTheDocument();
    expect(well()).toHaveTextContent("Do it myself, on gpu-box.local");
    expect(within(well()).getByText("sudo apt install ffmpeg")).toBeInTheDocument();
    expect(within(well()).queryByText(/winget/)).toBeNull();
  });

  it("gives a Windows box the Windows steps", () => {
    mount(ffmpeg(), { host: "render-pc", platform: "windows-x64" });
    expect(within(well()).getByText("winget install Gyan.FFmpeg")).toBeInTheDocument();
    expect(well()).toHaveTextContent("Restart the engine on render-pc");
  });
});
