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
  | "pinned";

export interface NodeState {
  node_id: string;
  status: NodeStatus;
  progress: number;
  error: string | null;
  artifact_hash: string | null;
  params: Record<string, unknown>;
  seed: number;
  model: string | null;
  pinned: boolean;
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

export interface Job {
  id: string;
  project_id: string;
  status: "queued" | "rendering" | "done" | "failed" | "cancelled";
  progress: number;
  error: string | null;
  created_at: number;
  spec: { node_id: string; kind: string };
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
  | { type: "project.renamed"; project_id: string; title: string }
  // done/total are bytes across the whole model, throttled to ~0.5s.
  | { type: "model.download.progress"; model: string; file: string; done: number; total: number }
  | { type: "model.download.done"; model: string }
  | { type: "model.download.failed"; model: string; error: string }
  | { type: "model.download.cancelled"; model: string };
