/**
 * Engine API client. Everything the UI knows about the engine goes through
 * here — HTTP + WS with token auth, never a file path (the same
 * client must work against a remote engine).
 */
import type {
  Board,
  Checkpoint,
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
    ops: { op: string; node_id: string; params?: Record<string, unknown> }[],
  ): Promise<{ dirty: string[] }> {
    return this.request(`/projects/${projectId}/patch`, {
      method: "POST",
      body: JSON.stringify({ ops }),
    });
  }

  finalize(projectId: string): Promise<{ enqueued: number }> {
    return this.request(`/projects/${projectId}/finalize`, { method: "POST" });
  }

  listJobs(projectId?: string): Promise<Job[]> {
    return this.request(`/jobs${projectId ? `?project_id=${projectId}` : ""}`);
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

  // Key writes go through the shell (keychain persistence + PUT from the
  // main process); the renderer only ever reads provider status.
  listProviders(): Promise<Provider[]> {
    return this.request("/providers");
  }

  artifactUrl(projectId: string, hash: string): string {
    return `${this.connection.url}/projects/${projectId}/artifacts/${hash}?token=${this.connection.token}`;
  }

  /** Subscribe to engine events; returns an unsubscribe function. */
  subscribe(onEvent: (event: EngineEvent) => void, onDrop?: () => void): () => void {
    const wsUrl = this.connection.url.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsUrl}/ws?token=${this.connection.token}`);
    socket.onmessage = (message) => onEvent(JSON.parse(message.data) as EngineEvent);
    if (onDrop) socket.onclose = onDrop;
    return () => {
      socket.onclose = null;
      socket.close();
    };
  }
}
