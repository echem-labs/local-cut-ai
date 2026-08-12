/**
 * What the user is told when a local read outlives the app's patience.
 *
 * Reading a picture is the one interactive call that waits on a vision model,
 * and a vision model that is not resident yet loads several GB before it says
 * anything. On a busy GPU that is minutes — so this route, alone among them,
 * can hit its budget on a machine where nothing is actually wrong.
 *
 * What shipped for that case was the platform's own words: `signal timed out`.
 * Four tokens of jargon naming no actor, no cause and no next step, rendered
 * into a dialog in an app where every other string is written for a person.
 * It also blamed the wrong side — the ENGINE is still working when this
 * fires, and trying again once the model is resident usually takes seconds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EngineTimeoutError, VISION_TIMEOUT_MS } from "./api/client";
import { t } from "./i18n";
import { useApp } from "./store";

const suggestScene = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({
    client: { suggestScene } as never,
    currentProject: { id: "p1", title: "t" } as never,
  } as never);
});

describe("a read that outlives its budget", () => {
  it("says what happened in words, not in DOMException", async () => {
    suggestScene.mockRejectedValueOnce(new EngineTimeoutError(VISION_TIMEOUT_MS));

    const result = await useApp.getState().suggestScene("asset-abc");

    expect(result.error).toBe(
      t("errors.engineTimeout", { seconds: Math.round(VISION_TIMEOUT_MS / 1000) }),
    );
    // The platform's phrasing must not survive anywhere in what is shown.
    expect(result.error).not.toMatch(/signal|abort|DOMException/i);
  });

  it("reports nothing at all when the user is the one who gave up", async () => {
    // An abort the caller asked for is not a failure to explain back at them.
    // Reporting it would put a red banner in a dialog the user is still
    // using, for a thing they did deliberately.
    const controller = new AbortController();
    controller.abort();
    suggestScene.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));

    const result = await useApp
      .getState()
      .suggestScene("asset-abc", undefined, controller.signal);

    expect(result.error).toBeUndefined();
  });
});
