/** Mirrors of the engine API's read models. */

export interface EngineConnection {
  url: string;
  token: string;
}

export interface Project {
  id: string;
  title: string;
  created_at: number;
  mode: string;
  approvals: string[];
  // Home-grid read model (review 4) — denormalized engine-side; all
  // optional so old metas stay valid.
  updated_at?: number | null;
  thumb_hash?: string | null;
  aspect?: string | null;
  duration_s?: number | null;
  // Quick tool sessions: the finished artifact of the session's own node.
  // The durable answer to "did this finish?" — /jobs only carries the newest
  // 200 rows across every project, so an old session's are long gone.
  tool_artifact_hash?: string | null;
  // Promotion provenance. Advisory both ways: either side can be deleted and
  // nothing rewrites the survivor, so an id that no longer resolves against
  // the project list means "no link", not "broken".
  promoted_to?: string[] | null;   // on a script session: the videos made
  promoted_from?: string | null;   // on a video: the session it came from
}

export type ToolKind = "script" | "thumbnail" | "voiceover" | "image" | "music" | "clip";

export type Checkpoint = "script" | "storyboard";

export interface ScreenplayScene {
  id: string;
  duration_s: number;
  narration: string;
  visual: string;
  motion: string;
  onscreen_text: string | null;
}

export interface Screenplay {
  title: string;
  hook: string;
  scenes: ScreenplayScene[];
}

export type NodeStatus =
  | "queued"
  | "rendering"
  | "draft"
  | "final"
  | "failed"
  | "cancelled"
  | "pinned"
  // Deliberately not rendered: the compiler skips a node that feeds nothing,
  // e.g. the keyframe of a scene conditioned on an uploaded image. Mirrors
  // SCENE_NODE_STATUSES in the engine — test_ui_contract compares the two.
  | "skipped";

/** A non-fatal signal from a job that finished — `error` means it did not.
 * The code is an id (mirrors NOTICE_CODES in the engine's notices.py;
 * test_ui_contract compares it against the notices.json catalog) and `data`
 * carries the numbers the catalog message interpolates. */
export interface NodeNotice {
  code: string;
  data: Record<string, string | number>;
}

/** One alternate take of a node — a prior identity a regenerate displaced
 * (distinct from a split scene's sequential `clip_takes`). Selecting one is
 * a metadata swap onto an artifact already on disk when `available`. */
export interface TakeInfo {
  output_hash: string;
  seed: number;
  /** The model this take was rendered with. Selecting a take restores its
   * whole identity, model included — so a `cloud:*` take re-renders on the
   * user's BYOK key. The picker has to say so before it is clicked. */
  model: string | null;
  /** Recorded time; null for the live identity's synthetic row. */
  at: number | null;
  available: boolean;
  current: boolean;
}

export interface NodeState {
  node_id: string;
  status: NodeStatus;
  progress: number;
  error: string | null;
  /** Absent on engines older than the field. */
  notices?: NodeNotice[];
  artifact_hash: string | null;
  params: Record<string, unknown>;
  seed: number;
  model: string | null;
  pinned: boolean;
  /** Present only once the node has recorded takes. */
  takes?: TakeInfo[];
}

/** The Story Graph itself, as GET /projects/{id}/graph returns it.
 *
 * The board is a *view* of this graph shaped for the storyboard — scenes with
 * slots, aux nodes by name. The flowchart view needs the graph underneath:
 * the board cannot express an edge, and an edge is the thing a node canvas
 * exists to show and rewire. Mirrors StoryGraph in graph/model.py. */
export interface GraphNode {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  seed: number;
  model: string | null;
  pinned: boolean;
  frozen_hash: string | null;
}

export interface GraphEdge {
  src: string;
  dst: string;
  /** The named input on `dst`. One edge per port — connecting replaces. */
  port: string;
}

export interface StoryGraph {
  version: number;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
}

export interface SceneCardModel {
  scene_id: string;
  // keyframe/narration can be removed via remove_node patches; clip never is.
  keyframe: NodeState | null;
  clip: NodeState;
  narration: NodeState | null;
  // Sequential takes of a split scene, beyond the first clip.
  clip_takes?: (NodeState | null)[];
}

export interface Board {
  scenes: SceneCardModel[];
  aux: Record<string, NodeState>;
  /** Per-scene seconds from the assembled cut — absent until a timeline
   * exists (and on engines older than this field). */
  assembled_durations?: Record<string, number>;
}

export interface HardwareGPU {
  vendor: string;
  name: string;
  vram_gb: number;
  backend: string;
}

export interface SystemInfo {
  hardware: {
    os: string;
    arch: string;
    ram_gb: number;
    disk_free_gb: number;
    gpus: HardwareGPU[];
    primary_gpu: HardwareGPU | null;
    tier: "S" | "A" | "B" | "C";
  };
  recommendations: {
    task: string;
    model: ModelEntry | null;
    reason: string;
  }[];
  backend_mode: string;
  /** Resolved per-task routing — absent on engines older than this field. */
  backends?: {
    chain: string[];
    comfy_kinds_auto: boolean;
    tasks: BackendTask[];
  };
}

export interface BackendTask {
  kind: string;
  backend: string | null;
  installed_models: string[];
}

export type LicenseVerdict = "commercial" | "conditions" | "personal-only";

export interface ModelLicense {
  id: string;
  commercial: boolean;
  verdict: LicenseVerdict;
  notes: string;
}

export interface ModelFile {
  url: string;
  dest: string;
  sha256: string;
  size: number;
}

/** One manifest entry, as embedded in /system recommendations. */
export interface ModelEntry {
  id: string;
  task: string;
  family: string;
  version: string;
  quant: string;
  requirements: { vram_gb: number; ram_gb: number; disk_gb: number; backends: string[] };
  quality_score: number;
  speed_score: number;
  license: ModelLicense;
  // Empty = nothing to download; the model is served externally (e.g. Ollama).
  files: ModelFile[];
  comfy_graph_template: string;
  /** User-added entry (outside the curated catalog): neutral "custom" tag
   * and a license self-ack badge instead of curated verdicts. */
  custom: boolean;
}

/** A /models row: manifest entry plus live install state. */
export interface ModelRow extends ModelEntry {
  size_bytes: number;
  downloaded: boolean;
  downloading: boolean;
  progress: { done: number; total: number } | null;
  /** Resumable bytes on disk for an interrupted, not-currently-running
   * download (completed files + .part remnants); 0 otherwise. */
  partial_bytes: number;
}

export type ProviderId = "anthropic" | "openai" | "google" | "fal";

export interface Provider {
  id: ProviderId;
  label: string;
  capabilities: string[];
  configured: boolean;
}

/** POST /projects/:id/edit — what the LLM's plan actually did. */
export interface EditResult {
  summary: string;
  ops: number;
  dirty: string[];
  warnings: string[];
}

/** What the next undo/redo step would revert — mirrors SNAPSHOT_KINDS in
 * the engine's project/store.py (test_ui_contract compares the kinds
 * against the historyKinds catalog). */
export interface HistoryDescriptor {
  kind: string;
  summary: string | null;
  node_id: string | null;
}

export interface SavePointInfo {
  id: string;
  label: string;
  at: number;
}

/** GET /projects/:id/history — depths and descriptors, never snapshots. */
export interface HistoryInfo {
  undo_depth: number;
  redo_depth: number;
  undo_top: HistoryDescriptor | null;
  redo_top: HistoryDescriptor | null;
  savepoints: SavePointInfo[];
}

/** GET/PUT /models/defaults — persisted per-task default models. `tasks`
 * lists the tasks the engine honors; the picker renders only those. */
export interface ModelDefaults {
  defaults: Record<string, string>;
  tasks: string[];
}

export interface Job {
  id: string;
  project_id: string;
  status: "queued" | "rendering" | "done" | "failed" | "cancelled";
  progress: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** The model the backend reported actually using (null when the backend
   * has no meaningful model name — assembly, mock). */
  model: string | null;
  spec: { node_id: string; kind: string };
}

/** GET /llm/models — what the script tool's model picker can offer.
 * `available` is the engine's routing answer, not just server liveness. */
export interface LlmModels {
  available: boolean;
  default: string;
  models: string[];
}

/** GET /storage — Settings → Storage. */
export interface StorageInfo {
  projects: { id: string; title: string; bytes: number }[];
  models_bytes: number;
  cache_bytes: number;
  disk_free_bytes: number;
  disk_total_bytes: number;
}

export type EngineEvent =
  // job.* events carry project_id so a subscriber (the WS is a global stream)
  // can drop events for a project it isn't viewing — node ids like "timeline"
  // exist in every project and would otherwise cross-contaminate the board.
  | { type: "job.started"; job_id: string; node_id: string; project_id: string }
  | { type: "job.progress"; job_id: string; node_id: string; progress: number; project_id: string }
  | { type: "job.done"; job_id: string; node_id: string; artifact: string; project_id: string }
  | {
      type: "job.failed";
      job_id: string;
      node_id: string;
      error: string;
      suggestions?: string[];
      project_id: string;
    }
  | { type: "job.retrying"; job_id: string; node_id: string; attempt: number; project_id: string }
  | { type: "project.compiled"; project_id: string; enqueued: number }
  | { type: "project.expanded"; project_id: string; scenes: string[] }
  | { type: "project.edited"; project_id: string; ops: number; summary: string }
  // An undo/redo or save point restore replaced the graph wholesale.
  | { type: "project.restored"; project_id: string; direction: string }
  | { type: "project.renamed"; project_id: string; title: string }
  // A post-completion hook failed — most often a screenplay the expander
  // could not apply. The job itself succeeded, so nothing else reports it.
  | { type: "project.error"; project_id: string; node_id: string; error: string }
  | { type: "project.deleted"; project_id: string }
  // done/total are bytes across the whole model, throttled to ~0.5s.
  | { type: "model.download.progress"; model: string; file: string; done: number; total: number }
  | { type: "model.download.done"; model: string }
  | { type: "model.download.failed"; model: string; error: string }
  | { type: "model.download.cancelled"; model: string };
