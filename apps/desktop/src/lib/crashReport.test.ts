/**
 * The block someone pastes into a bug report.
 *
 * Its whole value is being readable by a person who was not there, so the
 * cases that matter are the ones where a field is missing or unusual: an
 * engine killed by a signal rather than an exit code, an engine that said
 * nothing at all on the way down, and a session where `/system` never
 * answered so there is no machine to describe.
 *
 * Each of those printed as "null" or an empty line before this, which reads
 * as a broken report rather than as an absent fact.
 */
import { describe, expect, it } from "vitest";

import type { EngineCrash, SystemInfo } from "../api/types";
import { t } from "../i18n";
import { crashReport } from "./crashReport";

const SYSTEM = {
  hardware: { os: "Windows 11", arch: "x64" },
  backend_mode: "comfy",
} as unknown as SystemInfo;

const crash = (patch: Partial<EngineCrash> = {}): EngineCrash => ({
  code: 1,
  signal: null,
  tail: ["[engine] Traceback (most recent call last):", "[engine] RuntimeError: no CUDA device"],
  at: "2026-08-09T16:07:33.438Z",
  ...patch,
});

describe("the crash report", () => {
  it("carries the build, the machine and the engine's last words", () => {
    const report = crashReport(crash(), { appVersion: "0.1.0", system: SYSTEM });

    expect(report).toContain("0.1.0");
    expect(report).toContain("Windows 11");
    expect(report).toContain("x64");
    expect(report).toContain("comfy");
    expect(report).toContain("2026-08-09T16:07:33.438Z");
    expect(report).toContain("RuntimeError: no CUDA device");
  });

  it("says a signal ended it rather than reporting a null code", () => {
    // "code null" reads as a missing value. A signal is a different fact,
    // and on POSIX it is the one that says the OOM killer took the engine.
    const report = crashReport(crash({ code: null, signal: "SIGKILL" }), {
      appVersion: "0.1.0",
      system: SYSTEM,
    });

    expect(report).toContain(t("errors.crashReportExitSignal", { signal: "SIGKILL" }));
    expect(report).not.toContain("null");
  });

  it("says so when the engine produced no output at all", () => {
    // An empty section under "last engine output:" reads as a truncated
    // report; the absence is itself worth stating, since it points at a
    // process that died before it could log.
    const report = crashReport(crash({ tail: [] }), { appVersion: "0.1.0", system: SYSTEM });

    expect(report).toContain(t("errors.crashReportNoOutput"));
  });

  it("names the machine as unknown rather than printing null", () => {
    // A crash during startup is exactly when `/system` has not answered —
    // and exactly the crash most worth reporting.
    const report = crashReport(crash(), { appVersion: "0.1.0", system: null });

    expect(report).toContain(t("errors.crashReportUnknown"));
    expect(report).not.toContain("null");
    expect(report).not.toContain("undefined");
  });

  it("keeps the engine's own lines verbatim, one per line", () => {
    // The tail is pasted into an issue and read as a traceback. Joining or
    // re-wrapping it would make the frames unreadable.
    const report = crashReport(crash(), { appVersion: "0.1.0", system: SYSTEM });
    const lines = report.split("\n");

    expect(lines).toContain("[engine] Traceback (most recent call last):");
    expect(lines).toContain("[engine] RuntimeError: no CUDA device");
  });
});
