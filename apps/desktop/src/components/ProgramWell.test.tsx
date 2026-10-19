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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProgramInfo, ProgramsReport, ReadinessRow, ServerReason } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { formatSize } from "../lib/size";
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
  pullModel: ReturnType<typeof vi.fn>;
  startProgram: ReturnType<typeof vi.fn>;
  stopProgram: ReturnType<typeof vi.fn>;
  openSettings: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  actions = {
    setupProgram: vi.fn(async () => null),
    cancelProgramSetup: vi.fn(async () => null),
    removeProgram: vi.fn(async () => null),
    pullModel: vi.fn(async () => null),
    startProgram: vi.fn(async () => null),
    stopProgram: vi.fn(async () => null),
    openSettings: vi.fn(),
  };
  useApp.setState({
    readiness: [exportFails],
    system: null,
    programs: null,
    setupSpeeds: {},
    networkSpeed: null,
    models: [],
    programQueue: [],
    lineMeter: null,
    programStepsFocus: null,
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
    expect(well().querySelector("details")).not.toHaveAttribute("open");
  });

  it("opens its steps when a readiness fix sent someone here for them", () => {
    // The render gate's "Show the steps", for a program LocalCut cannot
    // set up on this machine.
    useApp.setState({ programStepsFocus: "ollama" } as never);
    mount(ollama());
    expect(well().querySelector("details")).toHaveAttribute("open");
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

  it("shows the phase, the bytes, the speed, the time left and a bar", () => {
    mount(running);
    expect(well().className).toContain("edge-busy");
    expect(well()).toHaveTextContent("Downloading FFmpeg");
    expect(well()).toHaveTextContent("68 MB of 131 MB, 2.0 MB/s, less than a minute left");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "52");
  });

  it("says the speed averaged over the last minute, not the engine's last reading", () => {
    // A minute at 2 MB/s, then a reading of 50 KB/s from a burst-and-wait
    // CDN: the engine's last five seconds, not how fast this is going.
    useApp.setState({
      setupSpeeds: { ffmpeg: { phase: "downloading", sum: 120 * MB, weight: 60, at: 0 } },
    } as never);
    mount(
      ffmpeg({
        setup: {
          ...ffmpeg().setup,
          job: { ...running.setup.job!, bytes_per_s: 50 * 1024 },
        },
      }),
    );
    expect(well()).toHaveTextContent("68 MB of 131 MB, 2.0 MB/s, less than a minute left");
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

describe("LocalCut's own Ollama", () => {
  /** Ollama as an engine with its pin reports it. */
  const settable = (over: Partial<ProgramInfo> = {}): ProgramInfo =>
    ollama({
      setup: {
        available: true,
        unavailable_reason: null,
        takes_effect: true,
        version: "0.40.4",
        url: "https://example.test/ollama.tar.zst",
        download_bytes: 1436 * MB,
        install_bytes: 2151 * MB,
        pull: { model: "qwen3:14b", bytes: 9216 * MB },
        job: null,
        last: null,
      },
      ...over,
    });
  const copy = (
    state: "stopped" | "starting" | "running" | "crashed",
    reason: ServerReason | null = null,
  ): ProgramInfo["managed"] => ({
    location: "/home/me/.localcut/programs/ollama",
    bytes: 2151 * MB,
    version: "0.40.4",
    current: true,
    in_use: state === "running" || state === "starting",
    server: {
      state,
      reason,
      error: null,
      pid: state === "running" ? 4242 : null,
      url: "http://127.0.0.1:11434",
      restarts: 0,
      log: "/home/me/.localcut/logs/ollama.log",
    },
  });

  it("sets up with the program and the model counted together", () => {
    mount(settable());
    const button = screen.getByRole("button", { name: /Set up Ollama/ });
    expect(button).toHaveTextContent(formatSize((1436 + 9216) * MB));
    fireEvent.click(button);
    expect(actions.setupProgram).toHaveBeenCalledWith("ollama");
  });

  it("says how long it has left in all, the model's pull included", () => {
    mount(
      settable({
        setup: {
          ...settable().setup,
          job: {
            id: "j",
            phase: "downloading",
            done: 300 * MB,
            total: 1436 * MB,
            bytes_per_s: 4 * MB,
          },
        },
      }),
    );
    // 1136 MB of Ollama and 9 GB of qwen3:14b at 4 MB/s: 43 minutes.
    expect(well()).toHaveTextContent("300 MB of 1.4 GB, 4.0 MB/s, about 45 min left in all");
  });

  it("takes no longer than everything sharing the line with it would", () => {
    // Beside a 10 GB model download Ollama gets 0.1 MB/s, which on its own
    // reads as most of a day. The model ends first and hands it the line:
    // 20 GB in all at the line's 3.5 MB/s is 98 minutes.
    useApp.setState({
      models: [
        {
          id: "ltx-video-0.9-i2v",
          size_bytes: 10240 * MB,
          downloaded: false,
          downloading: true,
          progress: { done: 0, total: 10240 * MB },
        },
      ],
      lineMeter: { bytes: 3.5 * MB * 60, seconds: 60, at: Date.now() },
    } as never);
    mount(
      settable({
        setup: {
          ...settable().setup,
          job: {
            id: "j",
            phase: "downloading",
            done: 300 * MB,
            total: 1436 * MB,
            bytes_per_s: 0.1 * MB,
          },
        },
      }),
    );
    expect(well()).toHaveTextContent("about 1 h 40 min left in all");
  });

  it("keeps counting the pull down while its copy starts", () => {
    useApp.setState({ networkSpeed: 4 * MB } as never);
    mount(
      settable({
        setup: {
          ...settable().setup,
          job: { id: "j", phase: "starting", done: 0, total: 0, bytes_per_s: null },
        },
      }),
    );
    expect(well()).toHaveTextContent("Starting Ollama");
    expect(well()).toHaveTextContent("about 40 min left in all");
  });

  it("says how long it takes once the setup before it is done", () => {
    useApp.setState({ networkSpeed: 4 * MB } as never);
    render(
      <ProgramWell
        program={settable()}
        report={report([settable()])}
        context="wizard"
        host={null}
        queuedBehind="ffmpeg"
      />,
    );
    expect(well()).toHaveTextContent(
      t("programs.queuedFor", { name: "FFmpeg", time: "about 45 min" }),
    );
  });

  it("names the model while it pulls it", () => {
    mount(
      settable({
        setup: {
          ...settable().setup,
          job: { id: "j", phase: "pulling", done: 512 * MB, total: 1024 * MB, bytes_per_s: null },
        },
      }),
    );
    expect(well()).toHaveTextContent("Downloading qwen3:14b");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  });

  it("pulls the model into the user's own Ollama when it lacks it", () => {
    mount(
      settable({
        state: "ready",
        problem: null,
        checks: { server: "ollama", model: "qwen3:14b", model_present: false },
        setup: { ...settable().setup, pull: null },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Get qwen3:14b" }));
    expect(actions.pullModel).toHaveBeenCalledWith("ollama", "qwen3:14b");
    expect(actions.setupProgram).not.toHaveBeenCalled();
  });

  it("is quiet while it runs, and Settings can stop it", () => {
    mount(
      settable({
        state: "ready",
        problem: null,
        source: "managed",
        version: "0.40.4",
        checks: { server: "ollama", model: "qwen3:14b", model_present: true },
        managed: copy("running"),
        setup: { ...settable().setup, pull: null },
      }),
    );
    expect(well()).toHaveTextContent("Set up by LocalCut.");
    fireEvent.click(screen.getByRole("button", { name: t("programs.menu.aria", { name: "Ollama" }) }));
    fireEvent.click(screen.getByRole("menuitem", { name: t("programs.menu.stop") }));
    expect(actions.stopProgram).toHaveBeenCalledWith("ollama");
  });

  it("says why a stopped or crashed copy is not running, and starts it again", () => {
    mount(settable({ managed: copy("crashed", "exited") }));
    expect(well()).toHaveTextContent(
      "LocalCut's copy kept stopping, so LocalCut stopped restarting it.",
    );
    expect(screen.queryByRole("button", { name: /Set up Ollama/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(actions.startProgram).toHaveBeenCalledWith("ollama");
  });

  it("leaves the user's own Ollama in charge, and says LocalCut's copy waits", () => {
    mount(
      settable({
        state: "ready",
        problem: null,
        version: "0.22.0",
        checks: { server: "ollama", model: "qwen3:14b", model_present: true },
        managed: copy("stopped", "own_server"),
      }),
    );
    expect(well()).toHaveTextContent("Your own Ollama, at 127.0.0.1:11434.");
    expect(well()).toHaveTextContent("stays stopped while yours runs");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
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

describe("ComfyUI, built for the machine's graphics card", () => {
  const GB = 2 ** 30;
  const comfyui = (over: Partial<ProgramInfo["setup"]> = {}): ProgramInfo => ({
    id: "comfyui",
    state: "missing",
    problem: "unreachable",
    source: "default",
    location: "http://127.0.0.1:8188",
    setting: "LOCALCUT_COMFYUI_URL",
    version: null,
    checks: {},
    managed: null,
    setup: {
      available: true,
      unavailable_reason: null,
      takes_effect: true,
      version: "0.40.0",
      url: "https://example.test/ComfyUI_windows_portable_nvidia.7z",
      download_bytes: 2_010_504_119,
      install_bytes: 4_421_748_361,
      gpu: "nvidia",
      build: null,
      builds: [
        { build: "older_drivers", download_bytes: 1_902_221_251, install_bytes: 5_596_292_364 },
      ],
      job: null,
      last: null,
      ...over,
    },
  });
  const notUsable = {
    job: "j9",
    outcome: "failed" as const,
    reason: "gpu_not_usable" as const,
    error: "PyTorch finds no cuda device",
    build: null,
  };
  const withCard = (driver: string | null) =>
    useApp.setState({
      system: {
        hardware: {
          primary_gpu: {
            vendor: "nvidia",
            name: "NVIDIA GeForce RTX 3080 Laptop GPU",
            vram_gb: 8,
            backend: "cuda",
            driver_version: driver,
          },
          gpus: [],
        },
      },
    } as never);

  it("says which vendor's build it picks and what it downloads", () => {
    mount(comfyui(), { context: "wizard", platform: "windows-x64" });
    expect(well()).toHaveTextContent(
      "Not found on this computer. LocalCut picks the build for NVIDIA graphics cards.",
    );
    const button = screen.getByRole("button", { name: /Set up ComfyUI/ });
    expect(button).toHaveTextContent("1.9 GB");
    fireEvent.click(button);
    expect(actions.setupProgram).toHaveBeenCalledWith("comfyui");
  });

  it("says when the card's driver got it the build for older drivers", () => {
    mount(comfyui({ build: "older_drivers", builds: [] }), { platform: "windows-x64" });
    expect(well()).toHaveTextContent(
      "LocalCut picks the build for NVIDIA graphics cards on older drivers.",
    );
  });

  it("offers the build for older drivers when PyTorch could not use the card", async () => {
    withCard("551.86");
    mount(comfyui({ last: notUsable }), { context: "wizard", platform: "windows-x64" });
    expect(well().className).toContain("edge-fail");
    expect(well()).toHaveTextContent("Setup stopped: PyTorch couldn't use your graphics card.");
    expect(well()).toHaveTextContent(
      "Your NVIDIA driver is 551.86. Update it, or use the build made for older drivers.",
    );
    expect(screen.getByRole("link", { name: /NVIDIA's drivers/ })).toHaveAttribute(
      "href",
      expect.stringContaining("nvidia.com"),
    );
    const older = screen.getByRole("button", { name: /Use the build for older drivers/ });
    expect(older).toHaveTextContent("1.8 GB");
    fireEvent.click(older);
    expect(actions.setupProgram).toHaveBeenCalledWith("comfyui", "older_drivers");
    const again = screen.getByRole("button", { name: /Try again/ });
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    expect(actions.setupProgram).toHaveBeenLastCalledWith("comfyui");
  });

  it("does not offer the build that just failed, or the usual one, again", () => {
    withCard(null);
    mount(
      comfyui({
        build: "older_drivers",
        builds: [{ build: null, download_bytes: 2 * GB, install_bytes: 4 * GB }],
        last: { ...notUsable, build: "older_drivers" },
      }),
      { platform: "windows-x64" },
    );
    expect(screen.queryByRole("button", { name: /Use the build/ })).toBeNull();
    expect(well()).toHaveTextContent(t("programs.advice.gpu_not_usable", { name: "ComfyUI" }));
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("picks the processor's build on Linux where there is no card it has a build for", () => {
    mount(comfyui({ gpu: null, build: "cpu", builds: [] }), {
      context: "wizard",
      platform: "linux-x64",
    });
    expect(well()).toHaveTextContent(t("programs.build.picksCpu"));
    expect(screen.getByRole("button", { name: /Set up ComfyUI/ })).toHaveTextContent("1.9 GB");
  });

  it("offers the processor's build once the card's own could not use it", () => {
    useApp.setState({
      system: {
        hardware: {
          primary_gpu: { vendor: "amd", name: "Radeon RX 7800 XT", vram_gb: 16, backend: "rocm" },
          gpus: [],
        },
      },
    } as never);
    mount(
      comfyui({
        gpu: "amd",
        builds: [{ build: "cpu", download_bytes: 1_015_000_000, install_bytes: 3 * GB }],
        last: notUsable,
      }),
      { platform: "linux-x64" },
    );
    expect(well()).toHaveTextContent(t("programs.build.cpuAdvice"));
    // An AMD card's driver is not NVIDIA's.
    expect(screen.queryByRole("link", { name: /NVIDIA's drivers/ })).toBeNull();
    const cpu = screen.getByRole("button", { name: /Use the processor instead/ });
    expect(cpu).toHaveTextContent("968 MB");
    fireEvent.click(cpu);
    expect(actions.setupProgram).toHaveBeenCalledWith("comfyui", "cpu");
  });

  it("says when LocalCut's copy runs on the processor", () => {
    mount(
      {
        ...comfyui({ gpu: null, build: "cpu", builds: [] }),
        state: "ready",
        problem: null,
        source: "managed",
        version: "0.40.0",
        managed: {
          location: "/home/me/.localcut/programs/comfyui",
          bytes: 3 * GB,
          version: "0.40.0",
          build: "cpu",
          current: true,
          in_use: true,
        },
      },
      { platform: "linux-x64" },
    );
    expect(well()).toHaveTextContent(t("programs.build.onCpu"));
  });

  it("counts the unpack down, which takes minutes of its own", () => {
    mount(
      comfyui({
        job: {
          id: "j1",
          phase: "unpacking",
          done: 1 * GB,
          total: 4_421_748_361,
          bytes_per_s: 20 * MB,
          build: null,
        },
      }),
      { platform: "windows-x64" },
    );
    expect(well()).toHaveTextContent("Unpacking ComfyUI");
    expect(well()).toHaveTextContent("1.0 GB of 4.1 GB, 20 MB/s, about 3 min left");
  });
});
