/** Single source of truth for user-facing vocabulary (design review 3, §5).
 *
 * Node ids and kind strings are the ENGINE'S WIRE CONTRACT — everything in
 * this file is display-side relabeling only; identifiers on the wire never
 * change. Tooltips, the glossary, panel help and queue labels all read from
 * here so the copy can never drift apart.
 */

/** Aux node ids → human names. */
const AUX_LABELS: Record<string, string> = {
  script: "Script",
  timeline: "Timeline",
  export: "Final video",
  music: "Music",
  voiceover: "Voiceover",
  thumbnail: "Thumbnail",
  captions: "Captions",
};

/** Scene-member kinds → human names (clip renders as "video" in labels —
 * "Scene 2 video" reads better than "Scene 2 clip" in a queue). */
const KIND_LABELS: Record<string, string> = {
  keyframe: "still image",
  clip: "video",
  narration: "narration",
};

const SCENE_NODE = /^s(\d+)\.([a-z]+?)(\d*)$/;

/** "s2.clip" → "Scene 2 video" · "s5.keyframe" → "Scene 5 still image" ·
 * "timeline" → "Timeline". Raw ids never reach the UI. */
export function nodeLabel(nodeId: string): string {
  const aux = AUX_LABELS[nodeId];
  if (aux) return aux;
  const match = SCENE_NODE.exec(nodeId);
  if (match) {
    const [, scene, kind, take] = match;
    const kindLabel = KIND_LABELS[kind] ?? kind;
    return `Scene ${scene} ${kindLabel}${take ? ` · take ${Number(take) + 1}` : ""}`;
  }
  return nodeId;
}

/** Scene number from any scene-member node id, or null for aux nodes. */
export function sceneNumber(nodeId: string): string | null {
  return SCENE_NODE.exec(nodeId)?.[1] ?? null;
}

/** Short title for the inspector: "Scene 5" / "Music". */
export function inspectorTitle(nodeId: string): string {
  const scene = sceneNumber(nodeId);
  return scene ? `Scene ${scene}` : (AUX_LABELS[nodeId] ?? nodeId);
}

/** Field/term tooltips — one or two short sentences, plain words, no
 * exclamation marks. Explains what happens, never the mechanism. */
export const TIPS = {
  scene: "One beat of your video — a few seconds with its own image, video, and narration.",
  still: "The picture this scene starts from. Get this right before rendering video — stills are fast, video is slow.",
  clip: "The few seconds of video for this scene, animated from its still image.",
  narration: "What the voice says during this scene. Its length sets how long the scene runs.",
  storyboard: "All your still images in order — the plan for the video before any video is rendered.",
  seed: "Same prompt and seed give the same result. Change it for a different take.",
  model: "Use a different AI model for just this shot. Leave on Auto to use your default.",
  motion: "How the camera moves — plain words work: 'slow push in', 'orbit right', 'handheld', 'static'.",
  length: "How much source video to render. The narration still decides how long the scene plays.",
  trim: "Cut seconds off the start or end of this clip.",
  overlay: "Text drawn on screen during this scene.",
  pin: "Locks this exactly as it is. Regenerating and prompt edits skip it until you unpin.",
  newTake: "Same prompt, different randomness.",
  createFinal:
    "Re-renders any draft scenes at full quality, then builds your MP4. Drafts are for deciding — do this when you're happy.",
  duck: "Automatically turns the music down whenever the narrator is speaking.",
  beat: "Nudges scene changes to land on the music's beat.",
  captionsBurn: "Captions are drawn onto the video itself. Always visible, works everywhere.",
  captionsSidecar: "Captions come as a subtitle file (.srt) viewers can turn on or off.",
  proEditor:
    "Sends your scenes, audio and timeline to a pro editor for manual finishing.",
  voice: 'Which narrator speaks — a style like "deep male" or a Kokoro id. Empty uses the default.',
  speed: "1.0 is normal. The scene re-times to match the new length.",
  ownImage: "The clip animates from your picture instead of the generated still.",
  transition: "How one scene flows into the next.",
} as const;

/** Glossary — the ? menu renders these; same copy as the tooltips. */
export const GLOSSARY: { term: string; def: string }[] = [
  { term: "Scene", def: TIPS.scene },
  { term: "Still image", def: TIPS.still },
  { term: "Clip", def: TIPS.clip },
  { term: "Narration", def: TIPS.narration },
  { term: "Storyboard", def: TIPS.storyboard },
  { term: "Draft", def: "A fast preview render. It's re-rendered at full quality when you create the final video." },
  { term: "Final", def: "Rendered at full quality. This is what goes in your video." },
  { term: "Rendering", def: "Being generated right now. You can keep working — nothing here blocks you." },
  { term: "Queued", def: "Waiting its turn. Your computer renders one thing at a time." },
  { term: "Seed", def: TIPS.seed },
  { term: "Pin", def: TIPS.pin },
  { term: "Transition", def: "How one scene flows into the next — cut, crossfade, or dip to black." },
  { term: "Captions", def: "On the video: drawn in, always visible. Separate file: a subtitle file viewers can turn off." },
  { term: "Create final video", def: TIPS.createFinal },
  { term: "Open in a pro editor", def: TIPS.proEditor },
];
