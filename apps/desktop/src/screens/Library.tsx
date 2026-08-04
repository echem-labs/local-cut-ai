import { ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../api/types";
import { FilterTabs } from "../components/FilterTabs";
import { ProjectTile, useTileLifecycle } from "../components/ProjectTile";
import { plural, t } from "../i18n";
import { tileStatus } from "../lib/tiles";
import { isToolSession } from "../lib/tools";
import { useApp, type LibraryFilter } from "../store";

const ICON_CONTROL = { size: 15, strokeWidth: 1.8 } as const;

type SortKey = "recent" | "created" | "name" | "duration";
const SORTS: SortKey[] = ["recent", "created", "name", "duration"];
const SORT_LABEL: Record<SortKey, "sortRecent" | "sortCreated" | "sortName" | "sortDuration"> = {
  recent: "sortRecent",
  created: "sortCreated",
  name: "sortName",
  duration: "sortDuration",
};
/** Which way each field starts. A date or a length reads newest/longest
 * first; a title reads A first. Picking the field again flips it. */
const SORT_STARTS_DESCENDING: Record<SortKey, boolean> = {
  recent: true,
  created: true,
  name: false,
  duration: true,
};

/** One page of tiles. The grid is fluid (auto-fill), so this is deliberately
 * a multiple of every column count it can land on — 24 fills 4, 6 or 8
 * columns exactly, and no row is left half-empty above the button. */
const PAGE = 24;

const stamp = (project: Project) => project.updated_at ?? project.created_at;

/**
 * Everything this machine has made, in one screen (plan doc 11, U2). The
 * split that used to be a tab on Home and a list in the rail is a filter
 * here: a video is a project, a tool output is one artifact, and both are
 * the same tile with the same status oracle.
 */
export function Library() {
  const { projects, allJobs, libraryFilter, setLibraryFilter, librarySearchFocus, openSaveTemplate } =
    useApp();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [desc, setDesc] = useState(SORT_STARTS_DESCENDING.recent);
  const [sortOpen, setSortOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const searchRef = useRef<HTMLInputElement>(null);
  const tiles = useTileLifecycle({ onSaveTemplate: openSaveTemplate });

  const videos = useMemo(() => projects.filter((project) => !isToolSession(project)), [projects]);
  const tools = useMemo(() => projects.filter(isToolSession), [projects]);
  const counts = { all: projects.length, videos: videos.length, tools: tools.length };

  const visible = useMemo(() => {
    const pool =
      libraryFilter === "videos" ? videos : libraryFilter === "tools" ? tools : projects;
    const q = search.trim().toLowerCase();
    const matched = q
      ? pool.filter((project) => project.title.toLowerCase().includes(q))
      : pool;
    // Compared one way and reversed at the end, so a flipped direction can
    // never disagree with the un-flipped one about ties.
    const ascending = (a: Project, b: Project) =>
      sort === "name"
        ? // Code-unit order, not localeCompare: two machines must agree on
          // what this list looks like (plan doc 11, cross-cutting).
          (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
        : sort === "created"
          ? a.created_at - b.created_at
          : sort === "duration"
            ? (a.duration_s ?? 0) - (b.duration_s ?? 0)
            : stamp(a) - stamp(b);
    return [...matched].sort((a, b) => (desc ? -ascending(a, b) : ascending(a, b)));
  }, [projects, videos, tools, libraryFilter, search, sort, desc]);

  // A new query, filter or sort starts at the first page again — paging into
  // a list you have just re-ordered shows the tail of the old one.
  useEffect(() => setShown(PAGE), [libraryFilter, search, sort, desc]);

  // Home's "/" and the palette route here rather than growing a second
  // search box; both bump the counter this watches.
  useEffect(() => {
    if (librarySearchFocus > 0) searchRef.current?.focus();
  }, [librarySearchFocus]);

  // "/" focuses search when no field owns the keyboard (review 4 §H4).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      if (useApp.getState().settingsOpen || !searchRef.current) return;
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
        return;
      event.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The sort menu closes on any press outside it.
  useEffect(() => {
    if (!sortOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".sort-menu-wrap")) setSortOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [sortOpen]);

  const page = visible.slice(0, shown);
  const remaining = visible.length - page.length;
  const emptyKey =
    libraryFilter === "videos" ? "emptyVideos" : libraryFilter === "tools" ? "emptyTools" : "emptyAll";

  return (
    <div className="library">
      <div className="library-head">
        <h1>{t("library.title")}</h1>
        <p className="sub">{t("library.subtitle")}</p>
      </div>

      <div className="library-bar">
        <FilterTabs<LibraryFilter>
          ariaLabel={t("library.filterAria")}
          value={libraryFilter}
          onChange={setLibraryFilter}
          options={[
            { value: "all", label: t("library.filterAll", { count: counts.all }) },
            { value: "videos", label: t("library.filterVideos", { count: counts.videos }) },
            { value: "tools", label: t("library.filterTools", { count: counts.tools }) },
          ]}
        />
        <div className="library-search">
          <Search {...ICON_CONTROL} aria-hidden="true" />
          <input
            ref={searchRef}
            value={search}
            placeholder={t("library.searchPlaceholder")}
            aria-label={t("library.searchAria")}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.stopPropagation();
                setSearch("");
              }
            }}
          />
          {search ? (
            <button
              className="icon-btn-sm"
              aria-label={t("library.clearSearch")}
              onClick={() => {
                setSearch("");
                searchRef.current?.focus();
              }}
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          ) : (
            <kbd aria-hidden="true">{t("library.searchKey")}</kbd>
          )}
        </div>
        <span className="spacer" />
        <div className="sort-menu-wrap">
          <button
            className="chip-btn"
            aria-label={t("library.sortAriaState", {
              sort: t(`library.${SORT_LABEL[sort]}`),
              dir: t(`library.sortDir.${sort}.${desc ? "desc" : "asc"}`),
            })}
            aria-expanded={sortOpen}
            onClick={() => setSortOpen(!sortOpen)}
          >
            {t("library.sortLabel", {
              arrow: t(desc ? "library.sortDescArrow" : "library.sortAscArrow"),
              sort: t(`library.${SORT_LABEL[sort]}`),
            })}
            <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
          {sortOpen && (
            <div className="menu-pop sort-menu" role="menu">
              {SORTS.map((key) => (
                <button
                  key={key}
                  role="menuitem"
                  className={key === sort ? "active" : ""}
                  // Picking the sort already in force reverses it — the row
                  // says so, so the second click is never a no-op.
                  onClick={() => {
                    setDesc(key === sort ? !desc : SORT_STARTS_DESCENDING[key]);
                    setSort(key);
                    setSortOpen(false);
                  }}
                >
                  {t(`library.${SORT_LABEL[key]}`)}
                  {key === sort && (
                    <small>{t(`library.sortDir.${key}.${desc ? "desc" : "asc"}`)}</small>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {tiles.error && (
        <p className="hint error-text" role="alert">
          {tiles.error}
        </p>
      )}

      {page.length > 0 ? (
        <>
          <div className="grid">
            {page.map((project) => (
              <ProjectTile
                key={project.id}
                project={project}
                status={tileStatus(project, allJobs)}
                actions={tiles.bind(project)}
              />
            ))}
          </div>
          {remaining > 0 && (
            <div className="library-more">
              <button className="btn-ghost" onClick={() => setShown(shown + PAGE)}>
                {plural("library.loadMore", Math.min(remaining, PAGE))}
              </button>
            </div>
          )}
        </>
      ) : search.trim() ? (
        <p className="no-match">{t("library.noMatch", { q: search.trim() })}</p>
      ) : (
        <p className="no-match">{t(`library.${emptyKey}`)}</p>
      )}

      {tiles.dialog}
    </div>
  );
}
