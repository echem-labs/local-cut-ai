import { create } from "zustand";
import { EngineClient, EngineTimeoutError } from "./api/client";
import { t } from "./i18n";
import { forgetEditLog } from "./lib/editlog";
import { messageOf } from "./lib/errors";
import { forgetPublishDraft } from "./lib/publishDraft";
import { setEngineEtas } from "./lib/eta";
import { nextNodeId } from "./lib/graphIds";
import { modelThatFailed, nextResolutionScale, smallerModelFor } from "./lib/oom";
import { blockingGaps, readinessFingerprint } from "./lib/readiness";
import { usePlayback } from "./lib/playback";
import {
  loadTemplates,
  refuseReason,
  saveTemplates,
  TEMPLATE_LIMIT,
  type TemplateEntry,
} from "./lib/templates";
import type {
  Board,
  Checkpoint,
  EditProposal,
  EditResult,
  EngineCrash,
  EngineEvent,
  HistoryInfo,
  InstalledWorkflow,
  Job,
  ModelDefaults,
  ModelRow,
  NodePacks,
  NodeState,
  OomFallback,
  Project,
  ReadinessRow,
  StorageInfo,
  StoryGraph,
  SystemInfo,
  ToolKind,
} from "./api/types";

/** Key ids as the shell stores them — note google's key is `gemini`. */
export type ProviderKeyId = "anthropic" | "openai" | "gemini" | "fal";

/** The Library's split: a video is a project, a tool output is one
 * artifact. Same tiles, same status oracle — the filter is the only thing
 * that separates them (plan doc 11, U2). */
export type LibraryFilter = "all" | "videos" | "tools";

/** What the shell tells the renderer about stored keys — presence only,
 * never the key material itself. */
export interface ProviderKeyPresence {
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
  fal: boolean;
  // false = safeStorage found no OS keychain; keys are merely obfuscated.
  encrypted: boolean;
}

/** A pairing code decoded but NOT acted on, so the user can see the host
 * before anything is sent to it. A code is an opaque blob; without this the
 * only way to learn what it names is to accept it. */
export interface PairingPreview {
  ok: boolean;
  error: string | null;
  host?: string;
  url?: string;
  /** Colon-grouped SHA-256 of the engine's certificate, to read back against
   * what the GPU box printed. Null for a loopback/SSH-forwarded pairing. */
  fingerprint?: string | null;
  /** Which provider keys are stored and would be sent if armed. */
  keys?: ProviderKeyPresence;
}

declare global {
  interface Window {
    localcut: {
      getEngineConnection: () => Promise<{
        connection: { url: string; token: string } | null;
        error: string | null;
        /** A crash this renderer was not alive to be told about. */
        crash?: EngineCrash | null;
        remote?: boolean;
        remotePaired?: boolean;
        keysArmed?: boolean;
      }>;
      inspectPairing: (code: string) => Promise<PairingPreview>;
      pairEngine: (
        code: string,
        options?: { armKeys?: boolean },
      ) => Promise<{ ok: boolean; error: string | null; keysArmed?: boolean }>;
      unpairEngine: () => Promise<{ ok: boolean; error: string | null }>;
      armProviderKeys: () => Promise<{ ok: boolean; error: string | null }>;
      setProviderKeys: (
        keys: Partial<Record<ProviderKeyId, string>>,
      ) => Promise<{ presence: ProviderKeyPresence; error: string | null }>;
      getProviderKeyPresence: () => Promise<ProviderKeyPresence>;
      clearProviderKey: (
        id: ProviderKeyId,
      ) => Promise<{ presence: ProviderKeyPresence; error: string | null }>;
      setTitleBarTheme: (theme: "dark" | "light") => Promise<void>;
      getSystemTextScale: () => Promise<number>;
      setUiZoom: (factor: number) => void;
      /** Start the engine again after it stopped without being asked to.
       * Optional: an older preload has no such channel, and the banner that
       * calls it must degrade rather than throw. */
      restartEngine?: () => Promise<{ ok: boolean; error: string | null }>;
      /** Subscribe to engine crashes; returns its own unsubscribe. */
      onEngineCrash?: (listener: (crash: EngineCrash) => void) => () => void;
      /** Taskbar/dock bar and window title. `fraction` below 0 clears the
       * bar; an empty title restores the app's own. */
      setShellProgress?: (progress: {
        fraction: number;
        title: string;
      }) => Promise<{ ok: boolean; error: string | null }>;
      /** Raise an OS notification, if the window is not already in front.
       * `shown` reports whether it actually appeared. */
      notifyDone?: (notice: {
        title: string;
        body: string;
      }) => Promise<{ ok: boolean; shown?: boolean; error: string | null }>;
      /** About → Support. Neither takes a path or a URL: the shell owns
       * which folder is opened and which feed is fetched. */
      openLogsFolder: () => Promise<{ ok: boolean; error: string | null }>;
      exportSupportBundle: (report: {
        versions: unknown;
        system: unknown;
      }) => Promise<{ path: string | null; error: string | null }>;
      checkForUpdates: () => Promise<{
        latest: string | null;
        url: string | null;
        error: string | null;
      }>;
      /** False until a release feed is configured — About hides the check
       * rather than offering one that can only ever fail. */
      updatesConfigured?: boolean;
      /** Dev-only rig affordance; absent (undefined) in packaged builds. */
      seedHookEnabled?: boolean;
    };
    /** Installed by the store when the shell says the rig is driving —
     * see installSeedHook below for what it may write and why. */
    __localcutSeed?: (patch: SeedPatch) => void;
  }
}

/** What the rig may inject: a hardware fixture and a model-catalog
 * fixture, plus `freeze` to stop live refreshes from overwriting them —
 * that is what makes states like "downloading · 51%" hold still long
 * enough to screenshot. */
export interface SeedPatch {
  system?: SystemInfo;
  models?: ModelRow[];
  /** Home and the Library are lists — a reference frame of either needs the
   * list posed, not just the hardware behind it. */
  projects?: Project[];
  allJobs?: Job[];
  /** The rail's Open group. Restored tabs are pruned against whatever the
   * engine answered with first, so a frame that seeds `projects` has to
   * pose this too or the group is simply missing. */
  openProjects?: string[];
  /** The open session's board and job slice (U3): "rendering · 42%" is a
   * frame bytes never hold still for, exactly like the download bars. The
   * session is opened for real first; this poses the node states inside
   * it, and `freeze` keeps refreshBoard from writing the truth back. */
  board?: Board;
  jobs?: Job[];
  /** The flowchart's graph and its selection (U4). The canvas is the one
   * surface whose entire geometry is a function of the document rather than
   * of the window, so its reference frame needs the exact graph posed — a
   * real project's graph is whatever the engine planned that day, and the
   * mock cannot be drawn against "whatever". */
  graph?: StoryGraph;
  selectedNode?: string | null;
  /** What the engine said about a failed or retrying node (U5). These live
   * ONLY on the websocket — the scheduler computes `suggestions` when it
   * publishes and persists nothing — so there is no project a rig could
   * open that would put the failure card on screen. Posing them is the only
   * way to photograph it. */
  nodeFailures?: Record<string, { error: string; suggestions: string[] }>;
  nodeRetries?: Record<string, { attempt: number; fallback: OomFallback }>;
  freeze?: boolean;
}

/** A failed user action, tagged so the screen that started it can show
 * the message next to its own button. */
export interface ActionError {
  // `board` is the scope for a project-level action fired from somewhere with
  // no surface of its own — the command palette, which can run resume and
  // prepare-publish from any screen. Every other scope belongs to the one
  // component that raises it and renders it.
  scope: "create" | "tool" | "promote" | "approve" | "enhance" | "open" | "board";
  message: string;
}

/** Baseline for new videos (Settings → Defaults). Home's live changes
 * overwrite it — Premiere's remember-last behavior. */
export interface HomeDefaults {
  aspect: string;
  duration: number;
  /** The look the engine writes the shot prompts for. The engine takes any
   * string and defaults to "cinematic"; the UI offers a curated list. */
  style: string;
  mode: "prompt" | "beginner";
  voice: string;
  /** Applied at Create-final-video time (finalize clip model). */
  videoModel: string | null;
}

/** The Home composer's unsent draft — survives Settings round-trips and
 * restarts; cleared on a successful generate. */
export interface HomeDraft {
  prompt: string;
  tool: ToolKind | null;
  toolInput: string;
  /** This video's format, look and run mode — `null` means "whatever the
   * saved default is". They live here rather than in `defaults` because the
   * prompt row composes ONE video: writing them through made every pick
   * permanent, so a single anime video re-aimed every later one and one
   * click on Auto retired the review checkpoints for good. Settings →
   * Defaults is the one place a baseline is set; these are cleared on a
   * successful generate, like the prompt above them. */
  aspect: string | null;
  duration: number | null;
  style: string | null;
  mode: "prompt" | "beginner" | null;
  voice: string;
  /** An exact pack voice, picked rather than described. Outranks
   * `voice` at render, so the two are shown together and the picked
   * one is what a preview plays. Null is the ordinary state: most
   * voiceovers are asked for by brief. */
  voiceId: string | null;
  motion: string;
  /** Script tool's model pick; "" = the engine's configured default. */
  scriptModel: string;
  /** Per-tool aspect (script/thumbnail/image/clip panels). Separate from
   * the video defaults on purpose: a 9:16 thumbnail experiment must not
   * silently re-aim the next full video. */
  toolAspect: string;
  /** Script/music target length, seconds. */
  toolDuration: number;
  /** Clip take length; clamped to TOOL_CLIP_SECONDS before it travels. */
  clipSeconds: number;
}

interface AppState {
  client: EngineClient | null;
  engineError: string | null;
  /** Set when the engine stopped without being asked to. Distinct from
   * `engineError`, which also covers "not started yet" and "restarting" —
   * a crash has a report to copy and a button that fixes it. */
  engineCrash: EngineCrash | null;
  /** Whether a finished render may raise an OS notification. On by default,
   * and only ever shown while the window is unfocused. */
  notifyOnDone: boolean;
  /** Whether an explicit render click warns first when a needed model is
   * missing (the readiness gate). On by default; "Always" in the dialog and
   * the Settings row both flip this one flag. */
  warnMissingModels: boolean;
  /** Machine-scoped readiness: which tier serves each job kind right now.
   * Facts for Home's notes, the models popover and the honest-Auto labels —
   * suppression never touches these. */
  readiness: ReadinessRow[] | null;
  /** The open project's readiness, per-node model overrides included.
   * Cleared with the project; the workspace banner reads it. */
  projectReadiness: ReadinessRow[] | null;
  actionError: ActionError | null;
  system: SystemInfo | null;
  projects: Project[];
  currentProject: Project | null;
  /** Ids of projects open as rail tabs, in open order. The active one is
   * `currentProject`; the rest stay open but idle (no board, no polling). */
  openProjects: string[];
  board: Board | null;
  /** Undo/redo depths and save points for the open project. */
  history: HistoryInfo | null;
  /** Persisted per-task default models (Settings → Models). */
  modelDefaults: ModelDefaults | null;
  jobs: Job[];
  /** Unfiltered queue across all projects — Home tile status dots. */
  allJobs: Job[];
  storage: StorageInfo | null;
  /** Last storage refresh failed — `storage` shows earlier values. A dead
   * engine mid-session must not silently present stale sizes as current. */
  storageStale: boolean;
  engineVersions: { engine_version: string; api_version: number } | null;
  defaults: HomeDefaults;
  homeDraft: HomeDraft;
  selectedNode: string | null;
  models: ModelRow[];
  // model id → last download failure, cleared on retry/success.
  downloadErrors: Record<string, string>;
  // node id → what the engine said when this node's render gave up, and what
  // it suggested doing about it. Only the websocket ever carries these: the
  // scheduler computes `suggestions` at publish time and persists nothing, so
  // they are on neither the Job row nor the board's NodeState (which has a
  // bare `error` string). Cleared the moment the node runs again.
  nodeFailures: Record<string, { error: string; suggestions: string[] }>;
  // node id → the OOM-ladder rung a retry is running at. "Rendering" alone
  // hides that the attempt now in flight will produce a SMALLER result than
  // the one that failed.
  nodeRetries: Record<string, { attempt: number; fallback: OomFallback }>;
  firstRunDone: boolean;
  // True when the wizard was reopened from Settings rather than being a
  // genuine first launch — it then starts at the machine step: the welcome
  // promise is a once-only moment, and this user has already seen the app.
  firstRunReturning: boolean;
  // The Library is a screen of its own under Home in the rail (U2), not a
  // tab on Home: an open project still wins the viewport, so closing one
  // returns to whichever of the two the user came from.
  libraryOpen: boolean;
  libraryFilter: LibraryFilter;
  /** Templates saved from a project's shape, newest first (this profile,
   * not the engine — see lib/templates.ts). */
  templates: TemplateEntry[];
  /** What the last template import will spend and what it left behind.
   * Shown once, dismissible, never blocking. */
  templateNotice: { title: string; cloudModels: string[]; droppedAssets: number } | null;
  /** The project whose shape is being named as a template, or null. Held
   * here rather than in the Library because the palette can ask for the same
   * dialog from inside an open project, and one dialog with two hosts is two
   * dialogs that drift. */
  saveTemplateFor: Project | null;
  // Bumped whenever something asks the Library for the keyboard — Home's
  // "/" and the palette route here rather than growing a second search box
  // over a shelf that only ever shows four tiles.
  librarySearchFocus: number;
  settingsOpen: boolean;
  // Which Settings tab is showing — deep-linkable (engine chip → "engine",
  // the prompt bar's model button → "models").
  settingsTab: string;
  // One natural-language edit at a time — the LLM call is slow and a second
  // plan compiled against the pre-edit view would fight the first.
  editBusy: boolean;
  // True when the connection points at a *verified* remote engine (GPU box).
  remoteEngine: boolean;
  // True when a pairing exists on disk even if the remote is unreachable —
  // so the UI can always offer Disconnect rather than stranding on a dead box.
  remotePaired: boolean;
  // Whether the connected engine may hold the provider keys. Always true for
  // the local engine; for a remote one it is the user's per-host consent, and
  // false is what the Settings pane offers to change.
  remoteKeysArmed: boolean;

  connect: () => Promise<void>;
  reconnect: () => Promise<void>;
  /** Start the engine again after a crash. Null means it came back. */
  restartEngine: () => Promise<string | null>;
  noteEngineCrash: (crash: EngineCrash | null) => void;
  setNotifyOnDone: (on: boolean) => void;
  setWarnMissingModels: (on: boolean) => void;
  /** Refetch both readiness slices (project one only while a project is
   * open). Facts only — never gated, never suppressed. */
  refreshReadiness: () => Promise<void>;
  /** The rows an explicit render click should warn about, or null to
   * proceed silently — fetched fresh, filtered to placeholder/will_fail,
   * then checked against the master switch and the session/project
   * suppressions. `scopeKey` is the project id, or "home" for Home. */
  readinessGaps: (scopeKey: string, kinds?: string[]) => Promise<ReadinessRow[] | null>;
  /** Record a dialog dismissal. "session" dies with the window; "project"
   * persists per scopeKey and re-warns when the gap set changes; "always"
   * flips `warnMissingModels` itself. */
  suppressReadiness: (
    scopeKey: string,
    rows: ReadinessRow[],
    scope: "session" | "project" | "always",
    /** The same `kinds` the gate asked with — the dismissal covers that
     * narrowing, not every question this scopeKey can ask. */
    kinds?: string[],
  ) => void;
  refreshHome: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  /** Leave the workspace for Home. Open tabs stay open. */
  closeProject: () => void;
  /** Drop a project from the rail tabs; if it was active, the nearest
   * remaining tab takes over (Home when none are left). */
  closeOpenProject: (id: string) => void;
  createFromPrompt: (
    prompt: string,
    duration: number,
    aspect: string,
    mode: "prompt" | "beginner",
    style?: string,
  ) => Promise<void>;
  createTool: (
    tool: ToolKind,
    input: {
      prompt?: string;
      text?: string;
      voice?: string;
      motion?: string;
      model?: string;
      aspect?: string;
      duration_s?: number;
      target_duration_s?: number;
    },
    /** Clip only: an image to condition the take with. Uploaded into the
     * new session and wired into the clip's keyframe port; the generated
     * keyframe node is removed in the same patch, so the session renders
     * from the user's frame instead of racing it. */
    startFrame?: File,
  ) => Promise<void>;
  /** Copy the current session's finished artifact into another project as
   * an asset node (fetch → upload — the HTTP boundary both ways). `null`
   * means it landed; anything else is the reason it did not. */
  addToProject: (targetId: string) => Promise<string | null>;
  /** Wire a consented voice sample into the session's voiceover node —
   * upload with the affirmation, then set the cloning model and connect
   * voice_ref, exactly like the workspace's applyClonedVoice. */
  applySessionVoiceClone: (file: File) => Promise<string | null>;
  promote: () => Promise<void>;
  /** Rewrite the current project's script from user feedback.
   *
   * Reports BOTH ways, and deliberately: the tool session renders
   * `actionError` in the block it shares with promote, while the composer —
   * which reaches this through its Script scope — follows the return-the-
   * message convention like every other action it calls. The two surfaces
   * are never mounted together, so nothing is said twice. */
  enhance: (notes: string) => Promise<string | null>;
  /** Drop a shown action error — e.g. when the surface that earned it
   * (a tool panel) is being swapped for another. */
  dismissActionError: () => void;
  /** The session composer's "update & re-render": rewrite the tool node's
   * input field (prompt / text / brief). The /patch re-plan marks the node
   * dirty and queues the re-render — no second call. */
  refineTool: (nodeId: string, key: string, value: string) => Promise<string | null>;
  /** Pick the voice a narration node speaks in, or clear the pick.
   *
   * `null` clears it, and clears it by REMOVING the key rather than
   * storing null — `set_params` reads a null that way on purpose, so a
   * node put back on the project's voice lands on the same hash as one
   * that never carried a pick, and the audio already rendered for that
   * state is a cache hit again instead of a re-render. */
  setVoice: (nodeId: string, voiceId: string | null) => Promise<string | null>;
  /** Describe the voice instead of picking one: writes the brief and drops
   * any picked id, in a single patch. Both move together because the
   * engine reads the pick first — sent as two patches, the node spends the
   * gap carrying the new brief under the old pick, and every patch
   * re-plans. */
  setVoiceBrief: (nodeId: string, brief: string) => Promise<string | null>;
  approve: (checkpoint: Checkpoint) => Promise<void>;
  refreshBoard: () => Promise<void>;
  /** The Story Graph behind the board, for the flowchart view. Null until
   * that view asks for it — the storyboard never needs edges. */
  graph: StoryGraph | null;
  graphError: string | null;
  refreshGraph: () => Promise<void>;
  /** Wire `src` into `dst`'s `port`, replacing whatever held it. */
  connectNodes: (src: string, dst: string, port: string) => Promise<string | null>;
  /** Free an input port. The node stays; only the edge goes. */
  disconnectPort: (dst: string, port: string) => Promise<string | null>;
  removeNode: (nodeId: string) => Promise<string | null>;
  /** Add an unwired node of `kind` and select it. The id is generated
   * against the live graph; params, seed and model are left at their
   * defaults for the inspector to fill in. */
  addNode: (kind: string) => Promise<string | null>;
  /** Re-render a node. With `seed`, a reroll pinned to that seed (one
   * atomic call — RegenerateBody.seed); without, the engine bumps it. */
  regenerate: (nodeId: string, seed?: number) => Promise<void>;
  applyNode: (
    nodeId: string,
    changes: { params?: Record<string, unknown>; seed?: number; model?: string | null },
  ) => Promise<void>;
  togglePin: (nodeId: string, pin: boolean) => Promise<void>;
  /** Compile an edit and report what it WOULD do, committing nothing.
   *
   * There is deliberately no one-step "edit and apply" beside this. The
   * composer had one, and keeping it would leave a second route that
   * rewrites the graph with nothing on screen first — the same objection
   * the `/patch` chokepoint rule makes about private mutation paths. The
   * engine's own non-dry-run /edit is still there for the CLI and MCP,
   * where there is no card to show anyone. */
  proposeEdit: (instruction: string, scope?: string) => Promise<EditProposal | null>;
  /** Land a proposal. Rejects with an EngineError(409) when the graph moved
   * under it — the plan is stale and has to be asked for again. */
  applyEditPlan: (proposal: EditProposal, scope?: string) => Promise<EditResult | null>;
  refreshHistory: () => Promise<void>;
  /** Walk back/forward one recorded graph mutation. */
  undoEdit: () => Promise<string | null>;
  redoEdit: () => Promise<string | null>;
  createSavepoint: (label: string) => Promise<string | null>;
  restoreSavepoint: (savepointId: string) => Promise<string | null>;
  deleteSavepoint: (savepointId: string) => Promise<string | null>;
  /** Swap a node back to a recorded take (a cache hit when its artifact
   * survives on disk). */
  selectTake: (nodeId: string, outputHash: string) => Promise<string | null>;
  /** Append an empty scene (engine allocates the id) and select it. */
  addScene: () => Promise<string | null>;
  /** Take a scene out of the cut — its nodes and the timeline's references
   * to it. The engine refuses the last scene, a pinned one, and any removal
   * while the timeline is pinned; the message it gives is what comes back. */
  removeScene: (sceneId: string) => Promise<string | null>;
  refreshModelDefaults: () => Promise<void>;
  setModelDefault: (task: string, model: string | null) => Promise<string | null>;
  cancelJob: (jobId: string) => Promise<void>;
  /** Make this image the scene's still. Null means it applied. */
  conditionScene: (sceneId: string, file: File) => Promise<string | null>;
  /** Hand the scene back to its generated keyframe. Null means it applied. */
  clearSceneStill: (sceneId: string) => Promise<string | null>;
  /** Upload an image and keep its node id, without wiring it to anything —
   *  the dialog needs the asset on the engine before it can ask a model to
   *  look at it, and the user may still cancel. A cancelled drop leaves an
   *  unwired asset behind, which is what the flowchart is for. */
  uploadSceneImage: (file: File) => Promise<{ nodeId?: string; error?: string }>;
  /** Ask a vision model — local or cloud — to write this scene's words from
   *  the image. `model` names one the engine offered; omitted lets it choose.
   *  `signal` aborts the wait without reporting a failure. */
  suggestScene: (
    nodeId: string,
    model?: string,
    signal?: AbortSignal,
  ) => Promise<{ narration?: string; prompt?: string; error?: string }>;
  /** Append a scene built on an already-uploaded image. Null means applied. */
  addSceneFromImage: (
    nodeId: string,
    fields: { narration: string; prompt: string },
  ) => Promise<string | null>;
  applyClonedVoice: (file: File) => Promise<void>;
  applyTimeline: (params: Record<string, unknown>) => void;
  applyExport: (params: Record<string, unknown>) => void;
  finalize: () => Promise<void>;
  select: (nodeId: string | null) => void;
  refreshModels: () => Promise<void>;
  startDownload: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  /** Decode a pairing code for review — nothing is sent, nothing is stored. */
  inspectPairing: (code: string) => Promise<PairingPreview>;
  /** Pair with a remote engine. `armKeys` is a separate, explicit decision:
   * connecting to a GPU box and handing it every provider key are not the
   * same act, and the pairing code alone cannot be reviewed by eye. */
  pairRemote: (code: string, armKeys?: boolean) => Promise<string | null>;
  /** Send the stored provider keys to the currently paired engine. */
  armRemoteKeys: () => Promise<string | null>;
  unpairRemote: () => Promise<string | null>;
  finishFirstRun: () => void;
  resetFirstRun: () => void;
  openLibrary: (options?: { filter?: LibraryFilter; focusSearch?: boolean }) => void;
  openSaveTemplate: (project: Project) => void;
  closeSaveTemplate: () => void;
  saveTemplate: (projectId: string, name: string) => Promise<string | null>;
  startFromTemplate: (id: string, title?: string) => Promise<string | null>;
  deleteTemplate: (id: string) => void;
  dismissTemplateNotice: () => void;
  closeLibrary: () => void;
  setLibraryFilter: (filter: LibraryFilter) => void;
  openSettings: (tab?: string) => void;
  /** Act on one of the engine's OOM suggestions for a failed node. `null`
   * means it applied; any other return is a message to show. */
  applyOomSuggestion: (nodeId: string, code: string) => Promise<string | null>;
  /** Enqueue whatever the graph still owes, at draft quality. The only way
   * back into flight for a project whose queue was lost — an empty /patch
   * re-plans nothing. */
  resumeRender: () => Promise<string | null>;
  /** Re-render a node on a seed borrowed from one of its takes, in one call.
   * `null` means it applied; any other return is a message. */
  rerollWithSeed: (nodeId: string, seed: number) => Promise<string | null>;
  /** Build the publish kit (thumbnail + title/description/hashtags). Both
   * land as graph nodes and render through the queue like anything else. */
  preparePublish: () => Promise<string | null>;
  setSettingsTab: (tab: string) => void;
  closeSettings: () => void;
  /** Lifecycle actions return the error message to show, or null on success. */
  deleteProject: (id: string) => Promise<string | null>;
  deleteToolSessions: () => Promise<string | null>;
  renameProject: (id: string, title: string) => Promise<string | null>;
  duplicateProject: (id: string) => Promise<string | null>;
  refreshStorage: () => Promise<void>;
  cleanupStorage: () => Promise<number | null>;
  addCustomModel: (body: {
    name: string;
    task: string;
    source: "url" | "file";
    ref: string;
    vram_gb?: number;
    workflow_template?: string;
  }) => Promise<string | null>;

  /* ---- ComfyUI node packs and workflows (Settings → Workflows) ---- */
  nodePacks: NodePacks | null;
  workflows: InstalledWorkflow[];
  refreshComfy: () => Promise<string | null>;
  /** `acknowledged` states that the engine's own warning was shown. The
   * engine rejects a false, so this can never become a default. */
  enableNodePack: (
    packId: string,
    version: string,
    acknowledged: boolean,
  ) => Promise<string | null>;
  disableNodePack: (packId: string) => Promise<string | null>;
  importWorkflow: (name: string, workflow: unknown) => Promise<string | null>;
  deleteWorkflow: (name: string) => Promise<string | null>;
  deleteCustomModel: (modelId: string) => Promise<void>;
  setDefaults: (patch: Partial<HomeDefaults>) => void;
  setHomeDraft: (patch: Partial<HomeDraft>) => void;
}

const FIRST_RUN_KEY = "localcut.firstRunDone";
const DEFAULTS_KEY = "localcut.defaults.v1";
const DRAFT_KEY = "localcut.home.draft";
const OPEN_TABS_KEY = "localcut.openTabs";
const NOTIFY_KEY = "localcut.notifyOnDone";
const WARN_MODELS_KEY = "localcut.warnMissingModels";
const READINESS_SKIP_KEY = "localcut.readinessSkip.v1";

/** Rail tabs survive a restart (ids only — titles rehydrate from /projects;
 * refreshHome prunes ids whose projects no longer exist, which also empties
 * the tabs naturally on an engine switch). */
function readOpenTabs(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveOpenTabs(tabs: string[]): void {
  try {
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(tabs));
  } catch {
    /* storage full — tabs just won't survive a restart */
  }
}
const REFRESH_DEBOUNCE_MS = 150;
const HOME_REFRESH_DEBOUNCE_MS = 600;
const RECONNECT_DELAY_MS = 3000;
const PATCH_DEBOUNCE_MS = 300;

const FALLBACK_DEFAULTS: HomeDefaults = {
  aspect: "9:16",
  duration: 60,
  style: "cinematic",
  // "Review steps" out of the box. A first video is the one most likely to
  // need changing, and the checkpoints are where changing it is cheap: the
  // script is a text file, the storyboard a handful of stills, and both come
  // before the clips that cost the GPU hours. Auto is one click away and
  // persists once chosen; an unreviewed run that has to be thrown away is
  // not.
  mode: "beginner",
  voice: "",
  videoModel: null,
};

/** The tool panel's starting options — the ToolRequest defaults the engine
 * would apply anyway, made visible instead of implied. Exported because a
 * finished run puts the panel back to them, and a second copy of these three
 * numbers in Home is a second thing to update when one of them moves. */
export const EMPTY_TOOL_OPTIONS = {
  toolAspect: "16:9",
  toolDuration: 60,
  clipSeconds: 5,
};

const EMPTY_DRAFT: HomeDraft = {
  prompt: "",
  tool: null,
  toolInput: "",
  aspect: null,
  duration: null,
  style: null,
  mode: null,
  voice: "",
  voiceId: null,
  motion: "",
  scriptModel: "",
  ...EMPTY_TOOL_OPTIONS,
};

function loadPersisted<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

/** Guarded "1" flag read: this runs in the store initializer at module import
 * (before any ErrorBoundary), so a throwing localStorage — blocked storage,
 * a restrictive storage policy — must degrade, not blank the whole app. */
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * The same read for a flag that defaults to ON.
 *
 * `readFlag` cannot express this: its fallback is false, so an unset key and
 * a key explicitly set to "0" are the same answer. Notifications are on
 * until someone turns them off — a render is minutes long and the whole
 * point is to be told when it ends — so the absent key has to mean yes.
 */
function readFlagDefaultOn(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}
// A stale /models snapshot can lag a terminal download event — refetch
// once more after the engine has settled.
const DOWNLOAD_SETTLE_MS = 1500;

/** "Don't warn again for this session": in memory only, gone on reload.
 * Cleared on an engine switch — a dismissal is about one engine's models,
 * and the next box has its own. */
const sessionReadinessSkips = new Map<string, string>();

/** The suppression key. The kinds scope is part of it because the
 * fingerprint is taken over the NARROWED rows: Home asks about a whole
 * video from one surface and a single tool kind from another under the
 * same scopeKey, and with one entry between them each dismissal evicted
 * the other and the dialog came back forever. */
function scopeOf(scopeKey: string, kinds?: string[]): string {
  return kinds?.length ? `${scopeKey}#${[...kinds].sort().join(",")}` : scopeKey;
}

function readReadinessSkips(): Record<string, string> {
  try {
    const raw = localStorage.getItem(READINESS_SKIP_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, value]) => typeof value === "string",
      ),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeReadinessSkip(scopeKey: string, fingerprint: string): void {
  try {
    localStorage.setItem(
      READINESS_SKIP_KEY,
      JSON.stringify({ ...readReadinessSkips(), [scopeKey]: fingerprint }),
    );
  } catch {
    /* blocked storage — the dismissal just does not survive a restart */
  }
}

interface PendingPatch {
  projectId: string;
  params: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
  // In-flight PATCH. The entry stays in the map until it resolves so
  // withPending keeps shielding refreshes that raced the request.
  sent?: Promise<void>;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshQueued = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
// One in-flight establish, shared by connect and reconnect: StrictMode
// double-mount must not open two sockets.
let establishing: Promise<void> | null = null;
// Bumped on every establish; a stale establish (superseded by an engine
// switch mid-flight) sees the mismatch and bails instead of pointing the
// store back at the old engine.
let establishGen = 0;
// Bumped on every openProject (and on closeProject); a superseded load sees
// the mismatch and drops its result instead of navigating backwards.
let openGen = 0;
// Bumped on every refreshBoard, so a slow earlier response cannot land on
// top of a newer one and re-show work that has since finished.
let boardGen = 0;
// The same guard for the graph. It used to be fetched only on the canvas's
// mount and after its own patches, where two could barely overlap; now every
// board refresh keeps it in step, so concurrent reads are routine and an
// out-of-order landing would redraw a DAG the project has moved past.
let graphGen = 0;
// And for the history depths, which every board refresh keeps in step too.
let historyGen = 0;
// Shape-stable and small (two ints and two flat descriptors plus the save
// point list), and the engine emits its keys in a fixed order, so this is a
// sound equality for "the depths did not move".
const sameHistory = (a: HistoryInfo | null, b: HistoryInfo): boolean =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);
// Called with the id of any project created while a refreshHome is in
// flight — that request's snapshot predates it, so the tab prune must not
// treat it as deleted.
const newProjectListeners = new Set<(id: string) => void>();
const announceNewProject = (id: string) => {
  for (const listener of newProjectListeners) listener(id);
};
const pendingPatches = new Map<string, PendingPatch>();
// Download bookkeeping — the WS is fresher than any /models snapshot.
// wsProgress holds the latest bytes per model; terminalDownloads marks
// models whose download already ended so a stale row can't resurrect it.
const wsProgress = new Map<string, { done: number; total: number }>();
const terminalDownloads = new Set<string>();
// True while the rig has injected fixture state (see installSeedHook):
// live model refreshes and WS progress are dropped so the injected frame
// holds still. Never true outside a rig-driven dev run.
let seedFrozen = false;

/** The board's node with this id, wherever it lives on it. The board is a
 * scene list plus an aux map rather than a flat index, and nothing else here
 * needed to look one up by id. */
const nodeOf = (board: Board | null, nodeId: string): NodeState | undefined => {
  if (!board) return undefined;
  for (const scene of board.scenes) {
    for (const node of [scene.keyframe, scene.clip, scene.narration]) {
      if (node?.node_id === nodeId) return node;
    }
    for (const take of scene.clip_takes ?? []) {
      if (take?.node_id === nodeId) return take;
    }
  }
  return Object.values(board.aux).find((node) => node?.node_id === nodeId) ?? undefined;
};

/** A copy of `record` without `key` — the per-node failure/retry maps are
 * cleared one node at a time, and mutating them in place would not re-render
 * a subscriber. */
const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
};


// Drop all per-engine module state — pending edits, download bookkeeping —
// when the engine itself changes (pair/unpair). Otherwise the old engine's
// in-flight PATCH fires at the new one, and its download bytes/errors bleed
// into the new engine's model list.
const resetEngineScopedState = () => {
  for (const pending of pendingPatches.values()) clearTimeout(pending.timer);
  pendingPatches.clear();
  wsProgress.clear();
  terminalDownloads.clear();
  seedFrozen = false;
};

export const useApp = create<AppState>((set, get) => {
  // Home's tiles show live status for EVERY project (dots + fresh thumbs),
  // so off-project job events refresh the light home read model, debounced.
  let homeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHomeRefresh = () => {
    if (homeRefreshTimer) return;
    homeRefreshTimer = setTimeout(() => {
      homeRefreshTimer = null;
      get()
        .refreshHome()
        .catch((err) => console.warn("home refresh failed:", err));
    }, HOME_REFRESH_DEBOUNCE_MS);
  };

  const scheduleReconnect = () => {
    if (reconnectTimer) return; // one pending attempt, no matter how many drops
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void get().reconnect();
    }, RECONNECT_DELAY_MS);
  };

  // Leading + trailing debounce: refresh right away, and once more after the
  // window if further events arrived — a continuous stream can't starve it.
  const scheduleRefresh = () => {
    const refresh = () =>
      get()
        .refreshBoard()
        .catch((err) => console.warn("board refresh failed:", err));
    if (refreshTimer) {
      refreshQueued = true;
      return;
    }
    void refresh();
    const arm = () => {
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (refreshQueued) {
          refreshQueued = false;
          void refresh();
          arm();
        }
      }, REFRESH_DEBOUNCE_MS);
    };
    arm();
  };

  // Patch progress into the board and queue in place — no HTTP refetch.
  const applyProgress = (event: { job_id: string; node_id: string; progress: number }) => {
    const { board, jobs } = get();
    const patch = <T extends NodeState | null>(node: T): T =>
      node && node.node_id === event.node_id
        ? ({ ...node, progress: event.progress } as T)
        : node;
    set({
      // Spread the board rather than rebuilding it from `scenes`/`aux`: it
      // also carries `assembled_durations`, which every duration the UI shows
      // (timeline strip, monitor clock, playhead, seek math) reads through
      // lib/order.ts. Listing the fields dropped it on every progress tick, so
      // the whole cut silently reverted to planned per-clip sums mid-render.
      board: board
        ? {
            ...board,
            scenes: board.scenes.map((scene) => ({
              ...scene,
              keyframe: patch(scene.keyframe),
              clip: patch(scene.clip),
              narration: patch(scene.narration),
              // A split scene's sequential takes render like any other node —
              // without this their rings only move on the debounced refetch.
              ...(scene.clip_takes
                ? { clip_takes: scene.clip_takes.map((take) => patch(take)) }
                : {}),
            })),
            aux: Object.fromEntries(
              Object.entries(board.aux).map(([name, node]) => [name, patch(node)]),
            ),
          }
        : board,
      jobs: jobs.map((job) =>
        job.id === event.job_id ? { ...job, progress: event.progress } : job,
      ),
    });
  };

  // Download bars update in place from WS bytes — no HTTP refetch per tick.
  const applyDownloadProgress = (event: { model: string; done: number; total: number }) => {
    if (seedFrozen) return;
    // A progress tick means the download is live (again).
    terminalDownloads.delete(event.model);
    wsProgress.set(event.model, { done: event.done, total: event.total });
    set({
      models: get().models.map((row) =>
        row.id === event.model
          ? { ...row, downloading: true, progress: { done: event.done, total: event.total } }
          : row,
      ),
    });
  };

  // A /models response can be older than the WS stream it races: it may
  // still say `downloading` after the terminal event, or carry byte counts
  // behind the last progress tick. Never let it move a bar backward or
  // resurrect a finished download.
  const reconcileModels = (rows: ModelRow[]): ModelRow[] =>
    rows.map((row) => {
      if (row.downloaded) {
        wsProgress.delete(row.id);
        return row;
      }
      if (terminalDownloads.has(row.id)) {
        return row.downloading ? { ...row, downloading: false, progress: null } : row;
      }
      const ws = wsProgress.get(row.id);
      if (!ws) return row;
      return {
        ...row,
        downloading: true,
        progress: { done: Math.max(ws.done, row.progress?.done ?? 0), total: ws.total },
      };
    });

  // Param edits are optimistic: the board updates immediately, the PATCH is
  // debounced per node with changed keys merged, and the WS-driven refresh
  // brings back the server truth once the dirty subgraph re-renders.
  // The pending entry outlives the request: it is removed only once the
  // PATCH settles (and only if a newer edit hasn't replaced it), so a
  // refresh whose GET raced the PATCH still gets the edit reapplied.
  const sendPatch = (nodeId: string): Promise<void> => {
    const pending = pendingPatches.get(nodeId);
    if (!pending) return Promise.resolve();
    if (pending.sent) return pending.sent; // already on the wire
    clearTimeout(pending.timer);
    const { client } = get();
    if (!client) {
      pendingPatches.delete(nodeId);
      return Promise.resolve();
    }
    pending.sent = client
      .patch(pending.projectId, [{ op: "set_params", node_id: nodeId, params: pending.params }])
      .then(() => undefined)
      .catch((err) => {
        console.warn(`patch ${nodeId} failed:`, err);
        void get().refreshBoard();
      })
      .finally(() => {
        if (pendingPatches.get(nodeId) === pending) pendingPatches.delete(nodeId);
      });
    return pending.sent;
  };

  // Resolves once every flushed PATCH has settled — callers that act on
  // the flushed state (finalize, project switch) must await it.
  const flushPatches = (): Promise<void> =>
    Promise.all([...pendingPatches.keys()].map(sendPatch)).then(() => undefined);

  /**
   * A structural patch from the flowchart canvas, then a re-read of both the
   * graph and the board.
   *
   * Returns the engine's rejection rather than throwing. Every caller here is
   * a direct manipulation — a dragged wire, a deleted node — and the useful
   * response to "that would create a cycle" is to say so next to the wire,
   * not to unwind a promise chain. `null` means it applied.
   *
   * Both refreshes, because a structural edit changes both pictures: the
   * canvas has a new edge and the board has new work (a rewired port re-plans
   * the whole downstream cone).
   */
  const patchGraph = async (
    ops: Parameters<EngineClient["patch"]>[1],
  ): Promise<string | null> => {
    const { client, currentProject } = get();
    // NOT null: null is this function's "it applied", so returning it for an
    // edit that was never sent told the canvas a wire had landed. Same answer
    // every other action here gives when the engine is gone.
    if (!client || !currentProject) return t("errors.engineUnavailable");
    try {
      await client.patch(currentProject.id, ops);
    } catch (err) {
      return messageOf(err);
    }
    // refreshBoard pulls the graph with it, so one call covers both pictures
    // — and awaiting it means the canvas has already redrawn by the time a
    // caller decides whether to show a hint.
    //
    // Inside the try, because refreshBoard has no catch of its own: a patch
    // that landed followed by a refresh that did not would otherwise reject
    // this promise, and every caller invokes it as `void` — an unhandled
    // rejection instead of the hint this function exists to return.
    try {
      await get().refreshBoard();
    } catch (err) {
      return messageOf(err);
    }
    return null;
  };

  /**
   * A mutation of the engine's graph history — undo, redo, and the save
   * point create/restore. Each route answers with the new HistoryInfo, so
   * the response IS the fresh read model.
   *
   * Returns the engine's rejection rather than throwing, like patchGraph:
   * "nothing to undo" is a sentence to put beside the control, not an
   * unwound promise chain. `null` means it applied.
   */
  const historyAction = async (
    call: (client: EngineClient, projectId: string) => Promise<HistoryInfo>,
    { redraw = false }: { redraw?: boolean } = {},
  ): Promise<string | null> => {
    const { client, currentProject } = get();
    if (!client || !currentProject) return t("errors.engineUnavailable");
    const projectId = currentProject.id;
    try {
      // A debounced inspector patch still in flight is the newest edit; it
      // must land (and be recorded) before any of these names a step.
      await flushPatches();
      const history = await call(client, projectId);
      // Retire in-flight refreshHistory reads. One that started before this
      // mutation still satisfies its OWN generation check, so it would paint
      // the pre-mutation depths back over what the engine just returned —
      // and after createSavepoint nothing would ever correct it, because no
      // event fires and no board refresh follows. The new save point simply
      // stayed invisible.
      historyGen++;
      // The same engine/project re-check every other write in this file
      // makes: switching tabs during the round trip must not land these
      // depths on the project the user just opened.
      if (get().client === client && get().currentProject?.id === projectId) set({ history });
      if (redraw) await get().refreshBoard();
      return null;
    } catch (err) {
      return messageOf(err);
    }
  };

  const applyAuxParams = (nodeId: string, params: Record<string, unknown>) => {
    const { board, client, currentProject } = get();
    const node = board?.aux[nodeId];
    if (!board || !node || !client || !currentProject) return;
    set({
      board: {
        ...board,
        aux: { ...board.aux, [nodeId]: { ...node, params: { ...node.params, ...params } } },
      },
    });
    const prev = pendingPatches.get(nodeId);
    if (prev) clearTimeout(prev.timer);
    const carried = prev?.projectId === currentProject.id ? prev.params : {};
    pendingPatches.set(nodeId, {
      projectId: currentProject.id,
      params: { ...carried, ...params },
      timer: setTimeout(() => sendPatch(nodeId), PATCH_DEBOUNCE_MS),
    });
  };

  // Keep unsent optimistic edits on top of a freshly fetched board.
  const withPending = (board: Board, projectId: string): Board => {
    let aux = board.aux;
    for (const [nodeId, pending] of pendingPatches) {
      const node = aux[nodeId];
      if (!node || pending.projectId !== projectId) continue;
      aux = { ...aux, [nodeId]: { ...node, params: { ...node.params, ...pending.params } } };
    }
    return aux === board.aux ? board : { ...board, aux };
  };

  const establish = async () => {
    const gen = ++establishGen;
    unsubscribe?.(); // never leak a previous subscription
    unsubscribe = null;
    const { connection, error, crash, remote, remotePaired, keysArmed } =
      await window.localcut.getEngineConnection();
    // A newer establish (an engine switch) superseded us while we awaited —
    // bail so we never point the store back at the old engine.
    if (gen !== establishGen) return;
    if (!connection) {
      set({
        client: null,
        engineError: error ?? t("errors.engineUnavailable"),
        // A crash raised before this renderer existed — the engine died
        // during launch, so `engine:crashed` was pushed to no windows. It is
        // the difference between the plain bar, which offers nothing, and the
        // banner, which offers the one button that brings the engine back.
        ...(crash ? { engineCrash: crash } : {}),
        remoteEngine: false,
        remotePaired: remotePaired === true,
        remoteKeysArmed: keysArmed !== false,
      });
      return;
    }
    const client = new EngineClient(connection);
    set({
      client,
      engineError: null,
      // The crash goes with the error it came in beside. `restartEngine`
      // clears it on the way back up, but that is only the button's path —
      // an engine that returned through the reconnect timer, or a pairing
      // that moved the work to a GPU box, left the banner standing over a
      // connection that answers. The shell only ever reports a crash while
      // there is nothing to connect to, so a connection is the end of it.
      engineCrash: null,
      remoteEngine: remote === true,
      remotePaired: remotePaired === true,
      remoteKeysArmed: keysArmed !== false,
    });

    const sub = client.subscribe(
      (event: EngineEvent) => {
        // Progress ticks first patch the ENGINE-wide job list, whatever
        // project they belong to: job ids are engine-global (unlike node
        // ids), and the queue tray reads this list — without it, a render
        // in any project you are not looking at froze at whatever the last
        // debounced refetch happened to see.
        if (event.type === "job.progress") {
          set({
            allJobs: get().allJobs.map((job) =>
              job.id === event.job_id ? { ...job, progress: event.progress } : job,
            ),
          });
        }
        // Drop project-scoped events for a project we're not viewing: the WS
        // is a global stream and job events name node ids ("timeline",
        // "script") that exist in every project, so an unscoped apply would
        // patch this board with another project's progress. Download events
        // carry no project_id and always pass through.
        const scoped = (event as { project_id?: string }).project_id;
        if (scoped !== undefined && scoped !== get().currentProject?.id) {
          // Not this board's event — but tile status/thumbs on Home still
          // move on job lifecycle edges (progress ticks are noise there).
          if (event.type !== "job.progress") scheduleHomeRefresh();
          return;
        }
        if (event.type === "job.progress") {
          applyProgress(event);
        } else if (event.type === "model.download.progress") {
          applyDownloadProgress(event);
        } else if (
          event.type === "model.download.done" ||
          event.type === "model.download.failed" ||
          event.type === "model.download.cancelled"
        ) {
          // Terminal states: record the failure, then refetch the
          // authoritative install flags.
          terminalDownloads.add(event.model);
          wsProgress.delete(event.model);
          const errors = { ...get().downloadErrors };
          if (event.type === "model.download.failed") errors[event.model] = event.error;
          else delete errors[event.model];
          set({ downloadErrors: errors });
          const refetch = () =>
            Promise.all([
              get().refreshModels(),
              // Verdicts flip the moment weights land (capability is probed
              // live) — the banner must clear without a restart.
              get().refreshReadiness(),
            ]).catch((err) => console.warn("models refresh failed:", err));
          void refetch();
          // The engine can still report `downloading` for a beat after the
          // terminal event — refetch once more when it has settled.
          setTimeout(() => void refetch(), DOWNLOAD_SETTLE_MS);
        } else if (event.type === "job.failed") {
          // Keep the advice with the node it is about. `suggestions` is
          // absent on ordinary failures — only the exhausted OOM ladder
          // offers choices — so an empty list here means "no advice", which
          // the card reads as "show the error alone".
          //
          // Frozen means a rig posed these, and the engine's own traffic must
          // not touch them — the same rule `refreshBoard` and the download
          // bars already follow. It is not hypothetical: the rig's project
          // renders an `s1.clip` of its own, and its `job.done` cleared the
          // posed failure out from under the frame being photographed.
          if (!seedFrozen) {
            set({
              nodeFailures: {
                ...get().nodeFailures,
                [event.node_id]: { error: event.error, suggestions: event.suggestions ?? [] },
              },
              nodeRetries: without(get().nodeRetries, event.node_id),
            });
          }
          scheduleRefresh();
        } else if (event.type === "job.retrying") {
          if (!seedFrozen) {
            set({
              nodeRetries: {
                ...get().nodeRetries,
                [event.node_id]: { attempt: event.attempt, fallback: event.fallback ?? {} },
              },
            });
          }
          scheduleRefresh();
        } else if (event.type === "job.started" || event.type === "job.done") {
          // A fresh attempt makes the previous verdict stale in both
          // directions: left in place, a node that has since succeeded still
          // carries "out of memory" advice, and a chip would act on a job
          // that no longer exists.
          if (!seedFrozen) {
            set({
              nodeFailures: without(get().nodeFailures, event.node_id),
              nodeRetries: without(get().nodeRetries, event.node_id),
            });
          }
          scheduleRefresh();
        } else if (event.type === "project.error") {
          // The engine reports a failed expansion (a screenplay that would
          // not parse, a post-completion hook that threw). Nothing handled
          // this, so the project simply stopped progressing with no message
          // — the single worst way for work to fail.
          set({
            actionError: { scope: "create", message: event.error },
          });
          scheduleRefresh();
        } else if (
          event.type.startsWith("job.") ||
          event.type === "project.expanded" ||
          event.type === "project.edited" ||
          event.type === "project.restored" ||
          // The three that used to reach the end of this chain and be
          // dropped. Each moves something on screen, and none of them is
          // reliably followed by a job event that would refresh anyway: a
          // compile can enqueue nothing, an approval enqueues nothing by
          // itself, and an upload is finished work the moment it lands.
          // They matter most from ANOTHER client — the CLI and the MCP
          // server drive this same engine — where no local call site exists
          // to refresh on the way out.
          event.type === "project.compiled" ||
          event.type === "project.approved" ||
          event.type === "project.asset"
        ) {
          scheduleRefresh();
        } else if (event.type === "project.deleted") {
          // A delete from somewhere else — a second window, curl, another
          // client against a shared remote engine. The local delete path
          // refreshes on its own; this covers everything that isn't it, and
          // the tab prune in refreshHome closes the tab if it was open.
          void get().refreshHome();
        }
      },
      () => {
        set({ engineError: t("errors.engineLost") });
        scheduleReconnect();
      },
    );
    // Superseded after we subscribed (a switch raced us): close this socket and
    // don't record it as the live subscription.
    if (gen !== establishGen) {
      sub();
      return;
    }
    unsubscribe = sub;

    // Guarded, like everything below it. An unguarded rejection here aborted
    // the whole of the rest of setup — no board, no system info, no version
    // handshake — and left an EMPTY Home with no error and no retry, because
    // `client` was already set so the reconnect loop saw a live connection.
    try {
      await get().refreshHome();
    } catch (err) {
      console.warn("home refresh failed during setup:", err);
      if (gen === establishGen) {
        set({ engineError: t("errors.homeRefreshFailed") });
      }
      scheduleReconnect(); // the engine answered once; it may answer again
    }
    // Models too: the queue tray must be able to say "downloads paused"
    // right on Home after a relaunch, not only once Settings mounts.
    void get()
      .refreshModels()
      .catch((err) => console.warn("models refresh failed:", err));
    // And readiness, so Home's notes and the workspace banner have facts
    // from the first paint, not from the first download event.
    void get()
      .refreshReadiness()
      .catch((err) => console.warn("readiness refresh failed:", err));
    if (get().currentProject) {
      try {
        await get().refreshBoard();
      } catch (err) {
        console.warn("board refresh failed during setup:", err);
      }
    }
    try {
      // Guard the set twice: `client` here is this establish's own closure,
      // so a superseded establish must not write the old engine's hardware
      // over the new one's (refreshHome/refreshBoard read get().client, so
      // they already resolve against the live engine) — and a frozen store
      // must not have posed hardware replaced by this box's own.
      //
      // The freeze was the one this branch was missing, and it cost real
      // gate time: the wizard's step-2 card reports free RAM and free disk,
      // both of which move between runs, so an answer landing after the pose
      // photographed a different machine. wiz-2 came out at 72 differing
      // pixels or 836 and wiz-4 at 288 or 649 on identical code, both inside
      // budget, so nothing ever went red over it.
      const info = await client.system();
      if (gen === establishGen && !seedFrozen) set({ system: info });
    } catch {
      /* system info is cosmetic at this stage */
    }
    try {
      // This engine's own render-time medians. Guarded by the same
      // generation check as the hardware above, and for a sharper reason:
      // an estimate carried over from the previous engine would be a
      // measurement of the wrong machine, which is exactly the bug the
      // route exists to fix.
      const { etas } = await client.systemEtas();
      if (gen === establishGen) setEngineEtas(etas);
    } catch {
      /* no calibration — estimates fall back to what this session saw */
    }
    try {
      // Version handshake for Settings → About.
      const health = await client.health();
      if (gen === establishGen) {
        set({
          engineVersions: {
            engine_version: health.engine_version,
            api_version: health.api_version,
          },
        });
      }
    } catch {
      /* about-card data only */
    }
  };

  // Concurrent callers share the same attempt; a second establish while one
  // is mid-flight would subscribe twice and leak the first socket.
  const establishOnce = () => {
    if (!establishing) {
      const p = establish().finally(() => {
        // Only clear the slot if THIS attempt still owns it — switchEngine may
        // have replaced it with a fresh establish for the new engine, and
        // nulling that one would let a redundant concurrent establish spawn.
        if (establishing === p) establishing = null;
      });
      establishing = p;
    }
    return establishing;
  };

  // Pair/unpair swap the engine under us: drop every per-engine slice (zustand
  // and module-level) so the old engine's in-flight PATCH, download bytes, and
  // project list can't bleed into the new one, then reconnect.
  /** Readiness is a side-effect of nearly every model action; a refresh
   * that fails is never the reason the action failed. */
  const refreshReadinessQuietly = () => {
    void useApp
      .getState()
      .refreshReadiness()
      .catch((err) => console.warn("readiness refresh failed:", err));
  };

  const switchEngine = async () => {
    resetEngineScopedState();
    // A dismissal is about one engine's models; the newly paired box has
    // its own, and the fingerprints there mean something different.
    sessionReadinessSkips.clear();
    // Timings belong to the machine that measured them. Carrying a laptop's
    // medians onto a GPU box (or the reverse) is worse than having none:
    // the number looks authoritative and is about the wrong hardware.
    setEngineEtas(null);
    set({
      currentProject: null,
      board: null,
      history: null,
      modelDefaults: null,
      jobs: [],
      projects: [],
      models: [],
      downloadErrors: {},
      nodeFailures: {},
      nodeRetries: {},
      // The old engine's hardware/recommendations must not survive the switch
      // (establish repopulates it, or leaves it null if the new engine's
      // /system errors — better blank than another box's specs).
      system: null,
      // Readiness is a claim about the ENGINE's backends and weights —
      // another box's report is wrong the moment the switch lands.
      readiness: null,
      projectReadiness: null,
    });
    // Force a fresh establish for the NEW engine: reusing an in-flight one
    // (e.g. a reconnect already bound to the old connection) would leave the
    // client and WS pointed at the old/dead engine.
    establishing = null;
    await establishOnce();
  };

  return {
    client: null,
    engineError: null,
    actionError: null,
    system: null,
    projects: [],
    currentProject: null,
    openProjects: readOpenTabs(),
    board: null,
    history: null,
    modelDefaults: null,
    jobs: [],
    allJobs: [],
    storage: null,
    storageStale: false,
    engineVersions: null,
    defaults: loadPersisted(DEFAULTS_KEY, FALLBACK_DEFAULTS),
    homeDraft: loadPersisted(DRAFT_KEY, EMPTY_DRAFT),
    graph: null,
    graphError: null,
    selectedNode: null,
    models: [],
    downloadErrors: {},
    nodeFailures: {},
    nodeRetries: {},
    firstRunDone: readFlag(FIRST_RUN_KEY),
    firstRunReturning: false,
    libraryOpen: false,
    libraryFilter: "all",
    librarySearchFocus: 0,
    templates: loadTemplates(),
    templateNotice: null,
    saveTemplateFor: null,
    settingsOpen: false,
    settingsTab: "general",
    editBusy: false,
    remoteEngine: false,
    remotePaired: false,
    remoteKeysArmed: true,
    engineCrash: null,
    notifyOnDone: readFlagDefaultOn(NOTIFY_KEY),
    warnMissingModels: readFlagDefaultOn(WARN_MODELS_KEY),
    readiness: null,
    projectReadiness: null,

    connect: async () => {
      if (get().client) return; // idempotent under StrictMode double-mount
      await establishOnce();
    },

    reconnect: async () => {
      try {
        await establishOnce();
      } catch (err) {
        console.warn("reconnect failed:", err);
      }
      if (!get().client) scheduleReconnect(); // engine still down — keep trying
    },

    restartEngine: async () => {
      // Spawning is the shell's job; the renderer only ever asks. A build
      // whose preload predates the channel says so rather than throwing at
      // the one moment the app is already broken.
      const restart = window.localcut?.restartEngine;
      if (!restart) return t("errors.engineUnavailable");
      const result = await restart();
      if (!result.ok) return result.error ?? t("errors.engineUnavailable");
      // A new engine means a new token, so the client has to be rebuilt
      // before this reports success — `engineError` is what says whether it
      // actually came back.
      await get().reconnect();
      const error = get().engineError;
      // Cleared only on the way back up. Dropping the crash on a failed
      // restart would take the report and the retry off screen while the
      // engine is still down.
      //
      // `actionError` goes with it: whatever the user tried during the
      // outage left "the engine could not be reached" on screen, and a
      // restart that worked makes that sentence false while the status
      // light beside it says connected. The engine that refused the action
      // is a dead process with a spent token — nothing on screen about it
      // describes the app the user now has. A failed restart keeps both,
      // because then it is all still true.
      if (!error) set({ engineCrash: null, actionError: null });
      return error;
    },

    noteEngineCrash: (crash) => set({ engineCrash: crash }),

    setNotifyOnDone: (on) => {
      set({ notifyOnDone: on });
      try {
        localStorage.setItem(NOTIFY_KEY, on ? "1" : "0");
      } catch {
        /* blocked storage — the preference just does not survive a restart */
      }
    },

    setWarnMissingModels: (on) => {
      set({ warnMissingModels: on });
      try {
        localStorage.setItem(WARN_MODELS_KEY, on ? "1" : "0");
      } catch {
        /* blocked storage — the preference just does not survive a restart */
      }
    },

    refreshReadiness: async () => {
      const { client, currentProject } = get();
      if (!client || seedFrozen) return;
      // Settled independently, not Promise.all'd: the project report can
      // 404 (deleted underneath) or 409 (a state file this build refuses),
      // and one bad project must not blank the machine-wide report that
      // Home's notes, the model picker and Settings all read.
      const [machine, project] = await Promise.all([
        client.readiness().catch((err) => {
          console.warn("readiness refresh failed:", err);
          return null;
        }),
        currentProject
          ? client.projectReadiness(currentProject.id).catch((err) => {
              console.warn("project readiness refresh failed:", err);
              return null;
            })
          : null,
      ]);
      // Guard the write like refreshModels: a switchEngine mid-flight
      // already blanked these, and another engine's report must not land.
      if (get().client !== client || seedFrozen) return;
      set({
        ...(machine ? { readiness: machine.rows } : {}),
        // Only meaningful while the SAME project is still open.
        ...(project && get().currentProject?.id === currentProject?.id
          ? { projectReadiness: project.rows }
          : {}),
      });
    },

    readinessGaps: async (scopeKey, kinds) => {
      const { client, warnMissingModels } = get();
      if (!client || !warnMissingModels) return null;
      // Fetched fresh at the click, never from the cached slices: the gate
      // guards a spend, and a stale "ready" is the one lie it must not tell.
      let rows: ReadinessRow[];
      try {
        // A project's own report wins whenever there is one, `kinds` or
        // not: it is the only one that judges per-node model overrides, and
        // narrowing it here is a filter, not a reason to ask a different
        // question. (The engine's project route takes no `kinds`.)
        rows =
          scopeKey === "home"
            ? (await client.readiness(kinds)).rows
            : (await client.projectReadiness(scopeKey)).rows.filter(
                (row) => !kinds || kinds.includes(row.kind),
              );
      } catch {
        // No report is no reason to block a render the engine may well
        // serve — the gate fails open, the job's own error stays the truth.
        return null;
      }
      // A model whose bytes are moving right now is not a gap to warn
      // about: the engine reports it missing (is_downloaded is a
      // completed-files check) but the user is already fixing it, and the
      // pre-readiness code exempted it for exactly this reason — first run
      // hands over mid-download by design.
      const arriving = new Set(
        get()
          .models.filter((row) => row.downloading)
          .map((row) => row.id),
      );
      const gaps = blockingGaps(rows).filter(
        (row) => !(row.fix?.type === "download" && arriving.has(row.fix.model_id)),
      );
      if (gaps.length === 0) return null;
      const key = scopeOf(scopeKey, kinds);
      const fingerprint = readinessFingerprint(gaps);
      if (sessionReadinessSkips.get(key) === fingerprint) return null;
      if (readReadinessSkips()[key] === fingerprint) return null;
      return gaps;
    },

    suppressReadiness: (scopeKey, rows, scope, kinds) => {
      const key = scopeOf(scopeKey, kinds);
      const fingerprint = readinessFingerprint(rows);
      // "always" flips the switch and nothing else: writing a session skip
      // alongside it left this one surface silent even after Settings
      // turned warnings back on, which is what its own hint promises.
      if (scope === "always") {
        get().setWarnMissingModels(false);
        return;
      }
      // "this project" persists and is read back through the same door on
      // the next click, so the durable path is the one exercised rather
      // than being masked by a session entry written alongside it.
      if (scope === "project") writeReadinessSkip(key, fingerprint);
      else sessionReadinessSkips.set(key, fingerprint);
    },

    refreshHome: async () => {
      const { client } = get();
      if (!client || seedFrozen) return;
      // Ids that appear while this request is in flight — see the prune below.
      const createdSince = new Set<string>();
      const track = (id: string) => createdSince.add(id);
      newProjectListeners.add(track);
      try {
        // Jobs ride along for the tile status dots; a jobs failure must not
        // take the project list down with it.
        const [projects, allJobs] = await Promise.all([
          client.listProjects(),
          client.listJobs().catch(() => get().allJobs),
        ]);
        // Guard against a switchEngine/disconnect during the fetch: a late
        // response from the old engine must not overwrite the new one's list
        // (refreshBoard guards the same way via the project id).
        if (get().client !== client) return;
        set({ projects, allJobs });
        // Prune rail tabs whose projects no longer exist — a delete from
        // another surface, or an engine switch (this list belongs to the new
        // engine, so foreign ids fall away here).
        //
        // A project created DURING this round trip is not in `projects` but is
        // not deleted either, so pruning against the snapshot alone would close
        // the tab of the project the user just made. Anything created since the
        // request went out is off-limits to the prune.
        const known = new Set(projects.map((project) => project.id));
        const pruned = get().openProjects.filter(
          (id) => known.has(id) || createdSince.has(id),
        );
        if (pruned.length !== get().openProjects.length) {
          set({ openProjects: pruned });
          saveOpenTabs(pruned);
        }
      } finally {
        newProjectListeners.delete(track);
      }
    },

    openProject: async (id: string) => {
      const { client } = get();
      if (!client) return;
      // Claim this navigation. `establish` guards a superseded call with a
      // generation counter and this path had nothing: a slow response for a
      // project the user has since navigated away from would yank them back
      // to it, mid-typing, with a board they did not ask for.
      const generation = ++openGen;
      // The GET must observe the flushed edits, not race them.
      await flushPatches();
      // Fetch jobs alongside the board: without this the jobs slice keeps
      // showing the previously open project's jobs until some WS event happens
      // to trigger a refresh (never, for an idle project).
      let project: Project;
      let board: Board;
      let jobs: Job[];
      try {
        // The engine refuses a project it cannot read (a state file from a
        // build that wrote the machine's ANSI code page answers 409 with the
        // byte and the offset). Every call site here is a `void
        // openProject(id)` from a tile or a rail row, so an escaping
        // rejection reached window.onerror and the click simply did nothing.
        [{ project, board }, jobs] = await Promise.all([
          client.getProject(id),
          // Jobs are secondary: a transient /jobs failure must not abort opening
          // the project. Empty is fine — the next non-progress job event triggers
          // a board refresh (scheduleRefresh) that repopulates the list.
          client.listJobs(id).catch(() => [] as Job[]),
        ]);
      } catch (err) {
        if (generation !== openGen || get().client !== client) return;
        set({ actionError: { scope: "open", message: messageOf(err) } });
        return;
      }
      // Superseded while we awaited (another openProject, or a closeProject):
      // drop this result rather than navigating backwards into it.
      if (generation !== openGen || get().client !== client) return;
      // Stop playback before the swap — the transport holds scene ids and a
      // playhead from the previous project, meaningless against this board.
      usePlayback.getState().stop();
      const tabs = get().openProjects;
      const openProjects = tabs.includes(id) ? tabs : [...tabs, id];
      if (openProjects !== tabs) saveOpenTabs(openProjects);
      // Keep an optimistic aux edit made mid-load on top of the fetched board,
      // exactly as refreshBoard does, instead of dropping it.
      set({
        currentProject: project,
        openProjects,
        board: withPending(board, id),
        jobs,
        selectedNode: null,
        // Cleared, not refetched: only the flowchart view needs it, and it
        // asks on mount. Carrying the previous project's graph over would
        // draw the wrong DAG for however long the fetch takes.
        graph: null,
        graphError: null,
        // Cleared then fetched: the previous project's undo depths must not
        // enable Ctrl+Z against this one for however long the fetch takes.
        history: null,
        // Keyed by node id, which repeats across projects ("timeline",
        // "s1.clip"), so carrying these over would hang the last project's
        // OOM advice on this one's identically-named node.
        nodeFailures: {},
        nodeRetries: {},
        // Cleared then fetched — the previous project's missing-model
        // banner must not hang over this one's board.
        projectReadiness: null,
      });
      void get().refreshHistory();
      void get()
        .refreshReadiness()
        .catch((err) => console.warn("readiness refresh failed:", err));
    },

    closeProject: () => {
      openGen++; // an openProject still in flight must not land after this
      void flushPatches(); // nothing reads the project after this — fire and forget
      usePlayback.getState().stop();
      set({
        currentProject: null,
        board: null,
        history: null,
        jobs: [],
        selectedNode: null,
        graph: null,
        graphError: null,
        nodeFailures: {},
        nodeRetries: {},
        projectReadiness: null,
      });
    },

    closeOpenProject: (id: string) => {
      const tabs = get().openProjects;
      const index = tabs.indexOf(id);
      if (index < 0) return;
      const openProjects = tabs.filter((tab) => tab !== id);
      set({ openProjects });
      saveOpenTabs(openProjects);
      if (get().currentProject?.id !== id) return;
      // The active tab closed: its right neighbor takes over (else the new
      // last tab), Home when nothing is left — the VS Code convention.
      const next = openProjects[Math.min(index, openProjects.length - 1)];
      if (next) {
        void get()
          .openProject(next)
          .catch(() => get().closeProject());
      } else {
        get().closeProject();
      }
    },

    createFromPrompt: async (prompt, duration, aspect, mode, style) => {
      const { client } = get();
      if (!client) return;
      set({ actionError: null });
      try {
        const project = await client.createProject({
          prompt,
          target_duration_s: duration,
          aspect,
          mode,
          // Absent rather than empty: the engine's own default applies when
          // the UI has no opinion, and "" is not one of its presets.
          ...(style ? { style_preset: style } : {}),
        });
        // Tell any refreshHome already in flight that this id is new, not
        // deleted — its project list snapshot predates the create.
        announceNewProject(project.id);
        await get().openProject(project.id);
        await get().refreshHome();
      } catch (err) {
        console.warn("create project failed:", err);
        set({ actionError: { scope: "create", message: messageOf(err) } });
      }
    },

    createTool: async (tool, input, startFrame) => {
      const { client } = get();
      if (!client) return;
      set({ actionError: null });
      try {
        const project = await client.createTool({ tool, ...input });
        // Tell any refreshHome already in flight that this id is new, not
        // deleted — its project list snapshot predates the create.
        announceNewProject(project.id);
        if (startFrame && tool === "clip") {
          // Condition BEFORE opening: connect displaces the generated
          // keyframe as the clip's source, and removing that node in the
          // same patch keeps the session from rendering a frame nothing
          // consumes. Op order matters — connect first frees the keyframe
          // of its consumer, so the removal is of an unwired node.
          const asset = await client.uploadAsset(project.id, startFrame);
          await client.patch(project.id, [
            { op: "connect", node_id: "clip", src: asset.node_id, port: "keyframe" },
            { op: "remove_node", node_id: "keyframe" },
          ]);
        }
        await get().openProject(project.id);
        await get().refreshHome();
      } catch (err) {
        console.warn(`tool ${tool} failed:`, err);
        set({ actionError: { scope: "tool", message: messageOf(err) } });
      }
    },

    addToProject: async (targetId) => {
      const { client, currentProject, board } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      const tool = currentProject.mode.startsWith("tool:")
        ? currentProject.mode.slice("tool:".length)
        : null;
      const node = tool ? board?.aux[tool] : undefined;
      if (!node?.artifact_hash) return t("errors.engineUnavailable");
      try {
        // Fetch → re-upload, never a path: the engine may be on another
        // machine, and the artifact route is the only door to its bytes.
        const response = await fetch(client.artifactUrl(currentProject.id, node.artifact_hash));
        if (!response.ok) return t("errors.engineUnavailable");
        const blob = await response.blob();
        // The engine names the download (Content-Disposition) — reuse that
        // name so the asset node says what it is; the hash prefix keeps two
        // sessions' "voiceover" outputs from colliding.
        const header = response.headers.get("content-disposition") ?? "";
        const named = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(header)?.[1];
        const name = named ?? `${tool}-${node.artifact_hash.slice(0, 8)}`;
        await client.uploadAsset(targetId, new File([blob], name, { type: blob.type }));
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },


    applySessionVoiceClone: async (file) => {
      const { client, currentProject } = get();
      if (!client) return t("errors.engineUnavailable");
      // Split from the client check rather than collapsed into it. The tool
      // session always has a project, so the two read the same there — but a
      // voice sample dropped on Home reaches this with the engine answering
      // fine, and "engine unavailable" then blames the one part that works.
      if (!currentProject) return t("drop.needsProject");
      try {
        // The consent affirmation was collected in the UI; the engine
        // refuses to stamp the sample without it either way.
        const asset = await client.uploadAsset(currentProject.id, file, { consent: true });
        await client.patch(currentProject.id, [
          { op: "set_model", node_id: "voiceover", model: "local:chatterbox" },
          { op: "connect", node_id: "voiceover", src: asset.node_id, port: "voice_ref" },
        ]);
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    enhance: async (notes) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      set({ actionError: null });
      try {
        // The composer's Script scope reaches this with unflushed inspector
        // edits possibly still pending, and the rewrite amends the screenplay
        // the graph holds NOW — a patch landing after it would be written
        // against a script that had already moved.
        await flushPatches();
        await client.enhanceScript(currentProject.id, notes);
        // The re-render is on the queue; the board flip arrives over WS, but
        // refresh now so the status ring never shows a stale "draft".
        await get().refreshBoard();
        return null;
      } catch (err) {
        console.warn("enhance failed:", err);
        const message = messageOf(err);
        set({ actionError: { scope: "enhance", message } });
        return message;
      }
    },

    dismissActionError: () => set({ actionError: null }),

    setVoice: async (nodeId, voiceId) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        await client.patch(currentProject.id, [
          { op: "set_params", node_id: nodeId, params: { voice_id: voiceId } },
        ]);
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    setVoiceBrief: async (nodeId, brief) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        await client.patch(currentProject.id, [
          // null removes the key, which is what puts the node back on the
          // hash a brief-only render already used — see setVoice above.
          { op: "set_params", node_id: nodeId, params: { voice: brief, voice_id: null } },
        ]);
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    refineTool: async (nodeId, key, value) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        await client.patch(currentProject.id, [
          { op: "set_params", node_id: nodeId, params: { [key]: value } },
        ]);
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    promote: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      set({ actionError: null });
      try {
        const project = await client.promote(currentProject.id);
        // Tell any refreshHome already in flight that this id is new, not
        // deleted — its project list snapshot predates the create.
        announceNewProject(project.id);
        await get().openProject(project.id);
        await get().refreshHome();
      } catch (err) {
        console.warn("promote failed:", err);
        set({ actionError: { scope: "promote", message: messageOf(err) } });
      }
    },

    approve: async (checkpoint) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      const projectId = currentProject.id;
      set({ actionError: null });
      // Was it already approved before this call? If so, the rollback below
      // must NOT strip it — we only ever undo the approval WE optimistically
      // added, never one that pre-existed.
      const alreadyApproved = currentProject.approvals.includes(checkpoint);
      if (!alreadyApproved) {
        set({
          currentProject: {
            ...currentProject,
            approvals: [...currentProject.approvals, checkpoint],
          },
        });
      }
      try {
        await client.approve(projectId, checkpoint);
      } catch (err) {
        console.warn(`approve ${checkpoint} failed:`, err);
        set({ actionError: { scope: "approve", message: messageOf(err) } });
        try {
          const { project } = await client.getProject(projectId);
          if (get().currentProject?.id === projectId) set({ currentProject: project });
        } catch (rollbackErr) {
          // Can't refetch the truth either — at least undo the optimistic
          // approval so the checkpoint banner comes back.
          console.warn("approve rollback fetch failed:", rollbackErr);
          const current = get().currentProject;
          if (!alreadyApproved && current?.id === projectId) {
            set({
              currentProject: {
                ...current,
                approvals: current.approvals.filter((a) => a !== checkpoint),
              },
            });
          }
        }
        return;
      }
      await get().refreshBoard();
    },

    refreshBoard: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject || seedFrozen) return;
      const projectId = currentProject.id;
      // Sequence number, not just a project-id check. Two refreshes for the
      // SAME project can be in flight at once (scheduleRefresh fires on the
      // leading edge and again on the trailing one), and responses arrive in
      // whatever order the engine finishes them — so a slow earlier response
      // could overwrite a newer one and leave the board showing "rendering"
      // for work that had already finished.
      const generation = ++boardGen;
      // The graph is a third read of the same project, and everything that
      // moves the board can move it: a rendered screenplay expanding into a
      // scene per beat, an LLM edit adding a node, a pin from the inspector.
      // Refreshed HERE rather than at each of those call sites, because the
      // canvas went stale exactly by their being enumerated — a first render
      // grew the graph from one node to dozens while the flowchart kept
      // drawing the one. Costs nothing until something holds a graph, and
      // only the flowchart ever asks for one.
      //
      // Started ALONGSIDE the other two rather than after them: it needs
      // nothing they return, and this runs on every progress tick of a live
      // render — chaining it would put a whole extra round trip in that loop,
      // which on a remote engine is the difference the topology is felt in.
      // It guards its own staleness (see refreshGraph), so it is safe to have
      // in flight across the checks below.
      const graphRefresh = get().graph ? get().refreshGraph() : null;
      // History rides every board refresh for the same reason as the graph:
      // everything that moves the board (a patch, an NL edit, a regenerate)
      // is exactly what changes the undo depths.
      const historyRefresh = get().refreshHistory();
      const [{ project, board }, jobs] = await Promise.all([
        client.getProject(projectId),
        client.listJobs(projectId),
      ]);
      // A late response for a previously open project must not clobber the
      // one the user has since opened, and a superseded one must not clobber
      // a fresher response that already landed.
      if (generation !== boardGen || get().currentProject?.id !== projectId) return;
      set({ currentProject: project, board: withPending(board, projectId), jobs });
      // Awaited, not fired and forgotten: a caller that patched the graph is
      // waiting for both pictures to have redrawn before it decides what to
      // say about the edit.
      await graphRefresh;
      await historyRefresh;
    },

    refreshGraph: async () => {
      const { client, currentProject } = get();
      // Frozen like the board: the canvas mounts and asks for the graph, so
      // without this the posed reference graph is replaced by the engine's
      // own between the seed and the shutter.
      if (!client || !currentProject || seedFrozen) return;
      const projectId = currentProject.id;
      const generation = ++graphGen;
      try {
        const graph = await client.graph(projectId);
        // Same guards as refreshBoard: a late response for a project the user
        // has navigated away from must not paint the one they are looking at,
        // and a superseded one must not clobber a fresher one that landed.
        if (generation !== graphGen) return;
        if (get().client !== client || get().currentProject?.id !== projectId) return;
        set({ graph, graphError: null });
      } catch (err) {
        if (generation !== graphGen) return;
        if (get().client !== client || get().currentProject?.id !== projectId) return;
        // Keep the last graph rather than blanking the canvas: a failed
        // refresh is a worse reason to lose the picture than to show a stale
        // one alongside the error.
        set({ graphError: messageOf(err) });
      }
    },

    connectNodes: async (src, dst, port) => patchGraph([{ op: "connect", node_id: dst, src, port }]),

    disconnectPort: async (dst, port) => patchGraph([{ op: "disconnect", node_id: dst, port }]),

    addNode: async (kind) => {
      // The id is computed from the graph in hand rather than asked of the
      // engine: `add_node` refuses a collision, and a refusal is a better
      // failure than a second round trip on every add.
      const id = nextNodeId(get().graph, kind);
      const error = await patchGraph([
        {
          op: "add_node",
          node_id: id,
          // Every field the engine's Node model carries, at its default.
          // `pinned`/`frozen_hash` are server-owned — patch.py zeroes them
          // whatever a client sends — but sending the model's own shape is
          // what keeps this call honest about what an added node IS.
          node: {
            id,
            kind,
            params: {},
            seed: 0,
            model: null,
            pinned: false,
            frozen_hash: null,
          },
        },
      ]);
      // Only on success: selecting a node the graph never received would
      // open Details on nothing.
      if (!error) set({ selectedNode: id });
      return error;
    },

    removeNode: async (nodeId) => {
      const error = await patchGraph([{ op: "remove_node", node_id: nodeId }]);
      // A removed node cannot stay selected: the Details panel would render
      // an inspector for something the graph no longer has.
      if (!error && get().selectedNode === nodeId) set({ selectedNode: null });
      return error;
    },

    regenerate: async (nodeId, seed) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      await client.regenerate(currentProject.id, nodeId, seed);
      await get().refreshBoard();
    },

    rerollWithSeed: async (nodeId, seed) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        // ONE call. `RegenerateBody.seed` exists for exactly this; doing it
        // as set_seed-then-regenerate would leave the node carrying a
        // borrowed seed if the second half failed, which is a silent edit
        // the user never asked for.
        await flushPatches();
        await client.regenerate(currentProject.id, nodeId, seed);
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    applyNode: async (nodeId, changes) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      const ops: Parameters<EngineClient["patch"]>[1] = [];
      if (changes.params && Object.keys(changes.params).length > 0) {
        ops.push({ op: "set_params", node_id: nodeId, params: changes.params });
      }
      if (changes.seed !== undefined) {
        ops.push({ op: "set_seed", node_id: nodeId, seed: changes.seed });
      }
      if (changes.model !== undefined) {
        ops.push({ op: "set_model", node_id: nodeId, model: changes.model });
      }
      if (ops.length === 0) return;
      await client.patch(currentProject.id, ops);
      await get().refreshBoard();
    },

    togglePin: async (nodeId, pin) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      await client.patch(currentProject.id, [{ op: pin ? "pin" : "unpin", node_id: nodeId }]);
      await get().refreshBoard();
    },

    proposeEdit: async (instruction, scope = "project") => {
      const { client, currentProject, editBusy } = get();
      if (!client || !currentProject || editBusy) return null;
      // Same synchronous claim as `edit`: two rapid submits would otherwise
      // both read editBusy=false and fire concurrent LLM calls.
      set({ editBusy: true });
      try {
        // The model's view must include the user's latest manual tweaks, and
        // the revision it reports is what apply is checked against — so a
        // pending patch flushed AFTER this would make every plan stale.
        await flushPatches();
        return await client.proposeEdit(currentProject.id, { instruction, scope });
      } finally {
        set({ editBusy: false });
      }
    },

    applyEditPlan: async (proposal, scope = "project") => {
      const { client, currentProject, editBusy } = get();
      if (!client || !currentProject || editBusy) return null;
      set({ editBusy: true });
      try {
        await flushPatches();
        const result = await client.editApply(currentProject.id, {
          plan: proposal.plan,
          scope,
          revision: proposal.revision,
        });
        await get().refreshBoard();
        return result;
      } finally {
        set({ editBusy: false });
      }
    },

    refreshHistory: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      const projectId = currentProject.id;
      const generation = ++historyGen;
      try {
        const history = await client.history(projectId);
        // Same three guards refreshGraph uses: a superseded read, a project
        // the user has navigated away from, and an engine swapped underneath
        // us (pair/unpair) must all drop their result rather than paint it.
        if (generation !== historyGen) return;
        if (get().client !== client || get().currentProject?.id !== projectId) return;
        // Only when it actually moved. This rides every board refresh, which
        // during a render is several a second, and the depths change only on
        // a graph mutation — so almost every poll would otherwise be a second
        // store write per refresh, re-rendering every useApp() consumer for a
        // freshly parsed object identical to the one on screen.
        if (sameHistory(get().history, history)) return;
        set({ history });
      } catch {
        // Depths are a convenience read model — keep the last known ones
        // rather than flashing the Undo affordances on a failed poll.
      }
    },

    undoEdit: async () => {
      // A debounced inspector patch still in flight is the newest edit; it
      // must land (and be recorded) before "undo" names anything.
      return historyAction((client, projectId) => client.undo(projectId), { redraw: true });
    },

    redoEdit: async () => {
      return historyAction((client, projectId) => client.redo(projectId), { redraw: true });
    },

    createSavepoint: async (label) => {
      // No redraw: naming a version does not change the graph.
      return historyAction((client, projectId) => client.createSavepoint(projectId, label));
    },

    restoreSavepoint: async (savepointId) => {
      return historyAction(
        (client, projectId) => client.restoreSavepoint(projectId, savepointId),
        { redraw: true },
      );
    },

    deleteSavepoint: async (savepointId) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        await client.deleteSavepoint(currentProject.id, savepointId);
        await get().refreshHistory();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    applyOomSuggestion: async (nodeId, code) => {
      const { client, currentProject, board, models, jobs } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      // Every arm below is an ordinary /patch. The failure card is a shortcut
      // to edits the inspector could already make by hand — not a private
      // path around the cycle check and the re-plan.
      const node = nodeOf(board, nodeId);
      try {
        if (code === "lower_resolution") {
          const next = nextResolutionScale(node?.params.resolution_scale);
          if (next === null) return t("failure.alreadySmallest");
          await flushPatches();
          await client.patch(currentProject.id, [
            { op: "set_params", node_id: nodeId, params: { resolution_scale: next } },
          ]);
          await get().refreshBoard();
          return null;
        }
        if (code === "smaller_model") {
          const smaller = smallerModelFor(
            nodeId,
            models,
            modelThatFailed(nodeId, jobs, node),
          );
          if (smaller === null) return t("failure.noSmallerModel");
          await flushPatches();
          await client.patch(currentProject.id, [
            { op: "set_model", node_id: nodeId, model: smaller.id },
          ]);
          await get().refreshBoard();
          return null;
        }
      } catch (err) {
        return messageOf(err);
      }
      // `cloud` is the one suggestion that is not a graph edit: it needs a
      // provider key, which lives in Settings and is a spending decision.
      // Sending the user there IS the next step — quietly wiring a cloud
      // model would bill them for a click they read as "retry".
      if (code === "cloud") {
        get().openSettings("providers");
        return null;
      }
      return t("failure.unknownSuggestion");
    },

    selectTake: async (nodeId, outputHash) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        await flushPatches();
        await client.patch(currentProject.id, [
          { op: "select_take", node_id: nodeId, take: outputHash },
        ]);
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    addScene: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        await flushPatches();
        const known = new Set((get().board?.scenes ?? []).map((scene) => scene.scene_id));
        const { dirty } = await client.patch(currentProject.id, [
          { op: "add_scene", node_id: "" },
        ]);
        // Select the new scene's keyframe so the Inspector opens on the
        // prompt the user is about to write — an edit before the blank
        // draft renders supersedes its queued job.
        const added = dirty.find(
          (id) => id.endsWith(".keyframe") && !known.has(id.split(".")[0]),
        );
        if (added) set({ selectedNode: added });
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    removeScene: async (sceneId) => {
      const { client, currentProject, selectedNode } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        await flushPatches();
        await client.patch(currentProject.id, [{ op: "remove_scene", node_id: sceneId }]);
        // The Inspector cannot stay open on a node that is gone: its panel
        // reads the board for the selection and would render an empty
        // editor over "Apply & regenerate" for a scene nobody can see.
        if (selectedNode?.split(".")[0] === sceneId) set({ selectedNode: null });
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    refreshModelDefaults: async () => {
      const { client } = get();
      if (!client) return;
      try {
        const modelDefaults = await client.modelDefaults();
        // Guarded like refreshModels: these are engine-scoped, switchEngine
        // already blanked them, and landing the OLD box's per-task defaults
        // on the new one is exactly the bleed it prevents.
        if (get().client !== client) return;
        set({ modelDefaults });
      } catch (err) {
        console.warn("model defaults refresh failed:", err);
      }
    },

    setModelDefault: async (task, model) => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        const modelDefaults = await client.setModelDefault(task, model);
        if (get().client !== client) return null;
        set({ modelDefaults });
        // The default IS what Auto resolves to, so the picker's own "Auto —
        // X" label and every readiness verdict move with it.
        refreshReadinessQuietly();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    cancelJob: async (jobId) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.cancelJob(jobId);
      } catch (err) {
        // 409 = it finished (or died) before the click landed; the refresh
        // below shows the truth either way.
        console.warn(`cancel job ${jobId} failed:`, err);
      }
      await get().refreshBoard();
    },

    conditionScene: async (sceneId, file) => {
      const { client, currentProject, board } = get();
      // Reports rather than throwing, like every other action that can be
      // refused. It used to throw, and its only caller logged the failure to
      // a console the user cannot see — so a photo that never uploaded looked
      // exactly like one that did, until the render came back unchanged.
      if (!client) return t("errors.engineUnavailable");
      if (!currentProject) return t("drop.needsProject");
      try {
        const asset = await client.uploadAsset(currentProject.id, file);
        // Every take of the scene draws from the same source image, exactly
        // like the generated keyframe it displaces.
        const scene = board?.scenes.find((entry) => entry.scene_id === sceneId);
        const takes = [
          `${sceneId}.clip`,
          ...(scene?.clip_takes ?? [])
            .filter((take): take is NodeState => take !== null)
            .map((take) => take.node_id),
        ];
        await client.patch(
          currentProject.id,
          takes.map((nodeId) => ({
            op: "connect",
            node_id: nodeId,
            src: asset.node_id,
            port: "keyframe",
          })),
        );
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    clearSceneStill: async (sceneId) => {
      const { client, currentProject, board } = get();
      if (!client) return t("errors.engineUnavailable");
      if (!currentProject) return t("drop.needsProject");
      const scene = board?.scenes.find((entry) => entry.scene_id === sceneId);
      // Put the GENERATED keyframe back on the port, rather than
      // disconnecting: `connect` replaces the edge, so this is the exact
      // inverse of conditioning. A bare disconnect would leave the clip with
      // no picture at all, which the compiler reads as not ready — the scene
      // would stop rendering instead of going back to how it started.
      //
      // So a scene whose generated node was removed cannot be restored, and
      // the caller does not offer it: there is nothing to fall back TO.
      if (!scene?.keyframe) return t("errors.noGeneratedKeyframe");
      try {
        const takes = [
          `${sceneId}.clip`,
          ...(scene.clip_takes ?? [])
            .filter((take): take is NodeState => take !== null)
            .map((take) => take.node_id),
        ];
        await client.patch(
          currentProject.id,
          takes.map((nodeId) => ({
            op: "connect",
            node_id: nodeId,
            src: scene.keyframe!.node_id,
            port: "keyframe",
          })),
        );
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    uploadSceneImage: async (file) => {
      const { client, currentProject } = get();
      if (!client) return { error: t("errors.engineUnavailable") };
      if (!currentProject) return { error: t("drop.needsProject") };
      try {
        const asset = await client.uploadAsset(currentProject.id, file);
        return { nodeId: asset.node_id };
      } catch (err) {
        return { error: messageOf(err) };
      }
    },

    suggestScene: async (nodeId, model, signal) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return { error: t("errors.engineUnavailable") };
      try {
        return await client.suggestScene(currentProject.id, nodeId, model, signal);
      } catch (err) {
        // A caller-aborted read is not a failure with something to say: the
        // user cancelled, and the dialog they cancelled from is still open
        // with its fields intact.
        if (signal?.aborted) return {};
        return { error: messageOf(err) };
      }
    },

    addSceneFromImage: async (nodeId, fields) => {
      const { client, currentProject } = get();
      if (!client) return t("errors.engineUnavailable");
      if (!currentProject) return t("drop.needsProject");
      try {
        await flushPatches();
        const known = new Set((get().board?.scenes ?? []).map((scene) => scene.scene_id));
        // One op, doing all three things: the words, the scene, and the
        // picture it is built on.
        //
        // The words ride along because `add_scene` compiles them straight
        // into the new keyframe and narration nodes, so the scene is never
        // briefly blank — and blank is what the compiler reads as "not
        // ready", which would enqueue nothing and then enqueue everything a
        // moment later.
        //
        // The image rides along for a sharper reason: wiring it in a SECOND
        // patch means the first one enqueues the generated keyframe — which
        // still feeds the clip at that moment — and renders it in full
        // before the connect displaces it. `src` on the op makes the engine
        // wire the asset as it builds the scene, so that node is orphaned
        // before anything is queued. It also makes this atomic: two patches
        // can half-succeed, and a wordless pictureless scene is one the
        // user's next attempt duplicates rather than repairs.
        const { dirty } = await client.patch(currentProject.id, [
          { op: "add_scene", node_id: "", src: nodeId, params: { ...fields } },
        ]);
        // The CLIP, unlike `addScene` above, which selects the keyframe so
        // the Inspector opens on the prompt still to be written. Here that
        // prompt has just been written, and the keyframe this op minted is
        // the node `src` orphaned — so selecting it would open the panel on
        // a tile marked "not needed" the moment the scene was created.
        //
        // Best-effort either way: the scene and its picture have landed, so
        // failing to spot the new id is nothing to report.
        const added = dirty.find((id) => id.endsWith(".clip") && !known.has(id.split(".")[0]));
        if (added) set({ selectedNode: added });
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    applyClonedVoice: async (file) => {
      const { client, currentProject, board } = get();
      if (!client || !currentProject || !board) return;
      // The consent affirmation was collected in the UI; the engine refuses
      // the sample without it either way.
      const asset = await client.uploadAsset(currentProject.id, file, { consent: true });
      // One speaker across the whole video: every scene's narration clones
      // from the same sample.
      const narrations = board.scenes
        .map((scene) => scene.narration)
        .filter((node): node is NodeState => node !== null);
      await client.patch(
        currentProject.id,
        narrations.flatMap((node) => [
          { op: "set_model", node_id: node.node_id, model: "local:chatterbox" },
          { op: "connect", node_id: node.node_id, src: asset.node_id, port: "voice_ref" },
        ]),
      );
      await get().refreshBoard();
    },

    applyTimeline: (params) => applyAuxParams("timeline", params),

    applyExport: (params) => applyAuxParams("export", params),

    preparePublish: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        await flushPatches();
        await client.package(currentProject.id);
        await get().refreshBoard();
        return null;
      } catch (err) {
        // The engine's 409 here is an answer, not a fault: "script has not
        // rendered yet" means there is nothing to write a title from.
        return messageOf(err);
      }
    },

    resumeRender: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return t("errors.engineUnavailable");
      try {
        // Same discipline as finalize: the engine must compile against the
        // flushed params rather than race them.
        await flushPatches();
        await client.render(currentProject.id);
        await get().refreshBoard();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },

    finalize: async () => {
      const { client, currentProject, defaults } = get();
      if (!client || !currentProject) return;
      // The engine must compile with the flushed params, not race them.
      await flushPatches();
      // Settings → Defaults' video model rides along (engine config wins
      // engine-side when this is null).
      await client.finalize(currentProject.id, defaults.videoModel);
      await get().refreshBoard();
    },

    select: (nodeId) => set({ selectedNode: nodeId }),

    refreshModels: async () => {
      const { client } = get();
      if (!client || seedFrozen) return;
      const rows = await client.listModels();
      // Guard the write like refreshHome/refreshBoard do: a pair/unpair during
      // the round trip already blanked `models`, and landing the OLD engine's
      // catalog on the new one is exactly the bleed switchEngine prevents.
      if (get().client !== client || seedFrozen) return;
      set({ models: reconcileModels(rows) });
    },

    startDownload: async (modelId) => {
      const { client, downloadErrors } = get();
      if (!client) return;
      if (modelId in downloadErrors) {
        const { [modelId]: _dropped, ...rest } = downloadErrors;
        set({ downloadErrors: rest });
      }
      try {
        await client.startDownload(modelId);
        // A fresh start voids any previous terminal state and byte counts.
        terminalDownloads.delete(modelId);
        wsProgress.delete(modelId);
      } catch (err) {
        set({
          downloadErrors: { ...get().downloadErrors, [modelId]: messageOf(err) },
        });
      }
      await get().refreshModels();
    },

    cancelDownload: async (modelId) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.cancelDownload(modelId);
      } catch (err) {
        // 409 = already finished; the refresh below shows the truth.
        console.warn(`cancel ${modelId} failed:`, err);
      }
      await get().refreshModels();
    },

    deleteModel: async (modelId) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.deleteModel(modelId);
      } catch (err) {
        set({
          downloadErrors: { ...get().downloadErrors, [modelId]: messageOf(err) },
        });
      }
      await get().refreshModels();
      // Deleting weights can turn a ready stage back into a placeholder —
      // the banner and the model picker have to hear about it now, not at
      // the next unrelated download event.
      refreshReadinessQuietly();
    },

    inspectPairing: (code) => window.localcut.inspectPairing(code),

    pairRemote: async (code, armKeys = false) => {
      const { ok, error } = await window.localcut.pairEngine(code, { armKeys });
      if (!ok) return error ?? t("errors.pairingFailed");
      await switchEngine(); // the engine changed under us — reset and reconnect
      return null;
    },

    armRemoteKeys: async () => {
      const { ok, error } = await window.localcut.armProviderKeys();
      // `ok` means the keys reached the engine AND the consent was recorded
      // on the pairing (the handler does them in that order), so this cannot
      // claim armed for a push that failed.
      if (ok) set({ remoteKeysArmed: true });
      return ok ? null : (error ?? t("errors.pairingFailed"));
    },

    unpairRemote: async () => {
      const { ok, error } = await window.localcut.unpairEngine();
      await switchEngine();
      return ok ? null : (error ?? t("errors.disconnectFailed"));
    },

    finishFirstRun: () => {
      localStorage.setItem(FIRST_RUN_KEY, "1");
      set({ firstRunDone: true, firstRunReturning: false });
    },

    resetFirstRun: () => {
      localStorage.removeItem(FIRST_RUN_KEY);
      // Returning, not first-running: the wizard opens on the machine step.
      set({ firstRunDone: false, firstRunReturning: true, settingsOpen: false });
    },

    // The Library takes the viewport the way Home does: the open project
    // steps aside (its rail tab stays) and Settings closes over nothing.
    openLibrary: (options = {}) => {
      if (get().currentProject) get().closeProject();
      set((state) => ({
        libraryOpen: true,
        settingsOpen: false,
        ...(options.filter ? { libraryFilter: options.filter } : {}),
        ...(options.focusSearch ? { librarySearchFocus: state.librarySearchFocus + 1 } : {}),
      }));
    },

    closeLibrary: () => set({ libraryOpen: false }),

    setLibraryFilter: (filter) => set({ libraryFilter: filter }),

    openSettings: (tab) =>
      set(tab ? { settingsOpen: true, settingsTab: tab } : { settingsOpen: true }),

    setSettingsTab: (tab) => set({ settingsTab: tab }),

    closeSettings: () => set({ settingsOpen: false }),

    // -- project lifecycle (review 4) — optimistic, with rollback ----------

    deleteProject: async (id) => {
      const { client, projects } = get();
      if (!client) return t("errors.engineUnavailable");
      const removed = projects.find((project) => project.id === id);
      set({ projects: projects.filter((project) => project.id !== id) });
      get().closeOpenProject(id); // drops the rail tab; activates a neighbor
      try {
        await client.deleteProject(id);
        forgetEditLog(id); // only once the engine agreed it is gone
        forgetPublishDraft(id);
        return null;
      } catch (err) {
        console.warn("delete project failed:", err);
        // Reverse only THIS change against the live list — restoring a stale
        // whole-array snapshot would clobber any concurrent lifecycle op (e.g.
        // resurrect a project a second delete already removed).
        if (removed && !get().projects.some((project) => project.id === id)) {
          set({ projects: [removed, ...get().projects] });
        }
        return messageOf(err);
      }
    },

    // Clearing the quick-tool history is a loop over the delete route, not a
    // bulk one: DELETE /projects/{id} already reserves, cancels and purges in
    // the order that survives an interrupted delete, and a second engine path
    // doing the same thing in bulk would have to re-establish all of it.
    //
    // Sequential on purpose — the engine serialises these behind one lock, so
    // firing them together only queues them with a less useful failure report.
    deleteToolSessions: async () => {
      if (!get().client) return t("errors.engineUnavailable");
      const doomed = get()
        .projects.filter((project) => project.mode.startsWith("tool:"))
        .map((project) => project.id);
      if (doomed.length === 0) return null;
      // Close every doomed tab in ONE step, before the loop. deleteProject
      // closes them one at a time, and closing the ACTIVE tab activates its
      // neighbour — which here is the next session the loop is about to
      // delete. Left alone, clearing history loads each doomed session's
      // board and jobs on the way past, so the workspace flickers through
      // them against a burst of requests for projects that are being erased.
      const condemned = new Set(doomed);
      const tabs = get().openProjects;
      const survivors = tabs.filter((id) => !condemned.has(id));
      if (survivors.length !== tabs.length) {
        set({ openProjects: survivors });
        saveOpenTabs(survivors);
      }
      const current = get().currentProject;
      if (current && condemned.has(current.id)) get().closeProject();
      let failure: string | null = null;
      for (const id of doomed) {
        const error = await get().deleteProject(id);
        // Keep going: one project wedged by a running job should not strand
        // the rest, and the count in Settings re-measures either way.
        if (error && !failure) failure = error;
      }
      return failure;
    },

    renameProject: async (id, title) => {
      const { client, projects } = get();
      if (!client) return t("errors.engineUnavailable");
      const original = projects.find((project) => project.id === id);
      set({
        projects: projects.map((project) =>
          project.id === id ? { ...project, title } : project,
        ),
      });
      const current = get().currentProject;
      if (current?.id === id) set({ currentProject: { ...current, title } });
      try {
        await client.renameProject(id, title);
        return null;
      } catch (err) {
        console.warn("rename project failed:", err);
        // Revert only this project's title against the live list, not a stale
        // whole-array snapshot (which would clobber a concurrent op).
        if (original) {
          set({
            projects: get().projects.map((project) =>
              project.id === id ? { ...project, title: original.title } : project,
            ),
          });
          const cur = get().currentProject;
          if (cur?.id === id) set({ currentProject: { ...cur, title: original.title } });
        }
        return messageOf(err);
      }
    },

    duplicateProject: async (id) => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        const copy = await client.duplicateProject(id);
        set({ projects: [copy, ...get().projects] });
        return null;
      } catch (err) {
        console.warn("duplicate project failed:", err);
        return messageOf(err);
      }
    },

    // -- templates: a project's shape, reusable (U2) ------------------------

    openSaveTemplate: (project) => set({ saveTemplateFor: project }),

    closeSaveTemplate: () => set({ saveTemplateFor: null }),

    saveTemplate: async (projectId, name) => {
      const { client, templates } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        const doc = await client.exportTemplate(projectId, name);
        const reason = refuseReason(doc, templates);
        if (reason === "limit") return t("errors.templateLimit", { limit: TEMPLATE_LIMIT });
        if (reason === "size") return t("errors.templateSize");
        const entry: TemplateEntry = {
          // Date.now() is the save time and the id both — two saves inside a
          // millisecond would collide, so the name disambiguates.
          id: `${Date.now().toString(36)}-${name.slice(0, 12)}`,
          name,
          savedAt: Date.now(),
          doc,
        };
        const next = [entry, ...templates];
        saveTemplates(next);
        set({ templates: next });
        return null;
      } catch (err) {
        console.warn("save template failed:", err);
        return messageOf(err);
      }
    },

    startFromTemplate: async (id, title) => {
      const { client, templates } = get();
      if (!client) return t("errors.engineUnavailable");
      const entry = templates.find((row) => row.id === id);
      if (!entry) return t("errors.templateMissing");
      try {
        const result = await client.createFromTemplate(entry.doc, title ?? "");
        announceNewProject(result.project.id);
        // Surfaced, never blocking: what this template will spend on cloud
        // renders, and what could not travel with the shape. Set BEFORE the
        // project opens so the notice is already there when it does.
        set({
          templateNotice:
            result.cloud_models.length > 0 || result.dropped_assets > 0
              ? {
                  title: result.project.title,
                  cloudModels: result.cloud_models,
                  droppedAssets: result.dropped_assets,
                }
              : null,
        });
        await get().openProject(result.project.id);
        await get().refreshHome();
        return null;
      } catch (err) {
        console.warn("create from template failed:", err);
        return messageOf(err);
      }
    },

    deleteTemplate: (id) => {
      const next = get().templates.filter((entry) => entry.id !== id);
      saveTemplates(next);
      set({ templates: next });
    },

    dismissTemplateNotice: () => set({ templateNotice: null }),

    refreshStorage: async () => {
      const { client } = get();
      if (!client) return;
      try {
        const info = await client.storage();
        if (get().client !== client) return; // engine switched mid-flight
        set({ storage: info, storageStale: false });
      } catch (err) {
        // Keep the last values (better than a blank pane) but mark them
        // stale so the pane can say so instead of passing them off as live.
        console.warn("storage overview failed:", err);
        set({ storageStale: true });
      }
    },

    cleanupStorage: async () => {
      const { client } = get();
      if (!client) return null;
      try {
        const { freed_bytes } = await client.storageCleanup();
        await get().refreshStorage();
        return freed_bytes;
      } catch (err) {
        console.warn("cache cleanup failed:", err);
        return null;
      }
    },

    nodePacks: null,
    workflows: [],

    refreshComfy: async () => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        // Both together: the pane's whole job is showing workflows AGAINST
        // the grants they are judged by, and one arriving without the other
        // renders a document as broken when the answer is "enable a pack".
        const [nodePacks, workflows] = await Promise.all([client.nodePacks(), client.workflows()]);
        set({ nodePacks, workflows });
      } catch (err) {
        return messageOf(err);
      }
      return null;
    },

    enableNodePack: async (packId, version, acknowledged) => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        await client.enableNodePack(packId, version, acknowledged);
      } catch (err) {
        return messageOf(err);
      }
      // Refetch rather than patch the row in place: enabling a pack can
      // change the verdict on every installed workflow, not just this one.
      return await get().refreshComfy();
    },

    disableNodePack: async (packId) => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        await client.disableNodePack(packId);
      } catch (err) {
        return messageOf(err);
      }
      return await get().refreshComfy();
    },

    importWorkflow: async (name, workflow) => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        await client.importWorkflow(name, workflow);
      } catch (err) {
        return messageOf(err);
      }
      return await get().refreshComfy();
    },

    deleteWorkflow: async (name) => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        await client.deleteWorkflow(name);
      } catch (err) {
        return messageOf(err);
      }
      return await get().refreshComfy();
    },

    addCustomModel: async (body) => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        await client.addCustomModel(body);
      } catch (err) {
        return messageOf(err);
      }
      await get().refreshModels();
      // A registered local-file model can make a whole stage renderable.
      refreshReadinessQuietly();
      return null;
    },

    deleteCustomModel: async (modelId) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.deleteCustomModel(modelId);
      } catch (err) {
        set({
          downloadErrors: { ...get().downloadErrors, [modelId]: messageOf(err) },
        });
      }
      await get().refreshModels();
      refreshReadinessQuietly();
    },

    setDefaults: (patch) => {
      const next = { ...get().defaults, ...patch };
      set({ defaults: next });
      try {
        localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next));
      } catch {
        /* storage full — the baseline just won't persist */
      }
    },

    setHomeDraft: (patch) => {
      const next = { ...get().homeDraft, ...patch };
      set({ homeDraft: next });
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      } catch {
        /* storage full — the draft just won't persist */
      }
    },
  };
});

/**
 * The rig's state-injection hook. Installed ONLY when the preload bridge
 * says the shell was launched with LOCALCUT_SEED_HOOK (which main.ts
 * strips in packaged builds) — so in production this function never
 * exists, and there is no path to it from the UI.
 *
 * Why it exists: states like "downloading · 51%" cannot be posed through
 * the real engine — bytes keep moving. The parity screenshots and the
 * wizard's step-4 tests need exactly such frozen frames, so the rig
 * writes a fixture and freezes refreshes (plan doc 11, rule 3).
 */
if (typeof window !== "undefined" && window.localcut?.seedHookEnabled) {
  window.__localcutSeed = (patch: SeedPatch) => {
    if (patch.freeze !== undefined) seedFrozen = patch.freeze;
    const next: Partial<AppState> = {};
    if (patch.system !== undefined) next.system = patch.system;
    if (patch.models !== undefined) next.models = patch.models;
    if (patch.projects !== undefined) next.projects = patch.projects;
    if (patch.allJobs !== undefined) next.allJobs = patch.allJobs;
    if (patch.openProjects !== undefined) next.openProjects = patch.openProjects;
    if (patch.board !== undefined) next.board = patch.board;
    if (patch.jobs !== undefined) next.jobs = patch.jobs;
    if (patch.graph !== undefined) next.graph = patch.graph;
    if (patch.selectedNode !== undefined) next.selectedNode = patch.selectedNode;
    if (patch.nodeFailures !== undefined) next.nodeFailures = patch.nodeFailures;
    if (patch.nodeRetries !== undefined) next.nodeRetries = patch.nodeRetries;
    if (Object.keys(next).length > 0) useApp.setState(next);
  };
}
