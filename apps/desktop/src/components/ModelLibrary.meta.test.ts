/**
 * `files: []` is one wire fact for three different runtimes, and the row
 * has to say which. The rule is deliberately conservative: name a runtime
 * only where this build ships one, and fall back to the bare word — an
 * external image model is served by something the app knows nothing about,
 * and "runs outside the engine" would be a claim, not a description.
 */
import { describe, expect, it } from "vitest";

import { externalNote } from "./ModelLibrary";
import { t } from "../i18n";

describe("externalNote", () => {
  it("names Ollama for the LLM stage", () => {
    expect(externalNote("text.llm")).toBe(t("models.ollamaMeta"));
  });

  it("calls the companion processes what they are", () => {
    expect(externalNote("speech.tts")).toBe(t("models.externalMeta"));
    expect(externalNote("transcribe")).toBe(t("models.externalMeta"));
  });

  it("claims nothing for a task with no shipped runtime", () => {
    expect(externalNote("image.gen")).toBe(t("models.external"));
    expect(externalNote("video.i2v")).toBe(t("models.external"));
  });
});
