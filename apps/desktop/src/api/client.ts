/**
 * Engine API client. Everything the UI knows about the engine goes through
 * here — HTTP + WS with token auth, never a file path (the same
 * client must work against a remote engine).
 */
import type {
  Board,
  Checkpoint,
  EditResult,
  EngineConnection,
  EngineEvent,
  Job,
  ModelRow,
  Project,
  Provider,
  SystemInfo,
  ToolKind,
} from "./types";

export class EngineClient {
  constructor(private readonly connection: EngineConnection) {}

  get baseUrl(): string {
    return this.connection.url;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.connection.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.connection.token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        // FastAPI errors are {"detail": "..."} — surface the message, not
        // the JSON envelope.
        const parsed = JSON.parse(text) as { detail?: unknown };
        if (typeof parsed.detail === "string") detail = parsed.detail;
      } catch {
        /* not JSON — use the raw body */
      }
      throw new Error(`engine ${response.status}: ${detail.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  createProject(body: {
    prompt: string;
    target_duration_s?: number;
    aspect?: string;
    style_preset?: string;
    mode?: "prompt" | "beginner";
  }): Promise<Project> {
    return this.request("/projects", { method: "POST", body: JSON.stringify(body) });
  }

  createTool(body: {
    tool: ToolKind;
    prompt?: string;
    text?: string;
    voice?: string;
    aspect?: string;
    target_duration_s?: number;
    motion?: string;
    duration_s?: number;
  }): Promise<Project> {
    return this.request("/tools", { method: "POST", body: JSON.stringify(body) });
  }

  promote(projectId: string): Promise<Project> {
    return this.request(`/projects/${projectId}/promote`, { method: "POST" });
  }

  approve(projectId: string, checkpoint: Checkpoint): Promise<{ enqueued: number }> {
    return this.request(`/projects/${projectId}/approve`, {
      method: "POST",
      body: JSON.stringify({ checkpoint }),
    });
  }

  listProjects(): Promise<Project[]> {
    return this.request("/projects");
  }

  getProject(id: string): Promise<{ project: Project; board: Board }> {
    return this.request(`/projects/${id}`);
  }

  regenerate(projectId: string, nodeId: string, seed?: number): Promise<void> {
    return this.request(`/projects/${projectId}/nodes/${nodeId}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ seed: seed ?? null }),
    });
  }

  patch(
    projectId: string,
    ops: {
      op: string;
      node_id: string;
      params?: Record<string, unknown>;
      seed?: number;
      model?: string | null;
    }[],
  ): Promise<{ dirty: string[] }> {
    return this.request(`/projects/${projectId}/patch`, {
      method: "POST",
      body: JSON.stringify({ ops }),
    });
  }

  /** Upload a user asset (raw bytes — API-pure). Voice samples must carry
   * the consent affirmation or the engine refuses them. */
  async uploadAsset(
    projectId: string,
    file: File,
    options?: { consent?: boolean },
  ): Promise<{ node_id: string; hash: string; name: string }> {
    const consent = options?.consent ? "&consent=true" : "";
    return this.request(
      `/projects/${projectId}/assets?filename=${encodeURIComponent(file.name)}${consent}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      },
    );
  }

  /** Natural-language edit; scope is "project" or a scene id. */
  edit(
    projectId: string,
    body: { instruction: string; scope?: string; model?: string },
  ): Promise<EditResult> {
    return this.request(`/projects/${projectId}/edit`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  finalize(projectId: string): Promise<{ enqueued: number }> {
    return this.request(`/projects/${projectId}/finalize`, { method: "POST" });
  }

  listJobs(projectId?: string): Promise<Job[]> {
    return this.request(`/jobs${projectId ? `?project_id=${projectId}` : ""}`);
  }

  /** Stop a queued or running render (409 once it's already finished). */
  cancelJob(jobId: string): Promise<{ ok: boolean }> {
    return this.request(`/jobs/${jobId}/cancel`, { method: "POST" });
  }

  system(): Promise<SystemInfo> {
    return this.request("/system");
  }

  listModels(): Promise<ModelRow[]> {
    return this.request("/models");
  }

  startDownload(modelId: string): Promise<{ status: "started" | "downloading" | "downloaded" }> {
    return this.request(`/models/${encodeURIComponent(modelId)}/download`, { method: "POST" });
  }

  cancelDownload(modelId: string): Promise<{ ok: boolean }> {
    return this.request(`/models/${encodeURIComponent(modelId)}/download`, { method: "DELETE" });
  }

  deleteModel(modelId: string): Promise<{ ok: boolean; freed_bytes: number }> {
    return this.request(`/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
  }

  // Key writes go through the shell (keychain persistence + PUT from the
  // main process); the renderer only ever reads provider status.
  listProviders(): Promise<Provider[]> {
    return this.request("/providers");
  }

  artifactUrl(projectId: string, hash: string): string {
    return `${this.connection.url}/projects/${projectId}/artifacts/${hash}?token=${this.connection.token}`;
  }

  /** Pro-NLE handoff downloads (409 while the timeline hasn't rendered). */
  exportUrl(projectId: string, kind: "otio" | "fcpxml"): string {
    return `${this.connection.url}/projects/${projectId}/export/${kind}?token=${this.connection.token}`;
  }

  /** Subscribe to engine events; returns an unsubscribe function. */
  subscribe(onEvent: (event: EngineEvent) => void, onDrop?: () => void): () => void {
    const wsUrl = this.connection.url.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsUrl}/ws?token=${this.connection.token}`);
    socket.onmessage = (message) => {
      // A non-JSON frame (a proxy keepalive, a truncated message) must not
      // throw an uncaught SyntaxError out of the event handler.
      let event: EngineEvent;
      try {
        event = JSON.parse(message.data) as EngineEvent;
      } catch {
        console.warn("engine sent a non-JSON WS frame; ignoring");
        return;
      }
      onEvent(event);
    };
    if (onDrop) socket.onclose = onDrop;
    return () => {
      socket.onclose = null;
      socket.close();
    };
  }
}
