/**
 * The missing-model preflight: the facts strip, and the gate that holds an
 * explicit render click.
 *
 * Two rules carry the design and so are pinned hardest here. First, a
 * warning is not a block: "Render anyway" always exists and always
 * proceeds. Second, suppression silences the DIALOG, never the banner —
 * and it covers exactly the gap set it was dismissed for, so fixing one
 * model while losing another warns again rather than staying quiet.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadinessRow } from "../api/types";
import { t } from "../i18n";
import { ReadinessBanner, useReadinessGuard } from "./Readiness";
import { useApp } from "../store";

const musicGap: ReadinessRow = {
  kind: "music",
  model: null,
  backend: "mock",
  verdict: "placeholder",
  reason: "no_model_installed",
  data: { task: "music.gen" },
  fix: { type: "download", model_id: "ace-step-v1-3.5b", size_bytes: 7_700_000_000 },
};

const clipDegraded: ReadinessRow = {
  kind: "clip",
  model: null,
  backend: "ffmpeg",
  verdict: "degraded",
  reason: "still_clip_tier",
  data: { task: "video.i2v" },
  fix: null,
};

const exportFails: ReadinessRow = {
  kind: "export",
  model: null,
  backend: null,
  verdict: "will_fail",
  reason: "no_ffmpeg",
  data: {},
  fix: { type: "setup_program", program: "ffmpeg", size_bytes: 170_611_883 },
};

/** A store with a readiness report and a client whose readiness calls
 * answer `rows`. The gate fetches fresh at the click, so the client is
 * what it actually reads — the slices only feed the banner. */
function seed(rows: ReadinessRow[], overrides: Record<string, unknown> = {}) {
  useApp.setState({
    client: {
      readiness: vi.fn().mockResolvedValue({ rows }),
      projectReadiness: vi.fn().mockResolvedValue({ rows }),
    },
    currentProject: { id: "p1", title: "t", mode: "advanced", approvals: [] },
    projectReadiness: rows,
    readiness: rows,
    models: [],
    warnMissingModels: true,
    ...overrides,
  } as never);
}

// Every mount gets its own scope unless one is named. `sessionReadinessSkips`
// is module state the store never exposes a reset for, so a shared default
// key let one test's "Render anyway" satisfy the next test's assertion —
// the master-switch test passed with the switch check deleted.
let harnesses = 0;
function Harness({
  onRun,
  scopeKey,
  kinds,
}: {
  onRun: () => void;
  scopeKey?: string;
  kinds?: string[];
}) {
  const [key] = useState(() => scopeKey ?? `harness-${++harnesses}`);
  const { guard, dialog } = useReadinessGuard(key);
  return (
    <>
      <button onClick={() => void guard(onRun, kinds)}>Render</button>
      {dialog}
    </>
  );
}

const renderAnyway = () => screen.queryByRole("button", { name: /render anyway/i });

beforeEach(() => {
  localStorage.clear();
  useApp.setState({
    client: null,
    currentProject: null,
    projectReadiness: null,
    readiness: null,
    warnMissingModels: true,
    settingsOpen: false,
    settingsTab: "general",
    defaultPickerFocus: null,
  } as never);
});

afterEach(() => {
  localStorage.clear();
});

describe("the readiness banner", () => {
  it("names the consequence of a missing music model, not just the model", () => {
    seed([musicGap]);
    render(<ReadinessBanner />);
    // The point of the whole feature: silence in the finished video is the
    // fact worth saying, and it is the one nothing said before. Phrased
    // without the word "music" — the stage label already says it, and
    // "Music — no music" was the repetition the copy pass removed.
    expect(screen.getByRole("status").textContent).toMatch(/none in the finished video/i);
  });

  it("states the still-clip tier — the fact it is easiest to miss", () => {
    // The banner is facts, so a degraded row belongs here even though it
    // must never reach the dialog: "your scenes will be stills" is the one
    // thing a machine with no video model needs told.
    seed([clipDegraded]);
    render(<ReadinessBanner />);
    expect(screen.getByRole("status").textContent).toMatch(/still images/i);
  });

  it("says one stopped server once, however many stages it costs", () => {
    // The shipped banner built every line as cause + consequence, so a
    // single dead ComfyUI stated its cause sentence three times in a
    // four-line box.
    const down = (
      kind: string,
      task: string,
      verdict: ReadinessRow["verdict"],
    ): ReadinessRow => ({
      kind,
      model: null,
      backend: "mock",
      verdict,
      reason: "comfyui_down",
      data: { task },
      fix: null,
    });
    seed([
      down("keyframe", "image.gen", "placeholder"),
      down("clip", "video.i2v", "degraded"),
      down("music", "music.gen", "placeholder"),
    ]);
    render(<ReadinessBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text.match(/program that draws images and video/g)).toHaveLength(1);
    // Said once, and then priced per stage - which is the half the old
    // lines left out entirely.
    for (const stage of ["Keyframes", "Video clips", "Music"]) {
      expect(text).toContain(stage);
    }
    expect(text).toMatch(/still images/);
    expect(text).toMatch(/none in the finished video/);
  });

  it("names an assembly stage in catalog words, not as its wire id", () => {
    // An export row carries no task, so its label falls through to the
    // kind — which must land on the aux catalog's "Final video", the word
    // the rest of the app uses. The raw id "export" leaking into a list of
    // catalog labels is the exact drift the i18n rule exists to stop.
    seed([exportFails]);
    render(<ReadinessBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Final video");
    expect(text).not.toMatch(/\bexport\b/);
  });

  it("calls the stage a missing FFmpeg takes down the final video, once", () => {
    // Timeline and export fail together and are one stage to the person
    // reading: "Final video" is the name the rest of the app uses for it.
    seed([{ ...exportFails, kind: "timeline" }, exportFails]);
    render(<ReadinessBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text.match(/Final video/g)).toHaveLength(1);
    expect(text).not.toContain("Timeline");
  });

  it("reads worst-first, so stopping after one well is still the worst news", () => {
    // The whole argument of the panel: a reader who takes in one group has
    // taken in the most damaging one. A degraded cause listed first would
    // make the calm case the headline while a job that dies sits below it.
    seed([clipDegraded, exportFails]);
    const { container } = render(<ReadinessBanner />);
    const causes = [...container.querySelectorAll(".well .whead")].map(
      (node) => node.textContent ?? "",
    );
    expect(causes).toHaveLength(2);
    expect(causes[0]).toMatch(/ffmpeg/i);
    expect(causes[1]).toMatch(/No video model/);
  });

  it("lights each row by verdict, and the well by the worst row in it", () => {
    // Severity travels as a dot per row and an edge per well, so the panel
    // ranks itself before a word of it is read.
    seed([clipDegraded, exportFails]);
    const { container } = render(<ReadinessBanner />);
    const wells = [...container.querySelectorAll(".well")];
    expect(wells[0].className).toContain("edge-fail");
    expect(wells[0].querySelector(".pdot")?.className).toContain("fail");
    // A degraded-only group stays amber — the still-clip tier renders
    // something real, and calling it red would spend the alarm on it.
    expect(wells[1].className).toContain("edge-deg");
    expect(wells[1].querySelector(".pdot")?.className).toContain("deg");
    // And the strip repeats the worst light of all of them.
    expect(screen.getByRole("status").className).toContain("worst-fail");
  });

  it("totals the damage only when there is more than one well to total", () => {
    // With one group the well already is the summary; a chip strip
    // repeating it is furniture.
    seed([clipDegraded]);
    const single = render(<ReadinessBanner />);
    expect(single.container.querySelector(".sev-chip")).toBeNull();
    single.unmount();

    seed([clipDegraded, exportFails]);
    const many = render(<ReadinessBanner />);
    const chips = [...many.container.querySelectorAll(".sev-chip")].map(
      (node) => node.textContent ?? "",
    );
    // Worst first here too, and counted over stages rather than causes.
    expect(chips[0]).toMatch(/1\s*fail/);
    expect(chips[1]).toMatch(/1\s*lower quality/);
  });

  it("says an image model is missing once, not once per kind that needs it", () => {
    // Keyframes and thumbnails both render from image.gen — true twice,
    // worth saying once.
    const thumbnailGap: ReadinessRow = {
      ...musicGap,
      kind: "thumbnail",
      data: { task: "image.gen" },
      fix: { type: "download", model_id: "sdxl-base-1.0", size_bytes: 6_938_078_334 },
    };
    const keyframeGap: ReadinessRow = { ...thumbnailGap, kind: "keyframe" };
    seed([keyframeGap, thumbnailGap]);
    render(<ReadinessBanner />);
    const lines = screen.getByRole("status").textContent ?? "";
    expect(lines.match(/No model is installed for/g)).toHaveLength(1);
  });

  it("offers the download when exactly one gap has one", async () => {
    const startDownload = vi.fn();
    seed([musicGap], { startDownload });
    render(<ReadinessBanner />);
    await userEvent.click(screen.getByRole("button", { name: /get ace-step/i }));
    expect(startDownload).toHaveBeenCalledWith("ace-step-v1-3.5b");
  });
});

describe("the render gate", () => {
  it("runs straight through when nothing is missing", async () => {
    const run = vi.fn();
    seed([]);
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("holds the click behind the dialog, then proceeds on Render anyway", async () => {
    const run = vi.fn();
    seed([musicGap]);
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    expect(run).not.toHaveBeenCalled();
    await userEvent.click(renderAnyway()!);
    await waitFor(() => expect(run).toHaveBeenCalled());
  });

  it("never warns about a degraded row alone", async () => {
    // The still-clip tier is how a low-VRAM machine normally works (doc 04
    // tiers S/A). A dialog in front of the normal path teaches people to
    // click through warnings.
    const run = vi.fn();
    seed([clipDegraded]);
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("starts one render for two fast clicks", async () => {
    // The preflight is a network round trip that probes Ollama and
    // ComfyUI. Without an in-flight lock the second click during that
    // second starts a second render — on the most expensive button here.
    const run = vi.fn();
    let release: (value: { rows: never[] }) => void = () => {};
    seed([], {
      client: {
        readiness: vi.fn(() => new Promise((resolve) => (release = resolve))),
        projectReadiness: vi.fn(() => new Promise((resolve) => (release = resolve))),
      },
    });
    render(<Harness onRun={run} />);
    const button = screen.getByRole("button", { name: "Render" });
    await userEvent.click(button);
    await userEvent.click(button);
    release({ rows: [] });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("holds one dialog for two clicks, and drops the render when dismissed", async () => {
    const run = vi.fn();
    seed([musicGap]);
    // Its own scope: a session dismissal from an earlier test in this file
    // would otherwise let the click straight through and pass this
    // vacuously (sessionReadinessSkips is module state, by design).
    render(<Harness onRun={run} scopeKey="dialog-once" />);
    const button = screen.getByRole("button", { name: "Render" });
    await userEvent.click(button);
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    await userEvent.click(button); // ignored while the dialog is up
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);

    // Escape dismisses (Modal owns it) and the held render does NOT run —
    // dismissing the warning is a decision not to start, not a silent start.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(run).not.toHaveBeenCalled();

    // And the guard is usable again afterwards.
    await userEvent.click(button);
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
  });

  it("does not warn while the master switch is off", async () => {
    const run = vi.fn();
    seed([musicGap], { warnMissingModels: false });
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("does not warn about a model whose bytes are already moving", async () => {
    // First run hands over mid-download by design, and the engine calls a
    // half-downloaded model missing (it counts completed files). Warning
    // there interrupts the setup that is already fixing it.
    const run = vi.fn();
    seed([musicGap], {
      models: [{ id: "ace-step-v1-3.5b", downloading: true, downloaded: false }],
    });
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("keeps two differently-scoped dismissals on one surface apart", async () => {
    // Home asks about a whole video from one control and a single tool
    // kind from another, both under scope "home". With one dismissal
    // between them each evicted the other and the dialog never stopped.
    const run = vi.fn();
    seed([musicGap, exportFails]);
    const music = render(<Harness onRun={run} scopeKey="home" kinds={["music"]} />);
    await userEvent.click(music.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    await userEvent.click(renderAnyway()!);
    await waitFor(() => expect(run).toHaveBeenCalled());
    music.unmount();

    // A different question under the same scope still gets asked...
    const everything = render(<Harness onRun={vi.fn()} scopeKey="home" />);
    await userEvent.click(everything.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    await userEvent.click(renderAnyway()!);
    everything.unmount();

    // ...and answering it does not un-dismiss the first one.
    const again = vi.fn();
    const music2 = render(<Harness onRun={again} scopeKey="home" kinds={["music"]} />);
    await userEvent.click(music2.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(again).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("proceeds when the engine cannot report — a warning must not become a block", async () => {
    const run = vi.fn();
    seed([musicGap], {
      client: {
        readiness: vi.fn().mockRejectedValue(new Error("no engine")),
        projectReadiness: vi.fn().mockRejectedValue(new Error("no engine")),
      },
    });
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
  });
});

describe("suppression", () => {
  // Session dismissals live for the window, so each test gets its own
  // scope key rather than leaking into the next one.
  let keys = 0;
  const nextKey = () => `scope-${++keys}`;

  /** Mount a fresh guard on `key`, click Render, pick a suppression scope
   * (the default is "this session"), proceed, and hand back the run spy. */
  async function dismissOnce(key: string, scope?: "project" | "always") {
    const run = vi.fn();
    const view = render(<Harness onRun={run} scopeKey={key} />);
    await userEvent.click(view.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    if (scope) {
      const label = scope === "always" ? /^always$/i : /this project/i;
      await userEvent.click(screen.getByRole("button", { name: label }));
    }
    await userEvent.click(renderAnyway()!);
    await waitFor(() => expect(run).toHaveBeenCalled());
    view.unmount();
    return run;
  }

  it("says which scope is picked, not only by colour", async () => {
    seed([musicGap]);
    render(<Harness onRun={vi.fn()} scopeKey={nextKey()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    const scope = (name: RegExp) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(scope(/this session/i)).toBe("true");
    expect(scope(/this project/i)).toBe("false");
    expect(scope(/^always$/i)).toBe("false");

    await userEvent.click(screen.getByRole("button", { name: /this project/i }));
    expect(scope(/this project/i)).toBe("true");
    expect(scope(/this session/i)).toBe("false");
  });

  it("stops warning for the same gaps after Render anyway", async () => {
    const key = nextKey();
    seed([musicGap]);
    await dismissOnce(key);
    const run = vi.fn();
    const view = render(<Harness onRun={run} scopeKey={key} />);
    await userEvent.click(view.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("warns again when the gap set changes", async () => {
    const key = nextKey();
    seed([musicGap]);
    await dismissOnce(key);
    // Music fixed, ffmpeg since lost: a different problem, so the
    // dismissal of the old one must not cover it.
    seed([exportFails]);
    const run = vi.fn();
    const view = render(<Harness onRun={run} scopeKey={key} />);
    await userEvent.click(view.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    expect(run).not.toHaveBeenCalled();
  });

  it("persists a per-project dismissal and reads it back", async () => {
    const key = nextKey();
    seed([musicGap]);
    await dismissOnce(key, "project");
    expect(localStorage.getItem("localcut.readinessSkip.v1")).toContain(key);

    // Read back through the same door a later click uses. The session map
    // must not be what satisfies this: a project dismissal that only lived
    // in memory would come back on the next launch, and nothing would say
    // so. Clearing the stored entry is what has to bring the dialog back.
    const run = vi.fn();
    const view = render(<Harness onRun={run} scopeKey={key} />);
    await userEvent.click(view.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
    view.unmount();

    localStorage.removeItem("localcut.readinessSkip.v1");
    const after = vi.fn();
    const revisit = render(<Harness onRun={after} scopeKey={key} />);
    await userEvent.click(revisit.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    expect(after).not.toHaveBeenCalled();
  });

  it("flips the master switch for Always, and Settings can turn it back on", async () => {
    seed([musicGap]);
    await dismissOnce(nextKey(), "always");
    expect(useApp.getState().warnMissingModels).toBe(false);
    useApp.getState().setWarnMissingModels(true);
    expect(useApp.getState().warnMissingModels).toBe(true);
  });

  it("never silences the banner", async () => {
    seed([musicGap]);
    await dismissOnce(nextKey(), "project");
    render(<ReadinessBanner />);
    expect(screen.getByRole("status").textContent).toMatch(/none in the finished video/i);
  });
});

/**
 * Folding is the answer to "can I close this?" — and it is not closing.
 * The strip keeps saying that something is not ready; what goes away is
 * the detail. The fold is remembered against the gap set it was made
 * about, so the next problem is not hidden behind a click about this one.
 */
describe("folding the banner", () => {
  const fold = () =>
    screen.getByRole("button", { name: t("readiness.banner.fold") });

  it("keeps the warning and the count, and drops the rows", async () => {
    seed([musicGap, clipDegraded]);
    render(<ReadinessBanner />);
    await userEvent.click(fold());

    const strip = screen.getByRole("status");
    expect(strip.textContent).toContain(t("readiness.banner.title"));
    // The chips are the reading that survives: two problems, still there.
    expect(strip.querySelectorAll(".sev-chip").length).toBe(2);
    expect(strip.querySelector(".gap-list")).toBeNull();
    // And the way in is a disclosure, not a dismissal.
    expect(
      screen.getByRole("button", { name: t("readiness.banner.unfold") }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("stays folded across a remount, because a preference that forgets is furniture", async () => {
    seed([musicGap]);
    const first = render(<ReadinessBanner />);
    await userEvent.click(fold());
    first.unmount();

    render(<ReadinessBanner />);
    expect(screen.getByRole("status").querySelector(".gap-list")).toBeNull();
  });

  it("unfolds itself when the problems change", async () => {
    seed([musicGap]);
    const first = render(<ReadinessBanner />);
    await userEvent.click(fold());
    first.unmount();

    // A second, worse gap appears. The fold was a judgement about the
    // music being a placeholder — it cannot cover an export that will
    // fail, which nobody has seen yet.
    seed([musicGap, exportFails]);
    render(<ReadinessBanner />);
    expect(screen.getByRole("status").querySelector(".gap-list")).not.toBeNull();
  });
});

/**
 * A program as the cause. The gate and the banner sent every fix to
 * Settings > Models, where nothing sets a program up: a missing FFmpeg was
 * explained in three places and fixable in none.
 */
describe("a program to set up", () => {
  it("puts the program's setup in the banner's header", async () => {
    const setupProgram = vi.fn(async () => null);
    seed([exportFails], { setupProgram, programs: null });
    render(<ReadinessBanner />);
    await userEvent.click(screen.getByRole("button", { name: "Set up FFmpeg 163 MB" }));
    expect(setupProgram).toHaveBeenCalledWith("ffmpeg");
  });

  it("sends the banner's setup button to Programs when a program is a cause", async () => {
    const openSettings = vi.fn();
    seed([musicGap, exportFails], { openSettings, programs: null });
    render(<ReadinessBanner />);
    await userEvent.click(
      screen.getByRole("button", { name: t("readiness.banner.setupPrograms") }),
    );
    expect(openSettings).toHaveBeenCalledWith("programs");
  });

  it("still sends a gap that only a model fixes to Models", async () => {
    const openSettings = vi.fn();
    seed([musicGap], { openSettings, programs: null });
    render(<ReadinessBanner />);
    await userEvent.click(screen.getByRole("button", { name: t("readiness.banner.setup") }));
    expect(openSettings).toHaveBeenCalledWith("models");
  });

  it("shows a setup already running instead of offering another", () => {
    seed([exportFails], {
      programs: {
        platform: "linux-x64",
        programs_dir: "/p",
        programs_bytes: 0,
        disk_free_bytes: 1,
        programs: [
          {
            id: "ffmpeg",
            setup: {
              job: { id: "j", phase: "downloading", done: 1, total: 4, bytes_per_s: null },
            },
          },
        ],
      },
    });
    render(<ReadinessBanner />);
    const button = screen.getByRole("button", { name: "Setting up FFmpeg 25%" });
    expect(button).toBeDisabled();
  });

  it("runs the setup from the gate's fixes, and routes its footer to Programs", async () => {
    const setupProgram = vi.fn(async () => null);
    const openSettings = vi.fn();
    seed([exportFails], { setupProgram, openSettings, programs: null });
    render(<Harness onRun={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(t("readiness.dialog.fixes"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: t("readiness.dialog.setupProgram") }),
    );
    expect(setupProgram).toHaveBeenCalledWith("ffmpeg");
    await userEvent.click(
      within(dialog).getByRole("button", { name: t("readiness.dialog.setupPrograms") }),
    );
    expect(openSettings).toHaveBeenCalledWith("programs");
  });

  it("asks again when a fix lands under it, and lets the render go plainly", async () => {
    const run = vi.fn();
    seed([exportFails], { programs: null });
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    const dialog = await screen.findByRole("alertdialog");

    // FFmpeg landed: the engine has nothing left to say about this render.
    const client = useApp.getState().client as unknown as {
      readiness: ReturnType<typeof vi.fn>;
      projectReadiness: ReturnType<typeof vi.fn>;
    };
    client.readiness.mockResolvedValue({ rows: [] });
    client.projectReadiness.mockResolvedValue({ rows: [] });
    act(() => useApp.setState({ readinessEpoch: useApp.getState().readinessEpoch + 1 }));

    await screen.findByText(t("readiness.dialog.allClear"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: t("readiness.dialog.render") }),
    );
    await waitFor(() => expect(run).toHaveBeenCalled());
    // Nothing was dismissed, so nothing is remembered as dismissed.
    expect(localStorage.getItem("localcut.readinessSkip.v1")).toBeNull();
  });
});

/** A ComfyUI stage with no weights and no ComfyUI, as the engine words it:
 * ComfyUI is the gap, with its setup as the fix where LocalCut has one. */
const comfyDown = (
  kind: "keyframe" | "music",
  fix: ReadinessRow["fix"] = null,
): ReadinessRow => ({
  kind,
  model: null,
  backend: "mock",
  verdict: "placeholder",
  reason: "comfyui_down",
  data: { task: kind === "music" ? "music.gen" : "image.gen", weights_installed: false },
  fix,
});

const comfySetup = { type: "setup_program", program: "comfyui", size_bytes: 2_010_504_119 } as const;

/**
 * ComfyUI, when it is what the stages lack. A model download changes
 * nothing while no ComfyUI answers, so the gate offers ComfyUI instead: its setup where
 * LocalCut can set it up on this machine and its steps where it cannot.
 */
describe("ComfyUI, when it is what the stages lack", () => {
  it("offers ComfyUI's setup in the gate and no model download", async () => {
    const setupProgram = vi.fn(async () => null);
    const rows = [comfyDown("keyframe", comfySetup), comfyDown("music", comfySetup)];
    seed(rows, { setupProgram, programs: null });
    render(<Harness onRun={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByRole("button", { name: /download/i })).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: t("readiness.dialog.setupProgram") }),
    );
    expect(setupProgram).toHaveBeenCalledWith("comfyui");
  });

  it("offers ComfyUI's steps where LocalCut cannot set it up", async () => {
    const openProgramSteps = vi.fn();
    seed([comfyDown("keyframe"), comfyDown("music")], { openProgramSteps, programs: null });
    render(<Harness onRun={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(t("readiness.dialog.fixes"));
    expect(within(dialog).queryByRole("button", { name: /download/i })).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: t("readiness.dialog.showSteps") }),
    );
    expect(openProgramSteps).toHaveBeenCalledWith("comfyui");
    // The gate gets out of the way of the steps it opened.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("opens ComfyUI's steps from the banner when they are the only fix", async () => {
    const openProgramSteps = vi.fn();
    const openSettings = vi.fn();
    seed([comfyDown("keyframe"), comfyDown("music")], {
      openProgramSteps,
      openSettings,
      programs: null,
    });
    render(<ReadinessBanner />);
    await userEvent.click(
      screen.getByRole("button", { name: t("readiness.banner.setupPrograms") }),
    );
    expect(openProgramSteps).toHaveBeenCalledWith("comfyui");
    expect(openSettings).not.toHaveBeenCalled();
  });
});

const scriptModelMissing: ReadinessRow = {
  kind: "script",
  model: "qwen3:14b",
  backend: "llm",
  verdict: "will_fail",
  reason: "llm_model_missing",
  data: { task: "text.llm", model: "qwen3:14b" },
  fix: { type: "pick_model", task: "text.llm" },
};

/**
 * A model to pick. The engine's fix for a script model the LLM server does
 * not have is a choice under Default models, and "Set up models" landed on
 * the Models tab with the library in view and nothing pointing at that row.
 */
describe("a model to pick", () => {
  it("opens the picker it names from the gate, closing the gate first", async () => {
    seed([scriptModelMissing]);
    render(<Harness onRun={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: t("readiness.fix.pickModel") }),
    );
    // Settings is a layer of its own, and a gate left open over it would
    // keep the focus trap.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const state = useApp.getState();
    expect([state.settingsOpen, state.settingsTab, state.defaultPickerFocus]).toEqual([
      true,
      "models",
      "text.llm",
    ]);
  });

  it("offers the same picker from the banner's well", async () => {
    seed([scriptModelMissing]);
    render(<ReadinessBanner />);
    await userEvent.click(screen.getByRole("button", { name: t("readiness.fix.pickModel") }));
    const state = useApp.getState();
    expect([state.settingsOpen, state.settingsTab, state.defaultPickerFocus]).toEqual([
      true,
      "models",
      "text.llm",
    ]);
  });

  it("leaves a program beside it on Programs", async () => {
    const openSettings = vi.fn();
    seed([exportFails, scriptModelMissing], { openSettings, programs: null });
    render(<Harness onRun={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    const dialog = await screen.findByRole("alertdialog");
    // The pick belongs to the script's well alone; FFmpeg's fix is still
    // its setup, and the footer still goes where that is done.
    expect(
      within(dialog).getAllByRole("button", { name: t("readiness.fix.pickModel") }),
    ).toHaveLength(1);
    await userEvent.click(
      within(dialog).getByRole("button", { name: t("readiness.dialog.setupPrograms") }),
    );
    expect(openSettings).toHaveBeenCalledWith("programs");
  });
});

describe("a cloned narration that cannot load", () => {
  // The engine's own sentence, as `/voices` sends it to the inspector. It
  // quotes the import error, so it cannot come from the catalog.
  const reason =
    "chatterbox-tts is installed but does not import (ImportError: tokenizers>=0.22.0," +
    "<=0.23.0 is required for a normal functioning of this module, but found " +
    "tokenizers==0.23.1.). Repair the engine environment as docs/voices.md describes, " +
    "then restart the engine.";
  const cloneFails: ReadinessRow = {
    kind: "narration",
    model: "local:chatterbox",
    backend: "chatterbox",
    verdict: "will_fail",
    reason: "clone_unavailable",
    data: { task: "speech.tts", cloning_reason: reason },
    fix: null,
  };

  it("says cloning cannot run, and why in the engine's words, on the board", () => {
    seed([cloneFails]);
    const { container } = render(<ReadinessBanner />);
    const well = container.querySelector(".well");
    expect(well?.querySelector(".whead")?.textContent).toBe(
      t("readiness.reasons.clone_unavailable"),
    );
    expect(well?.textContent).toContain(reason);
    expect(well?.textContent).toContain(t("readiness.effects.will_fail"));
  });

  it("holds a render behind the gate with the same reason", async () => {
    // The gate is what stood between "Make my final video" and a render
    // whose every narration fails.
    const run = vi.fn();
    seed([cloneFails]);
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(reason);
    expect(run).not.toHaveBeenCalled();
  });
});

const scriptModelPullable: ReadinessRow = {
  ...scriptModelMissing,
  model: "qwen3:8b",
  data: { task: "text.llm", model: "qwen3:8b" },
  fix: { type: "pull_model", program: "ollama", model: "qwen3:8b", size_bytes: 5 * 2 ** 30 },
};

/**
 * A model to pull. An Ollama that runs without the script model gets it
 * where the gap is shown, the way a missing program is set up there, and
 * Programs is where both lead.
 */
describe("a model to pull", () => {
  it("pulls it from the banner's header when it is the only fix", async () => {
    const pullModel = vi.fn(async () => null);
    seed([scriptModelPullable], { pullModel, programs: null });
    render(<ReadinessBanner />);
    await userEvent.click(screen.getByRole("button", { name: "Get qwen3:8b 5.0 GB" }));
    expect(pullModel).toHaveBeenCalledWith("ollama", "qwen3:8b");
  });

  it("pulls it from the gate's fixes, and routes the footer to Programs", async () => {
    const pullModel = vi.fn(async () => null);
    const openSettings = vi.fn();
    seed([scriptModelPullable], { pullModel, openSettings, programs: null });
    render(<Harness onRun={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Get qwen3:8b" }));
    expect(pullModel).toHaveBeenCalledWith("ollama", "qwen3:8b");
    await userEvent.click(
      within(dialog).getByRole("button", { name: t("readiness.dialog.setupPrograms") }),
    );
    expect(openSettings).toHaveBeenCalledWith("programs");
  });
});
