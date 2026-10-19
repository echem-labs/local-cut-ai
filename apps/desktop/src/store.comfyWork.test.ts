/**
 * Clearing what renders left in LocalCut's own ComfyUI, held to the store's
 * reporting rule: null once it is cleared, otherwise a message to show. The
 * engine's one refusal is a 409 while a render is using that copy, and it
 * reads as that, not as the engine's English.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EngineError } from "./api/client";
import { t } from "./i18n";
import { useApp } from "./store";

const STORAGE = {
  projects: [],
  models_bytes: 0,
  cache_bytes: 0,
  comfyui_bytes: 0,
  disk_free_bytes: 1,
  disk_total_bytes: 2,
};

function fakeClient(cleanup: () => Promise<unknown>) {
  return {
    storageComfyCleanup: vi.fn(cleanup),
    storage: vi.fn().mockResolvedValue(STORAGE),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  useApp.setState({ client: null, storage: null, storageStale: false } as never);
});

describe("clearComfyWork", () => {
  it("clears and measures again", async () => {
    const client = fakeClient(async () => ({ ok: true, freed_bytes: 1230 }));
    useApp.setState({ client } as never);
    expect(await useApp.getState().clearComfyWork()).toBeNull();
    expect(client.storageComfyCleanup).toHaveBeenCalledTimes(1);
    expect(useApp.getState().storage).toEqual(STORAGE);
  });

  it("says a render is using the copy when the engine refuses", async () => {
    const client = fakeClient(async () => {
      throw new EngineError(409, "engine 409: a render is using LocalCut's ComfyUI");
    });
    useApp.setState({ client } as never);
    expect(await useApp.getState().clearComfyWork()).toBe(t("settings.storage.comfyBusy"));
    expect(client.storage).not.toHaveBeenCalled();
  });

  it("passes any other failure on as it reads", async () => {
    useApp.setState({
      client: fakeClient(async () => {
        throw new EngineError(500, "engine 500: disk on fire");
      }),
    } as never);
    expect(await useApp.getState().clearComfyWork()).toBe("engine 500: disk on fire");
  });

  it("says there is no engine when there is none", async () => {
    expect(await useApp.getState().clearComfyWork()).toBe(t("errors.engineUnavailable"));
  });
});
