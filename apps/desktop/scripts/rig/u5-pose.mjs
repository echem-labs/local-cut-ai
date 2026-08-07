/**
 * The single source for U5's posed state — imported by the parity driver and
 * mirrored by the mock.
 *
 * Everything here has to be posed rather than produced. `nodeFailures` lives
 * only on the websocket (the scheduler computes `suggestions` when it
 * publishes and persists nothing), so there is no project a rig could open
 * that puts the failure card on screen: you would have to exhaust a real
 * GPU's memory on demand. The model rows behind the "Use X" chip are the
 * same story — which model the chip names is a function of what is
 * installed, and a reference frame cannot depend on this machine's library.
 */

/** The node the frame is about: a clip whose render gave up. */
export const POSE_NODE = "s1.clip";

/** The failed job, so `modelThatFailed` resolves to a model in POSE_MODELS
 * and the chip can name the one it would drop to. */
export const POSE_JOBS = [
  {
    id: "job-oom",
    project_id: "pose",
    status: "failed",
    progress: 0,
    error: "out of memory after 2 fallback attempts",
    created_at: 1_700_000_000,
    started_at: 1_700_000_000,
    finished_at: 1_700_000_060,
    model: "wan-2.2-i2v-a14b",
    spec: { node_id: POSE_NODE, kind: "clip" },
  },
];

/** Two installed video models, so exactly one is "smaller than the one that
 * failed" and the chip's label is deterministic. `quality_score` decides
 * which of several smaller ones wins, so both are pinned. */
export const POSE_MODELS = [
  {
    id: "wan-2.2-i2v-a14b",
    task: "video.i2v",
    family: "wan",
    version: "2.2",
    quant: "fp8",
    requirements: { vram_gb: 24, ram_gb: 32, disk_gb: 30, backends: ["comfyui"] },
    quality_score: 9,
    speed_score: 3,
    license: { id: "apache-2.0", name: "Apache 2.0", commercial: true, url: "" },
    files: [],
    comfy_graph_template: "",
    custom: false,
    size_bytes: 30_000_000_000,
    downloaded: true,
    downloading: false,
    progress: null,
    partial_bytes: 0,
  },
  {
    id: "ltx-video-2b",
    task: "video.i2v",
    family: "ltx",
    version: "0.9",
    quant: "fp16",
    requirements: { vram_gb: 8, ram_gb: 16, disk_gb: 10, backends: ["comfyui"] },
    quality_score: 6,
    speed_score: 8,
    license: { id: "apache-2.0", name: "Apache 2.0", commercial: true, url: "" },
    files: [],
    comfy_graph_template: "",
    custom: false,
    size_bytes: 10_000_000_000,
    downloaded: true,
    downloading: false,
    progress: null,
    partial_bytes: 0,
  },
];

/** What the engine said when the ladder ran out. All three codes, because
 * the frame's job is to prove all three render — including the one this
 * machine cannot act on. */
export const POSE_FAILURE = {
  [POSE_NODE]: {
    error: "out of memory after 2 fallback attempts: CUDA out of memory",
    suggestions: ["lower_resolution", "smaller_model", "cloud"],
  },
};

const node = (id, status, extra = {}) => ({
  node_id: id,
  status,
  progress: status === "rendering" ? 0.42 : status === "failed" ? 0 : 1,
  error: status === "failed" ? "out of memory after 2 fallback attempts: CUDA out of memory" : null,
  artifact_hash: status === "failed" ? null : "a".repeat(64),
  params: {},
  seed: 4242,
  model: null,
  pinned: false,
  ...extra,
});

/** One scene, its clip failed and selected. Deliberately small: the frame is
 * the inspector, and every extra scene only changes what is behind it. */
export function poseBoard() {
  return {
    scenes: [
      {
        scene_id: "s1",
        keyframe: node("s1.keyframe", "draft"),
        clip: node(POSE_NODE, "failed"),
        narration: node("s1.narration", "draft"),
      },
    ],
    aux: {
      script: node("script", "draft"),
      timeline: node("timeline", "queued"),
      export: node("export", "queued"),
    },
    assembled_durations: { s1: 8 },
  };
}
