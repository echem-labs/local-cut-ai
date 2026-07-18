import {
  Aperture,
  Clapperboard,
  FileText,
  Film,
  Image as ImageIcon,
  Mic,
  Music,
  Settings as SettingsIcon,
  Sparkles,
  SunMoon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolKind } from "../api/types";
import { m, t } from "../i18n";
import { fuzzyScore } from "../lib/fuzzy";
import { relativeTime } from "../lib/time";
import { applyTheme, resolvedTheme } from "../theme";
import { useApp } from "../store";

/** Home's prompt box listens for this and takes focus. */
export const FOCUS_PROMPT_EVENT = "localcut:focus-prompt";

const TOOL_ICONS: Record<ToolKind, typeof FileText> = {
  script: FileText,
  thumbnail: ImageIcon,
  voiceover: Mic,
  image: Aperture,
  music: Music,
  clip: Film,
};

const SETTINGS_TABS = [
  "general",
  "defaults",
  "providers",
  "models",
  "storage",
  "engine",
  "about",
] as const;

interface Item {
  key: string;
  group: "projects" | "create" | "goto" | "appearance";
  label: string;
  icon?: typeof FileText;
  dot?: string;
  small?: string;
  run: () => void;
}

/** The global Ctrl+K palette (review 4 §SH4): open projects by name, start
 * a video or a quick tool, jump to a Settings category, toggle theme —
 * from any screen. Reuses the shipped .menu-pop/.palette visual recipe. */
export function Palette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { projects, allJobs, openProject, openSettings, closeSettings, closeProject } = useApp();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
        setQuery("");
        setIndex(0);
      }
      if (event.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const goHome = () => {
      closeProject();
      closeSettings();
    };
    const list: Item[] = [];
    for (const project of projects) {
      const generating = allJobs.some(
        (job) =>
          job.project_id === project.id &&
          (job.status === "queued" || job.status === "rendering"),
      );
      const toolKind = project.mode.startsWith("tool:")
        ? (project.mode.slice(5) as ToolKind)
        : null;
      list.push({
        key: `p:${project.id}`,
        group: "projects",
        label: project.title,
        dot: generating ? "var(--status-generating)" : "var(--text-tertiary)",
        small: toolKind
          ? m().tools[toolKind].label
          : relativeTime(project.updated_at ?? project.created_at),
        run: () => {
          closeSettings();
          void openProject(project.id);
        },
      });
    }
    list.push({
      key: "new-video",
      group: "create",
      label: t("palette.newVideo"),
      icon: Sparkles,
      run: () => {
        goHome();
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(FOCUS_PROMPT_EVENT)));
      },
    });
    for (const kind of Object.keys(TOOL_ICONS) as ToolKind[]) {
      list.push({
        key: `tool:${kind}`,
        group: "create",
        label: t("palette.newTool", { tool: m().tools[kind].label }),
        icon: TOOL_ICONS[kind],
        small: m().tools[kind].output,
        run: () => {
          goHome();
          useApp.getState().setHomeDraft({ tool: kind, toolInput: "" });
        },
      });
    }
    list.push({
      key: "goto-home",
      group: "goto",
      label: t("palette.home"),
      icon: Clapperboard,
      run: goHome,
    });
    for (const tab of SETTINGS_TABS) {
      list.push({
        key: `settings:${tab}`,
        group: "goto",
        label: t("palette.settingsTab", { tab: t(`settings.tabs.${tab}`) }),
        icon: SettingsIcon,
        run: () => openSettings(tab),
      });
    }
    list.push({
      key: "theme",
      group: "appearance",
      label: t("palette.toggleTheme"),
      icon: SunMoon,
      run: () => applyTheme(resolvedTheme() === "dark" ? "light" : "dark"),
    });
    return list;
  }, [open, projects, allJobs, openProject, openSettings, closeSettings, closeProject]);

  const visible = useMemo(() => {
    const q = query.trim();
    if (!q) {
      // Rest state: recent projects lead, then the verbs.
      const recents = items.filter((item) => item.group === "projects").slice(0, 6);
      return [...recents, ...items.filter((item) => item.group !== "projects")];
    }
    return items
      .map((item) => ({ item, score: fuzzyScore(q, item.label) }))
      .filter((entry): entry is { item: Item; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);
  }, [items, query]);

  useEffect(() => setIndex(0), [query, open]);

  if (!open) return null;

  const run = (item: Item) => {
    setOpen(false);
    item.run();
  };

  const groups: Item["group"][] = ["projects", "create", "goto", "appearance"];
  let flat = -1;

  return (
    <>
      <div className="cmdk-backdrop" onMouseDown={() => setOpen(false)} />
      <div className="cmdk" role="dialog" aria-label={t("palette.aria")}>
        <input
          ref={inputRef}
          value={query}
          placeholder={t("palette.placeholder")}
          aria-label={t("palette.aria")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setIndex((current) => (current + delta + visible.length) % visible.length);
            }
            if (event.key === "Enter" && visible[index]) run(visible[index]);
          }}
        />
        <div className="cmdk-list" role="listbox">
          {visible.length === 0 && <div className="cmdk-empty">{t("palette.empty")}</div>}
          {groups.map((group) => {
            const members = visible.filter((item) => item.group === group);
            if (members.length === 0) return null;
            return (
              <div key={group}>
                <div className="menu-label">{t(`palette.groups.${group}`)}</div>
                {members.map((item) => {
                  flat += 1;
                  const at = flat;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      role="option"
                      aria-selected={at === index}
                      className={`cmdk-item${at === index ? " focused" : ""}`}
                      onMouseEnter={() => setIndex(at)}
                      onClick={() => run(item)}
                    >
                      {item.dot ? (
                        <span className="dot" style={{ background: item.dot }} aria-hidden="true" />
                      ) : Icon ? (
                        <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
                      ) : null}
                      <span className="grow">{item.label}</span>
                      {item.small && <small>{item.small}</small>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="cmdk-hint">{t("palette.hint")}</div>
      </div>
    </>
  );
}
