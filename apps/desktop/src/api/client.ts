/**
 * Engine API client. Everything the UI knows about the engine goes through
 * here — HTTP + WS with token auth, never a file path (the same
 * client must work against a remote engine).
 */
import type { Board, EngineConnection, EngineEvent, Job, Project, SystemInfo } from "./types";

export class EngineClient {
  constructor(private readonly connection: EngineConnection) {}

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
      const detail = await response.text().catch(() => "");
      throw new Error(`engine ${response.status}: ${detail.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  createProject(body: {
    prompt: string;
    target_duration_s?: number;
    aspect?: string;
    style_preset?: string;
  }): Promise<Project> {
    return this.request("/projects", { method: "POST", body: JSON.stringify(body) });
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
