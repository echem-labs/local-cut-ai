/**
 * The two-step remote pairing flow in Settings → Engine.
 *
 * Pairing and arming provider keys are deliberately two decisions: accepting
 * a pairing code used to push every stored key to whatever host the code
 * named, and the certificate pin is no defence there because the same code
 * supplies both the certificate and its fingerprint. The consent checkbox is
 * what makes the second decision explicit, so its DEFAULT is the security
 * property — a ticked box carried over from a previous host would arm a
 * brand-new, unreviewed one.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { Settings } from "./Settings";
import { useApp } from "../store";

const PREVIEW = (host: string) => ({
  ok: true,
  error: null,
  host,
  url: `https://${host}`,
  fingerprint: "ab:cd",
  keys: { anthropic: true, openai: false, gemini: false, fal: false, encrypted: true },
});

let inspectPairing: ReturnType<typeof vi.fn>;
let pairRemote: ReturnType<typeof vi.fn>;

beforeEach(() => {
  inspectPairing = vi.fn(async (code: string) =>
    PREVIEW(code.includes("b") ? "boxb.local" : "boxa.local"),
  );
  pairRemote = vi.fn(async () => null); // null = paired successfully
  useApp.setState({
    settingsOpen: true,
    settingsTab: "engine",
    remotePaired: false,
    remote: false,
    inspectPairing,
    pairRemote,
  } as never);
  render(<Settings />);
});

const codeBox = () => screen.getByLabelText(t("settings.remote.pairAria"));
const armBox = () => screen.getByRole("checkbox", { name: /also send my provider keys/i });

/** Paste a code and take it through step 1, landing on the review panel. */
async function review(code: string) {
  fireEvent.change(codeBox(), { target: { value: code } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: t("settings.remote.pair") }));
  });
}

/** Step 2: the user has read the host and said yes. */
async function confirm() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: t("settings.remote.reviewConfirm") }));
  });
}

describe("the arm-keys consent box", () => {
  it("starts unticked, so pairing alone sends nothing", async () => {
    await review("code-a");
    expect(armBox()).not.toBeChecked();

    await confirm();
    expect(pairRemote).toHaveBeenCalledWith("code-a", false);
  });

  it("sends the keys only when it is ticked", async () => {
    await review("code-a");
    fireEvent.click(armBox());
    await confirm();

    expect(pairRemote).toHaveBeenCalledWith("code-a", true);
  });

  it("resets after a successful pairing, so the next host is not pre-armed", async () => {
    // The regression: the checkbox is component state that outlived the
    // pairing it belonged to. Pair host A with keys, unpair, then paste a code
    // for host B — the review step for a brand-new host rendered with "also
    // send my provider keys" already ticked, inverting the opt-in default the
    // whole two-step flow exists to establish.
    await review("code-a");
    fireEvent.click(armBox());
    await confirm();
    expect(pairRemote).toHaveBeenLastCalledWith("code-a", true);

    await act(async () => {
      useApp.setState({ remotePaired: false, remote: false } as never);
    });
    await review("code-b");

    expect(screen.getByText("https://boxb.local")).toBeInTheDocument();
    expect(armBox()).not.toBeChecked();
  });

  it("keeps the box ticked when the pairing failed, so the answer is not lost", async () => {
    // A reset on failure would silently drop a decision the user already made
    // while they fix a typo in the code.
    pairRemote.mockResolvedValue("the engine rejected the pairing token");
    await review("code-a");
    fireEvent.click(armBox());
    await confirm();

    expect(screen.getByText(/rejected the pairing token/)).toBeInTheDocument();
    expect(armBox()).toBeChecked();
  });
});

describe("the review step", () => {
  it("shows the host before anything is sent to it", async () => {
    await review("code-a");

    // The panel shows the full URL — the scheme is part of what is reviewed.
    expect(screen.getByText("https://boxa.local")).toBeInTheDocument();
    // Step 1 only decodes; nothing is paired until the user confirms.
    expect(pairRemote).not.toHaveBeenCalled();
  });

  it("reports a code it could not decode instead of pairing", async () => {
    inspectPairing.mockResolvedValue({ ok: false, error: "that doesn't look like a pairing code" });
    await review("nonsense");

    expect(screen.getByText(/doesn't look like a pairing code/)).toBeInTheDocument();
    expect(pairRemote).not.toHaveBeenCalled();
  });
});
