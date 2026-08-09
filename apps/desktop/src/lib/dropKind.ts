/**
 * What a dropped file is, and whether this app will take it.
 *
 * Kept apart from the drop surface because the policy is the interesting
 * half and the DataTransfer plumbing is not. Two things make this less
 * obvious than `file.type.startsWith("image/")`:
 *
 * A directory arrives as a File with an empty `type` and no size, so a
 * dropped folder would otherwise upload as a zero-byte asset with a
 * plausible name — the kind of failure that only shows up later, in a render
 * that cannot read its own conditioning image.
 *
 * And `type` is a guess the OS makes from the extension, which it can
 * decline to make at all: a `.wav` recorded by a tool the OS does not know
 * arrives as `""`. Falling back to the extension keeps a legitimate file
 * from being refused for a reason the user cannot see or fix.
 */

export type DropKind = "image" | "audio" | "unsupported";

/** Extensions the engine's asset routes already accept. */
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "bmp"];
const AUDIO_EXT = ["wav", "mp3", "flac", "m4a", "ogg"];

const extensionOf = (name: string): string => {
  const at = name.lastIndexOf(".");
  return at > 0 ? name.slice(at + 1).toLowerCase() : "";
};

export function dropKind(file: { name: string; type: string; size?: number }): DropKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  // Only for a file the OS had no opinion about — a `type` that says
  // `application/pdf` is an answer, and guessing past it would be worse
  // than refusing.
  if (file.type === "") {
    const ext = extensionOf(file.name);
    if (IMAGE_EXT.includes(ext)) return "image";
    if (AUDIO_EXT.includes(ext)) return "audio";
  }
  return "unsupported";
}

/**
 * A dropped directory, which the browser hands over as an empty-ish File.
 *
 * There is no reliable synchronous test for this — `webkitGetAsEntry` gives
 * a real answer but only from the DataTransferItem, before the File is
 * taken. This is the fallback for everything that reaches us as a File:
 * no type the OS would assign, and no bytes.
 */
export const looksLikeDirectory = (file: { type: string; size?: number }): boolean =>
  file.type === "" && (file.size ?? 0) === 0;
