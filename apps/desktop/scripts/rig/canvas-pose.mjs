/**
 * The graph the flowchart's reference frame is drawn from (plan doc 11, U4).
 *
 * The canvas is the one surface whose whole geometry is a function of the
 * DOCUMENT rather than of the window: every node position comes out of
 * layoutGraph, so a frame of "a real project" would be a frame of whatever
 * the engine happened to plan that day, and the mock could not be drawn
 * against it. So the graph is posed — a two-scene pipeline, small enough to
 * fit one frame whole and wide enough to have all five columns the layered
 * layout produces.
 *
 * This file is the single source for three consumers that must agree:
 *   - parity-canvas.mjs seeds it into the app,
 *   - canvas-mock.html draws it (positions below are layoutGraph's output),
 *   - canvasPose.contract.test.ts recomputes the layout and fails if any of
 *     the numbers here stop being what the app would produce.
 * Change the graph and the contract test tells you what the mock now has to
 * be redrawn to.
 */

const node = (id, kind) => ({
  id,
  kind,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
  frozen_hash: null,
});

/** Two scenes, a music bed, an assembly and an export: the shape every
 * prompt-made project has, at its smallest. */
export const POSE_GRAPH = {
  version: 1,
  nodes: Object.fromEntries(
    [
      ["script", "script"],
      ["music", "music"],
      ["s1.keyframe", "keyframe"],
      ["s1.narration", "narration"],
      ["s2.keyframe", "keyframe"],
      ["s2.narration", "narration"],
      ["s1.clip", "clip"],
      ["s2.clip", "clip"],
      ["timeline", "timeline"],
      ["export", "export"],
    ].map(([id, kind]) => [id, node(id, kind)]),
  ),
  edges: [
    { src: "script", dst: "music", port: "default" },
    { src: "script", dst: "s1.keyframe", port: "default" },
    { src: "script", dst: "s1.narration", port: "default" },
    { src: "script", dst: "s2.keyframe", port: "default" },
    { src: "script", dst: "s2.narration", port: "default" },
    { src: "s1.keyframe", dst: "s1.clip", port: "keyframe" },
    { src: "s2.keyframe", dst: "s2.clip", port: "keyframe" },
    { src: "s1.clip", dst: "timeline", port: "default" },
    { src: "s2.clip", dst: "timeline", port: "clip2" },
    { src: "s1.narration", dst: "timeline", port: "narration" },
    { src: "s2.narration", dst: "timeline", port: "narration2" },
    { src: "music", dst: "timeline", port: "music" },
    { src: "timeline", dst: "export", port: "default" },
  ],
};

/** The node the frame has selected: mid-pipeline, so the chain it lights up
 * runs in both directions and the nodes it dims are on both sides of it. */
export const POSE_SELECTED = "s1.clip";

/** The frame's search query. Three hits, none of them the selection — so the
 * frame shows a match highlight ON a dimmed node, which is the case the two
 * treatments have to stay legible through. */
export const POSE_QUERY = "s2";

/** What layoutGraph puts where, at zoom 1. Written down rather than imported
 * because canvas-mock.html has to hard-code the same numbers and nothing can
 * import a stylesheet — the contract test is what keeps the two honest.
 * Columns are 190 + 84 apart, rows 64 + 26, both offset by a 32px padding. */
export const POSE_LAYOUT = {
  width: 1350,
  height: 488,
  nodes: {
    script: { x: 32, y: 32 },
    music: { x: 306, y: 32 },
    "s1.keyframe": { x: 306, y: 122 },
    "s1.narration": { x: 306, y: 212 },
    "s2.keyframe": { x: 306, y: 302 },
    "s2.narration": { x: 306, y: 392 },
    "s1.clip": { x: 580, y: 32 },
    "s2.clip": { x: 580, y: 122 },
    timeline: { x: 854, y: 32 },
    export: { x: 1128, y: 32 },
  },
};

/** The chain focus the selection produces: everything that feeds s1.clip and
 * everything it feeds. The rest of the graph dims. */
export const POSE_CHAIN = ["script", "s1.keyframe", "s1.clip", "timeline", "export"];

const state = (id, status, over = {}) => ({
  node_id: id,
  status,
  progress: status === "rendering" ? 0.62 : 1,
  error: null,
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
  takes: [],
  ...over,
});

/**
 * The board behind the pose: what each node's render state is.
 *
 * One node mid-render at 62% (the frame bytes never hold still for), stills
 * on the two kinds that can show one, and the assembly still a draft.
 * `artifact_hash` is filled in by the gate once the fixture image has a real
 * hash — the mock draws the same two thumbnails.
 */
export const poseBoard = (keyframeHash = null, clipHash = null) => ({
  scenes: [
    {
      scene_id: "s1",
      keyframe: state("s1.keyframe", "final", { artifact_hash: keyframeHash }),
      clip: state("s1.clip", "final", { artifact_hash: clipHash }),
      narration: state("s1.narration", "final"),
      clip_takes: [],
    },
    {
      scene_id: "s2",
      keyframe: state("s2.keyframe", "rendering"),
      clip: state("s2.clip", "draft"),
      narration: state("s2.narration", "draft"),
      clip_takes: [],
    },
  ],
  aux: {
    music: state("music", "draft"),
    timeline: state("timeline", "draft"),
    export: state("export", "draft"),
    script: state("script", "final"),
  },
});
