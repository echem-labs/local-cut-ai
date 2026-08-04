import { Clapperboard, Film, MoreHorizontal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Project } from "../api/types";
import { m, t } from "../i18n";
import { shortcutLabel } from "../lib/platform";
import type { TileStatus } from "../lib/tiles";
import { relativeTime, shortDuration } from "../lib/time";
import { isToolSession, TOOL_ICONS, toolKindOf } from "../lib/tools";
import { useApp } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";

/* one three-step icon scale (review 4 §S10) */
const ICON_CONTROL = { size: 15, strokeWidth: 1.8 } as const;
const ICON_ILLUSTRATIVE = { size: 22, strokeWidth: 1.5 } as const;

export interface TileActions {
  menuOpen: boolean;
  renaming: boolean;
  renameDraft: string;
  onOpen: () => void;
  onToggleMenu: () => void;
  onStartRename: () => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Projects only — a tool session has no shape to save (plan doc 11, U2). */
  onSaveTemplate?: () => void;
}

/**
 * One project (or tool session) as a tile: thumbnail, title, status dot,
 * lifecycle menu. Purely presentational — Home's Continue shelf and the
 * Library both render it, and both keep "one menu open at a time" in their
 * own state, which is what `useTileLifecycle` below is for.
 */
export function ProjectTile({
  project,
  status,
  actions,
}: {
  project: Project;
  status: TileStatus;
  actions: TileActions;
}) {
  const toolKind = toolKindOf(project);
  const client = useApp((state) => state.client);
  const thumbUrl =
    project.thumb_hash && client ? client.artifactUrl(project.id, project.thumb_hash) : null;
  const ToolIcon = toolKind ? (TOOL_ICONS[toolKind] ?? Film) : null;
  const meta = `${t(`home.status.${status}`)} · ${relativeTime(
    project.updated_at ?? project.created_at,
  )}`;
  return (
    <div
      className="project-tile"
      data-project={project.id}
      onContextMenu={(event) => {
        event.preventDefault();
        actions.onToggleMenu();
      }}
      onKeyDown={(event) => {
        if (event.key === "F2" && !actions.renaming) {
          event.preventDefault();
          actions.onStartRename();
        }
      }}
    >
      <button
        className="tile-open"
        onClick={actions.onOpen}
        aria-label={t("home.openProjectAria", { title: project.title })}
      >
        <div className="tile-thumb">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt=""
              loading="lazy"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          ) : ToolIcon ? (
            <ToolIcon {...ICON_ILLUSTRATIVE} aria-hidden="true" />
          ) : (
            <Clapperboard {...ICON_ILLUSTRATIVE} aria-hidden="true" />
          )}
          {toolKind && <span className="tile-tool">{m().tools[toolKind].label}</span>}
          {!isToolSession(project) && project.duration_s != null && project.duration_s > 0 && (
            <span className="tile-dur">{shortDuration(project.duration_s)}</span>
          )}
        </div>
        {!actions.renaming && (
          <div className="tile-body">
            <div className="title">{project.title}</div>
            <div className="meta">
              <i className={`dot ${status}`} aria-hidden="true" />
              {meta}
            </div>
          </div>
        )}
      </button>
      {actions.renaming && (
        <div className="tile-body">
          <input
            className="tile-rename"
            value={actions.renameDraft}
            autoFocus
            aria-label={t("home.renameAria", { title: project.title })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => actions.onRenameChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") actions.onRenameCommit();
              if (event.key === "Escape") actions.onRenameCancel();
            }}
            onBlur={actions.onRenameCommit}
          />
        </div>
      )}
      <button
        className="tile-kebab"
        aria-label={t("home.tileMenuAria", { title: project.title })}
        aria-expanded={actions.menuOpen}
        onClick={(event) => {
          event.stopPropagation();
          actions.onToggleMenu();
        }}
      >
        <MoreHorizontal {...ICON_CONTROL} />
      </button>
      {actions.menuOpen && (
        <div className="menu-pop" role="menu">
          <button role="menuitem" onClick={actions.onOpen}>
            {t("common.open")}
          </button>
          <button role="menuitem" onClick={actions.onStartRename}>
            {t("common.rename")}
            <small>{shortcutLabel(t("common.keys.rename"))}</small>
          </button>
          <button role="menuitem" onClick={actions.onDuplicate}>
            {t("common.duplicate")}
          </button>
          {actions.onSaveTemplate && (
            <button role="menuitem" onClick={actions.onSaveTemplate}>
              {t("library.saveTemplate")}
            </button>
          )}
          <div className="rule" aria-hidden="true" />
          <button role="menuitem" className="danger" onClick={actions.onDelete}>
            {t("common.delete")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The lifecycle state a grid of tiles shares: which menu is open, which tile
 * is being renamed, the delete confirmation, and the one error line the
 * screen shows for all of it. Two screens render tiles now; without this the
 * second one would either duplicate the state machine or quietly diverge
 * from the first (F2 renaming here but not there, and so on).
 */
export function useTileLifecycle(options: { onSaveTemplate?: (project: Project) => void } = {}) {
  const { openProject, deleteProject, renameProject, duplicateProject } = useApp();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The context menu closes on any press outside its own tile.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(`[data-project="${menuFor}"]`)) {
        setMenuFor(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor]);

  const commitRename = async (project: Project) => {
    const title = renameDraft.trim();
    setRenaming(null);
    if (!title || title === project.title) return;
    setError(await renameProject(project.id, title));
  };

  const bind = (project: Project): TileActions => ({
    menuOpen: menuFor === project.id,
    renaming: renaming === project.id,
    renameDraft,
    onOpen: () => {
      setMenuFor(null);
      void openProject(project.id);
    },
    onToggleMenu: () => setMenuFor(menuFor === project.id ? null : project.id),
    onStartRename: () => {
      setMenuFor(null);
      setRenaming(project.id);
      setRenameDraft(project.title);
    },
    onRenameChange: setRenameDraft,
    onRenameCommit: () => void commitRename(project),
    onRenameCancel: () => setRenaming(null),
    onDuplicate: async () => {
      setMenuFor(null);
      setError(await duplicateProject(project.id));
    },
    onDelete: () => {
      setMenuFor(null);
      setConfirmDelete(project);
    },
    ...(options.onSaveTemplate && !isToolSession(project)
      ? {
          onSaveTemplate: () => {
            setMenuFor(null);
            options.onSaveTemplate?.(project);
          },
        }
      : {}),
  });

  const dialog: ReactNode = confirmDelete ? (
    <ConfirmDialog
      // A one-off output is not a project: promising to cancel running jobs
      // and remove "all generated media" overstates what is at stake and
      // makes deleting a stray thumbnail feel unsafe.
      title={t(toolKindOf(confirmDelete) ? "home.deleteToolTitle" : "home.deleteTitle", {
        title: confirmDelete.title,
      })}
      message={t(toolKindOf(confirmDelete) ? "home.deleteToolMessage" : "home.deleteMessage")}
      confirmLabel={t(toolKindOf(confirmDelete) ? "home.deleteToolConfirm" : "home.deleteConfirm")}
      danger
      onCancel={() => setConfirmDelete(null)}
      onConfirm={() => {
        const target = confirmDelete;
        setConfirmDelete(null);
        void deleteProject(target.id).then(setError);
      }}
    />
  ) : null;

  return { bind, dialog, error, clearError: () => setError(null) };
}
