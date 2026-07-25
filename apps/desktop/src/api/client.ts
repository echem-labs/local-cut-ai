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
  StorageInfo,
  SystemInfo,
  ToolKind,
} from "./types";

/** Marker subprotocol that tells the engine the next offered protocol is the
 * bearer token. Must match WS_TOKEN_SUBPROTOCOL in the engine's api/app.py. */
const WS_TOKEN_SUBPROTOCOL = "localcut.bearer.v1";

export class EngineClient {
  constructor(private readonly connection: EngineConnection) {}

  get baseUrl(): string {
    return this.connection.url;
  }

  private async request<T>(path: string, init?: RequestInit, timeoutMs = 120_000): Promise<T> {
    // Bound every request: a half-open remote engine (accepts the socket, never
    // responds) would otherwise leave the promise pending forever and wedge the
    // establish/reconnect state machine with no recovery but an app restart.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(`${this.connection.url}${path}`, {
      ...init,
      signal,
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

  deleteProject(id: string): Promise<{ ok: boolean }> {
    return this.request(`/projects/${id}`, { method: "DELETE" });
  }

  renameProject(id: string, title: string): Promise<Project> {
    return this.request(`/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  }

  duplicateProject(id: string): Promise<Project> {
    return this.request(`/projects/${id}/duplicate`, { method: "POST" });
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

  finalize(projectId: string, clipModel?: string | null): Promise<{ enqueued: number }> {
    return this.request(`/projects/${projectId}/finalize`, {
      method: "POST",
      body: JSON.stringify({ clip_model: clipModel ?? null }),
    });
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

  addCustomModel(body: {
    name: string;
    task: string;
    source: "url" | "file";
    ref: string;
    vram_gb?: number;
    workflow_template?: string;
  }): Promise<ModelRow> {
    return this.request("/models/custom", { method: "POST", body: JSON.stringify(body) });
  }

  deleteCustomModel(modelId: string): Promise<{ ok: boolean; freed_bytes: number }> {
    return this.request(`/models/custom/${encodeURIComponent(modelId)}`, { method: "DELETE" });
  }

  health(): Promise<{ ok: boolean; engine_version: string; api_version: number }> {
    return this.request("/health");
  }

  storage(): Promise<StorageInfo> {
    return this.request("/storage");
  }

  storageCleanup(): Promise<{ ok: boolean; freed_bytes: number }> {
    return this.request("/storage/cleanup", { method: "POST" });
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
    // The token rides as a WebSocket subprotocol, not `?token=`: a query
    // string ends up in the engine's own log line for the handshake (uvicorn
    // logs it at INFO), and from there in journald, Docker logs, and any log
    // a user attaches to a bug report. Browsers can't set headers on a
    // WebSocket, so the subprotocol list is the only header-ish channel.
    // The engine echoes WS_TOKEN_SUBPROTOCOL back to complete the handshake.
    const socket = new WebSocket(`${wsUrl}/ws`, [WS_TOKEN_SUBPROTOCOL, this.connection.token]);
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
