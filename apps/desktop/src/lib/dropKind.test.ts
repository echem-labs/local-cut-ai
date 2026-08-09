/**
 * What the app agrees to take from a drop.
 *
 * The two cases worth pinning are the ones a naive `type.startsWith` gets
 * wrong in opposite directions: a folder, which arrives looking like an
 * untyped file and would upload as a zero-byte asset, and a legitimate
 * `.wav` the OS declined to type at all, which would be refused for a
 * reason the user can neither see nor fix.
 */
import { describe, expect, it } from "vitest";

import { dropKind, looksLikeDirectory } from "./dropKind";

const file = (name: string, type: string, size = 1024) => ({ name, type, size });

describe("what a dropped file is", () => {
  it("takes the OS at its word when it has one", () => {
    expect(dropKind(file("shot.png", "image/png"))).toBe("image");
    expect(dropKind(file("me.wav", "audio/wav"))).toBe("audio");
  });

  it("falls back to the extension only when the OS had no opinion", () => {
    expect(dropKind(file("shot.PNG", ""))).toBe("image");
    expect(dropKind(file("sample.flac", ""))).toBe("audio");
  });

  it("does not guess past a type the OS did assign", () => {
    // The name says image, the OS says otherwise. Guessing here would upload
    // a PDF as a conditioning frame.
    expect(dropKind(file("notes.png.pdf", "application/pdf"))).toBe("unsupported");
  });

  it("refuses what it cannot use", () => {
    expect(dropKind(file("script.txt", "text/plain"))).toBe("unsupported");
    expect(dropKind(file("archive.zip", ""))).toBe("unsupported");
    expect(dropKind(file("noextension", ""))).toBe("unsupported");
    // A leading dot is not an extension.
    expect(dropKind(file(".png", ""))).toBe("unsupported");
  });

  it("knows a folder from a file", () => {
    // A dropped folder arrives as an untyped, empty File. Uploaded, it would
    // become a plausibly-named zero-byte asset whose failure only surfaces
    // later, in a render that cannot read its own conditioning image.
    expect(looksLikeDirectory({ type: "", size: 0 })).toBe(true);
    expect(looksLikeDirectory({ type: "", size: 4096 })).toBe(false);
    expect(looksLikeDirectory({ type: "image/png", size: 0 })).toBe(false);
  });
});
