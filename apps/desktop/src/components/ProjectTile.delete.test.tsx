/**
 * What a tile's delete confirmation says it is deleting.
 *
 * It said "quick tool output" for all six tools and offered "Delete output"
 * as the button — the app's word for its own data model, in the one place
 * the user has to be sure what they are about to lose. The tile already
 * knows the kind: it draws its icon.
 *
 * The unknown-kind case is the reason the branch is `isToolSession` rather
 * than `toolKindOf`: a session from a newer engine is still a one-off
 * output, and telling that user their "project and all generated media" is
 * going overstates it in the direction that scares people off the button.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "../api/types";
import { t } from "../i18n";
import { ProjectTile, useTileLifecycle } from "./ProjectTile";
import { useApp } from "../store";

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1",
    title: "a lighthouse at dusk",
    created_at: 0,
    mode: "prompt",
    approvals: [],
    ...over,
  }) as Project;

function Host({ subject }: { subject: Project }) {
  const { bind, dialog } = useTileLifecycle();
  return (
    <>
      <ProjectTile project={subject} status="draft" actions={bind(subject)} />
      {dialog}
    </>
  );
}

async function askToDelete(subject: Project) {
  useApp.setState({ client: null, deleteProject: vi.fn(async () => null) } as never);
  render(<Host subject={subject} />);
  await userEvent.click(
    screen.getByRole("button", { name: t("home.tileMenuAria", { title: subject.title }) }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: t("common.delete") }));
}

describe("the tile's delete confirmation", () => {
  it("names the tool that made it", async () => {
    await askToDelete(project({ mode: "tool:voiceover" }));
    expect(screen.getByText(t("home.deleteToolMessage", { noun: "voiceover" }))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t("home.deleteToolConfirm", { noun: "voiceover" }) }),
    ).toBeTruthy();
  });

  it("falls back to the generic word for a kind this build does not know", async () => {
    await askToDelete(project({ mode: "tool:hologram" }));
    expect(
      screen.getByText(t("home.deleteToolMessage", { noun: t("home.toolOutputNoun") })),
    ).toBeTruthy();
  });

  it("still promises the whole project for a project", async () => {
    await askToDelete(project());
    expect(screen.getByText(t("home.deleteMessage"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("home.deleteConfirm") })).toBeTruthy();
  });
});
