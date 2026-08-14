/**
 * What the app does when the engine stops on its own.
 *
 * The failure this covers is silence: the renderer keeps every bit of its
 * state when the engine dies, so without a banner the app looks intact and
 * every action simply fails. What is asserted here is that the crash is
 * said out loud, that the way back is one button, and that the button does
 * not disappear when pressing it did not work.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCrash, SystemInfo } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { EngineCrashBanner } from "./EngineCrashBanner";

const CRASH: EngineCrash = {
  code: 1,
  signal: null,
  tail: ["[engine] Traceback (most recent call last):", "[engine] RuntimeError: out of memory"],
  at: "2026-08-09T16:07:33.438Z",
};

const SYSTEM = {
  hardware: { os: "Windows 11", arch: "x64", ram_gb: 32, disk_free_gb: 400, gpus: [], primary_gpu: null, tier: "B" },
  recommendations: [],
  backend_mode: "comfy",
} as unknown as SystemInfo;

// Typed by its argument so `mock.calls[0][0]` is the report, not `never`.
const writeText = vi.fn(async (_report: string) => {});

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText } });
  writeText.mockClear();
  useApp.setState({ engineCrash: null, system: SYSTEM } as never);
});

afterEach(cleanup);

/** Mount with a crash in the store and a restartEngine the test controls. */
function mount(restartEngine: () => Promise<string | null>) {
  useApp.setState({ engineCrash: CRASH, system: SYSTEM, restartEngine } as never);
  return render(<EngineCrashBanner />);
}

describe("the engine crash banner", () => {
  it("says nothing at all when the engine is fine", () => {
    useApp.setState({ engineCrash: null } as never);
    const { container } = render(<EngineCrashBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the crash rather than leaving the app to look intact", () => {
    mount(async () => null);
    // role=alert: this arrives while the user is looking at something else,
    // and it changes what every control on screen will do.
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(t("errors.engineCrashed"));
    expect(banner).toHaveTextContent(t("errors.engineCrashedDetail"));
  });

  it("offers the one button that fixes it, and reports while it runs", async () => {
    let release: (value: string | null) => void = () => {};
    const restart = vi.fn(() => new Promise<string | null>((resolve) => (release = resolve)));
    mount(restart);

    fireEvent.click(screen.getByText(t("errors.engineRestart")));
    expect(restart).toHaveBeenCalled();
    expect(screen.getByText(t("errors.engineRestarting"))).toBeDisabled();

    await act(async () => release(null));
  });

  it("explains the wait rather than leaving a dead-looking button for a minute", async () => {
    // A restart in the minute after a crash cannot succeed at once — the
    // engine's port is still held by the kernel and the app spends that
    // minute retrying. Sixty seconds of a disabled button and nothing else
    // moving reads as a button that does nothing.
    vi.useFakeTimers();
    try {
      let release: (value: string | null) => void = () => {};
      const restart = vi.fn(() => new Promise<string | null>((resolve) => (release = resolve)));
      mount(restart);
      fireEvent.click(screen.getByText(t("errors.engineRestart")));

      // Not immediately: the ordinary restart is over in a second or two and
      // should say nothing at all.
      expect(screen.queryByText(t("errors.engineRestartSlow"))).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByText(t("errors.engineRestartSlow"))).toBeInTheDocument();

      // And it goes away with the wait it was explaining.
      await act(async () => release(null));
      expect(screen.queryByText(t("errors.engineRestartSlow"))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the way back on screen when the restart failed", async () => {
    // The button clearing itself on failure is the trap: the banner would
    // vanish, the engine would still be down, and the app would be back to
    // looking intact and doing nothing.
    mount(async () => "port 7830 is held by another process");
    fireEvent.click(screen.getByText(t("errors.engineRestart")));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        t("errors.engineRestartFailed", { detail: "port 7830 is held by another process" }),
      ),
    );
    expect(screen.getByText(t("errors.engineRestart"))).toBeEnabled();
  });

  it("copies a report carrying the engine's last words", async () => {
    mount(async () => null);
    fireEvent.click(screen.getByText(t("errors.engineCopyReport")));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const report = writeText.mock.calls[0]![0];
    // The traceback is the whole point: versions alone say which build, not
    // what happened, and by the time anyone looks the log is a folder away.
    expect(report).toContain("RuntimeError: out of memory");
    expect(report).toContain("Windows 11");
    expect(report).toContain("code 1");
  });
});
