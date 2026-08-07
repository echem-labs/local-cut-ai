/**
 * Engine API client. Everything the UI knows about the engine goes through
 * here — HTTP + WS with token auth, never a file path (the same
 * client must work against a remote engine).
 */
import type {
  AudioPeaks,
  Board,
  Checkpoint,
  EditProposal,
  EditResult,
  EngineConnection,
  EngineEtas,
  EngineEvent,
  GraphNode,
  HistoryInfo,
  Job,
  LlmModels,
  ModelDefaults,
  ModelRow,
  Project,
  ProjectTemplate,
  Provider,
  StorageInfo,
  StoryGraph,
  SystemInfo,
  TemplateImport,
  ToolKind,
} from "./types";

/** Marker subprotocol that tells the engine the next offered protocol is the
 * bearer token. Must match WS_TOKEN_SUBPROTOCOL in the engine's api/app.py. */
const WS_TOKEN_SUBPROTOCOL = "localcut.bearer.v1";

/**
 * A non-2xx answer from the engine, carrying the status alongside the
 * message.
 *
 * The message shape (`engine 409: ...`) is unchanged and is still what every
 * `messageOf(err)` shows — this only stops callers who need to BRANCH on the
 * status from having to parse it back out of the prose. The one that needs
 * it is the edit composer: a 409 there means the graph moved under a plan
 * the user is looking at, which is a different outcome from every other
 * refusal and has a different next step.
 */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

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
      throw new EngineError(response.status, `engine ${response.status}: ${detail.slice(0, 300)}`);
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
    model?: string;
  }): Promise<Project> {
    return this.request("/tools", { method: "POST", body: JSON.stringify(body) });
  }

  /** Waveform shape of an audio artifact, computed and cached engine-side
   * — the client never decodes audio itself. 422 = not decodable audio
   * (mock artifacts), 503 = the engine has no ffmpeg; both reject. */
  artifactPeaks(projectId: string, hash: string, bins = 192): Promise<AudioPeaks> {
    return this.request(`/projects/${projectId}/artifacts/${hash}/peaks?bins=${bins}`);
  }

  /** Local models the script tool can offer (engine routing answer). */
  llmModels(): Promise<LlmModels> {
    return this.request("/llm/models");
  }

  /** Rewrite the script from user feedback — a /patch under the hood, so
   * the board flips to rendering through the usual events. */
  enhanceScript(projectId: string, notes: string): Promise<{ dirty: string[] }> {
    return this.request(`/projects/${projectId}/script/enhance`, {
      method: "POST",
      body: JSON.stringify({ notes }),
    });
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

  /** A project's shape as a portable document: no assets, no generated
   * media. The engine names it; the UI only chooses the title text. */
  exportTemplate(id: string, name = "", description = ""): Promise<ProjectTemplate> {
    const query = new URLSearchParams({ name, description }).toString();
    return this.request(`/projects/${id}/template?${query}`);
  }

  /** The import side. `cloud_models` and `dropped_assets` come back so the
   * caller can say what this template will spend and what it left behind
   * BEFORE the first render — the engine surfaces, never blocks. */
  createFromTemplate(template: ProjectTemplate, title = ""): Promise<TemplateImport> {
    return this.request("/projects/from-template", {
      method: "POST",
      body: JSON.stringify({ template, title }),
    });
  }

  regenerate(projectId: string, nodeId: string, seed?: number): Promise<void> {
    return this.request(`/projects/${projectId}/nodes/${nodeId}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ seed: seed ?? null }),
    });
  }

  /** The Story Graph behind the board — nodes AND edges. The flowchart view
   * reads this; nothing else needs it, so it is fetched on demand rather
   * than folded into the board every refresh. */
  graph(projectId: string): Promise<StoryGraph> {
    return this.request(`/projects/${projectId}/graph`);
  }

  patch(
    projectId: string,
    ops: {
      op: string;
      node_id: string;
      params?: Record<string, unknown>;
      seed?: number;
      model?: string | null;
      /** connect/disconnect: `node_id` is the DESTINATION, `src` the
       * upstream node, `port` the input being rewired. */
      src?: string;
      port?: string;
      /** add_node: the whole node. `pinned`/`frozen_hash` are server-owned —
       * patch.py zeroes whatever arrives — but the field carries the
       * engine's Node shape, not a subset of it. */
      node?: GraphNode;
      /** select_take: the recorded take's output hash. */
      take?: string;
      /** add_scene: the scene id to insert after (absent appends). */
      after?: string;
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

  /** Undo/redo stack depths, next-step descriptors and save points. */
  history(projectId: string): Promise<HistoryInfo> {
    return this.request(`/projects/${projectId}/history`);
  }

  undo(projectId: string): Promise<HistoryInfo> {
    return this.request(`/projects/${projectId}/undo`, { method: "POST" });
  }

  redo(projectId: string): Promise<HistoryInfo> {
    return this.request(`/projects/${projectId}/redo`, { method: "POST" });
  }

  createSavepoint(projectId: string, label: string): Promise<HistoryInfo> {
    return this.request(`/projects/${projectId}/savepoints`, {
      method: "POST",
      body: JSON.stringify({ label }),
    });
  }

  restoreSavepoint(projectId: string, savepointId: string): Promise<HistoryInfo> {
    return this.request(`/projects/${projectId}/savepoints/${savepointId}/restore`, {
      method: "POST",
    });
  }

  deleteSavepoint(projectId: string, savepointId: string): Promise<{ ok: boolean }> {
    return this.request(`/projects/${projectId}/savepoints/${savepointId}`, {
      method: "DELETE",
    });
  }

  /** Natural-language edit, compiled and reported but NOT committed: no save, no
   * enqueue, no history entry, no event. The response carries the plan and
   * the graph revision it was built against, which `editApply` takes to
   * land it without a second LLM round trip. */
  proposeEdit(
    projectId: string,
    body: { instruction: string; scope?: string; model?: string },
  ): Promise<EditProposal> {
    return this.request(`/projects/${projectId}/edit`, {
      method: "POST",
      body: JSON.stringify({ ...body, dry_run: true }),
    });
  }

  /** Land a plan a dry run returned. The plan travels back as a client
   * document, which is safe because `compile_edits` re-validates every part
   * of it against the same whitelist it applies to the LLM's own output —
   * the engine trusts the plan no more here than it did there. `revision`
   * is what makes it refuse (409) if the graph moved in between. */
  editApply(
    projectId: string,
    body: { plan: unknown; scope?: string; revision?: string | null },
  ): Promise<EditResult> {
    return this.request(`/projects/${projectId}/edit/apply`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Enqueue whatever the graph still owes, at draft quality — the
   * draft-side counterpart of finalize. An empty /patch does NOT do this:
   * the engine re-plans only when an op dirtied something, so a project
   * whose queue was lost has no other way back into flight. */
  render(projectId: string): Promise<{ enqueued: number }> {
    return this.request(`/projects/${projectId}/render`, { method: "POST" });
  }

  /** Build the publish kit: a thumbnail conditioned on the screenplay plus
   * an LLM title/description/hashtags. Both join the GRAPH as nodes, so
   * they render, cache and regenerate like everything else — the returned
   * ids are where to watch for them on the board. 409 while the script has
   * not rendered: there is nothing to write a title from. */
  package(projectId: string): Promise<{ nodes: string[] }> {
    return this.request(`/projects/${projectId}/package`, { method: "POST" });
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

  /** Render-time medians this engine measured on its own completed jobs.
   * The estimate has to come from the machine that renders, which on a
   * remote engine is not this one. */
  systemEtas(): Promise<{ etas: EngineEtas }> {
    return this.request("/system/etas");
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

  /** Persisted per-task default models (Settings → Models). */
  modelDefaults(): Promise<ModelDefaults> {
    return this.request("/models/defaults");
  }

  /** Set (or clear, with null) the default model for one task. */
  setModelDefault(task: string, model: string | null): Promise<ModelDefaults> {
    return this.request("/models/defaults", {
      method: "PUT",
      body: JSON.stringify({ task, model }),
    });
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
