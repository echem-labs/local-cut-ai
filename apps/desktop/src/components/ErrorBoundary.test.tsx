import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary";

/**
 * UI-5. The boundary used to log nothing and offer nothing, so any render
 * error meant restarting the app — and the component stack, the one artifact
 * that says WHERE it broke, was thrown away.
 */

function Boom({ explode }: { explode: boolean }) {
  if (explode) throw new Error("kaboom");
  return <p>recovered content</p>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // React logs the caught error itself; silence it so a passing test does
    // not print a scary stack. The assertions below still prove OUR log ran.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the message instead of a blank window", () => {
    render(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("kaboom");
  });

  it("logs the component stack, which only componentDidCatch ever sees", () => {
    render(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const ours = logged.find((args) => args[0] === "[ui] render error:");
    expect(ours, "the boundary did not log the render error").toBeDefined();
    expect(ours?.[2]).toContain("Boom"); // the component stack names the culprit
  });

  it("retries back into a working tree (UI-5)", async () => {
    const user = userEvent.setup();
    // Most render crashes come from one bad piece of state; by the time the
    // user clicks retry the offending state is usually gone.
    const { rerender } = render(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // The bad state clears, then the user retries.
    rerender(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("recovered content")).toBeInTheDocument();
  });

  it("offers a way to copy the details for a bug report", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole("button", { name: "Copy details" }));
    expect(writeText).toHaveBeenCalledOnce();
    // The message AND the component stack — a report with only "kaboom" in
    // it is not actionable.
    const copied = writeText.mock.calls[0][0];
    expect(copied).toContain("kaboom");
    expect(copied).toContain("Boom");
  });
});
