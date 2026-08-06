/**
 * The refusal notice (see components/Alert).
 *
 * What is pinned here is that it stays an ANSWER: the message is announced
 * where it happened, and a message the user has read can be put away —
 * before this, an engine refusal sat on the Library in red until the screen
 * was navigated away from.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { Alert } from "./Alert";

describe("Alert", () => {
  it("announces itself, because it answers something the user just did", () => {
    render(<Alert message="project.json is not valid UTF-8" />);
    expect(screen.getByRole("alert")).toHaveTextContent("project.json is not valid UTF-8");
  });

  it("can be put away once it has been read", () => {
    const onDismiss = vi.fn();
    render(<Alert message="engine 409" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText(t("common.dismiss")));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("offers no dismiss for a message that is only true while its state is", () => {
    // A node's own error belongs to the node: clearing the text would not
    // clear the failure, so there is nothing honest for a close to do.
    render(<Alert message="still clip needs a keyframe input" />);
    expect(screen.queryByLabelText(t("common.dismiss"))).toBeNull();
  });
});
