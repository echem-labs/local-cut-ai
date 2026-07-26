/**
 * Arming provider keys against an engine you are ALREADY paired with.
 *
 * The consent is per host and re-read on every launch, so declining at pair
 * time was permanent: `armRemoteKeys` and its IPC handler both existed, and
 * nothing in the UI called either. A user who later wanted cloud generation
 * on their GPU box had to unpair and pair again to be re-asked — and nothing
 * on screen said so.
 *
 * Kept apart from Settings.pairing.test.tsx because that file renders the
 * pane in its UNPAIRED state; this control only exists in the paired one.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./Settings";
import { useApp } from "../store";

const PRESENCE = {
  anthropic: true,
  openai: false,
  gemini: false,
  fal: false,
  encrypted: true,
};

let armRemoteKeys: ReturnType<typeof vi.fn>;

/** Render the pane for an engine that is paired and connected. */
async function mount(
  options: { keysArmed?: boolean; remote?: boolean; presence?: typeof PRESENCE } = {},
) {
  armRemoteKeys = vi.fn(async () => null);
  window.localcut.getProviderKeyPresence = vi
    .fn()
    .mockResolvedValue(options.presence ?? PRESENCE);
  useApp.setState({
    settingsOpen: true,
    settingsTab: "engine",
    remotePaired: true,
    remoteEngine: options.remote ?? true,
    remoteKeysArmed: options.keysArmed ?? false,
    armRemoteKeys,
  } as never);
  await act(async () => {
    render(<Settings />);
  });
}

const sendButton = () => screen.queryByRole("button", { name: /send keys/i });

beforeEach(() => {
  // Every field `mount` writes, or a test inherits the previous one's engine.
  useApp.setState({
    settingsOpen: false,
    remotePaired: false,
    remoteEngine: false,
    remoteKeysArmed: true,
  } as never);
});

describe("an unarmed remote engine", () => {
  it("offers to send the keys, and names which ones", async () => {
    await mount({ keysArmed: false });

    expect(sendButton()).not.toBeNull();
    expect(screen.getByText(/not shared with this engine/i)).toBeInTheDocument();
    // Named, not counted — "1 key" is not something anyone can act on.
    expect(screen.getByText(/anthropic/i)).toBeInTheDocument();
  });

  it("sends them when asked", async () => {
    await mount({ keysArmed: false });
    await act(async () => {
      fireEvent.click(sendButton()!);
    });

    expect(armRemoteKeys).toHaveBeenCalledTimes(1);
  });

  it("surfaces a refusal rather than silently doing nothing", async () => {
    await mount({ keysArmed: false });
    armRemoteKeys.mockResolvedValue("the engine rejected the pairing token");
    await act(async () => {
      fireEvent.click(sendButton()!);
    });

    expect(screen.getByText(/rejected the pairing token/)).toBeInTheDocument();
  });
});

describe("when there is nothing to offer", () => {
  it("says nothing for an engine that already has the keys", async () => {
    await mount({ keysArmed: true });

    expect(sendButton()).toBeNull();
    expect(screen.getByText(/keys are shared with this engine/i)).toBeInTheDocument();
  });

  it("says nothing when no provider key is stored", async () => {
    // Offering to send keys the user does not have would be noise.
    await mount({
      keysArmed: false,
      presence: { anthropic: false, openai: false, gemini: false, fal: false, encrypted: true },
    });

    expect(sendButton()).toBeNull();
  });

  it("says nothing for a local engine", async () => {
    // A local engine is this machine — the keys are already on it, and there
    // is no second party to consent to.
    await mount({ keysArmed: true, remote: false });

    expect(sendButton()).toBeNull();
  });
});
