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
}

export type NodeStatus = "queued" | "rendering" | "draft" | "final" | "failed" | "pinned";

export interface NodeState {
  node_id: string;
  status: NodeStatus;
  progress: number;
  error: string | null;
  artifact_hash: string | null;
  params: Record<string, unknown>;
  seed: number;
}

export interface SceneCardModel {
  scene_id: string;
  keyframe: NodeState;
  clip: NodeState;
  narration: NodeState;
}

export interface Board {
  scenes: SceneCardModel[];
  aux: Record<string, NodeState>;
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
    ram_gb: number;
    gpus: HardwareGPU[];
    tier: "S" | "A" | "B" | "C";
  };
  recommendations: {
    task: string;
    model: { id: string; license: { id: string; verdict: string } } | null;
    reason: string;
  }[];
  backend_mode: string;
}

export interface Job {
  id: string;
  project_id: string;
  status: "queued" | "rendering" | "done" | "failed" | "cancelled";
  progress: number;
  error: string | null;
  spec: { node_id: string; kind: string };
}

export type EngineEvent =
  | { type: "job.started"; job_id: string; node_id: string }
  | { type: "job.progress"; job_id: string; node_id: string; progress: number }
  | { type: "job.done"; job_id: string; node_id: string; artifact: string }
  | { type: "job.failed"; job_id: string; node_id: string; error: string; suggestions?: string[] }
  | { type: "job.retrying"; job_id: string; node_id: string; attempt: number }
  | { type: "project.compiled"; project_id: string; enqueued: number }
  | { type: "project.expanded"; project_id: string; scenes: string[] };
