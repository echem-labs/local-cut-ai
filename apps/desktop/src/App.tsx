import {
  ChevronsLeft,
  ChevronsRight,
  Home as HomeIcon,
  Library as LibraryIcon,
  Moon,
  Settings as SettingsIcon,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { applyTheme, resolvedTheme, THEME_EVENT } from "./theme";
import { plural, t } from "./i18n";
import { useMediaQuery } from "./lib/useMediaQuery";
import { BrandMark } from "./components/BrandMark";
import { HelpMenu } from "./components/Help";
import { Palette } from "./components/Palette";
import { QueueTray } from "./components/QueueTray";
import { SaveTemplateDialog, TemplateNotice } from "./components/TemplateDialogs";
import { Tip } from "./components/Tooltip";
import { FirstRun } from "./screens/FirstRun";
import { Home } from "./screens/Home";
import { Library } from "./screens/Library";
import { Project } from "./screens/Project";
import { Settings } from "./screens/Settings";
import { tileStatus } from "./lib/tiles";
import { useApp } from "./store";

const ICON = { size: 15, strokeWidth: 1.8 } as const;
const RAIL_KEY = "localcut.rail.expanded";
/** Below this the labeled 200px rail leaves too little for the 840px
 * reading column beside it, so the rail compacts whatever the preference
 * says. Read by the rail only — nothing in CSS keys off this width. */
const RAIL_NARROW = "(max-width: 1000px)";

/** A rail action — theme, Settings, collapse. Same row, same tooltip as the
 * destinations above it: compact leaves only an icon, and one strip with two
 * kinds of tooltip reads as two kinds of control. */
function RailAction({
  compact,
  label,
  aria,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  compact: boolean;
  label: string;
  aria?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <button
      className={active ? "active" : ""}
      disabled={disabled}
      aria-label={aria ?? label}
      onClick={onClick}
    >
      {children}
      <span className="rail-label">{label}</span>
    </button>
  );
  return compact ? (
    <Tip label={aria ?? label} side="right">
      {button}
    </Tip>
  ) : (
    button
  );
}

/** A rail destination — Home and the Library are the same row with a
 * different icon. Compact keeps the icon and drops the label and the count;
 * the tooltip carries both, beside the row rather than above it (the first
 * row has no "above"). */
function RailEntry({
  icon: Icon,
  label,
  hint,
  compact,
  disabled,
  active,
  count = 0,
  onOpen,
}: {
  icon: typeof HomeIcon;
  label: string;
  hint: string;
  compact: boolean;
  disabled: boolean;
  active: boolean;
  count?: number;
  onOpen: () => void;
}) {
  const button = (
    <button className={active ? "active" : ""} disabled={disabled} onClick={onOpen}>
      <Icon {...ICON} />
      <span className="rail-label">{label}</span>
      {count > 0 && <span className="rail-count">{count}</span>}
    </button>
  );
  return compact ? (
    <Tip label={label} hint={hint} side="right">
      {button}
    </Tip>
  ) : (
    button
  );
}

/** One window, one persistent left rail. */
export default function App() {
  const {
    connect,
    currentProject,
    openProjects,
    projects,
    allJobs,
    openProject,
    closeOpenProject,
    closeProject,
    closeSettings,
    openSettings,
    engineError,
    firstRunDone,
    libraryOpen,
    openLibrary,
    closeLibrary,
    saveTemplateFor,
    closeSaveTemplate,
    settingsOpen,
    system,
    remoteEngine,
  } = useApp();

  useEffect(() => {
    void connect();
  }, [connect]);

  // The tab list scrolls; keep the active tab visible in it (the removed
  // overflow cap used to guarantee this by swapping it into the window).
  // settingsOpen is a dependency: the overlay strips the active class off
  // every tab, and closing it restores the class without the id changing.
  // "On Home" now means: no project, no Settings overlay AND not the
  // Library — three screens share the rail's top two rows.
  const onHome = !currentProject && !settingsOpen && !libraryOpen;
  const goHome = () => {
    closeProject();
    closeSettings();
    closeLibrary();
  };
  const activeProjectId = currentProject?.id ?? null;
  useEffect(() => {
    if (!activeProjectId || settingsOpen) return;
    document
      .querySelector(".rail-tabs button.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeProjectId, settingsOpen]);

  // Mirrors the resolved theme (Settings toggle and OS changes included).
  const [theme, setTheme] = useState<"dark" | "light">(resolvedTheme);
  useEffect(() => {
    const onChange = () => setTheme(resolvedTheme());
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);

  // First run gates everything; after that the project or Home shows, and
  // Settings renders as an OVERLAY LAYER above either — opening it never
  // unmounts the project (review 4 §SH1).
  const screen = !firstRunDone ? (
    <FirstRun />
  ) : currentProject ? (
    <Project />
  ) : libraryOpen ? (
    <Library />
  ) : (
    <Home />
  );

  // "NVIDIA GeForce RTX 3080" → "RTX 3080": the chip is narrow and the
  // vendor prefix says nothing the model number doesn't.
  const gpu = system?.hardware.gpus[0]?.name.replace(/^(NVIDIA|AMD|Intel)\s+(GeForce|Radeon|Arc)?\s*/i, "") ?? null;
  const engineDetail = system
    ? t("nav.engineDetail", {
        gpu: gpu || t("nav.noGpu"),
        tier: system.hardware.tier,
        backend: system.backend_mode,
      })
    : engineError
      ? t("nav.engineNotConnected")
      : t("nav.engineConnecting");

  // ONE activity bar on every screen (review 4 §SH2): the 48px compact
  // rail is the default everywhere; expanding to the labeled 200px rail is
  // a persisted choice that also holds on every screen. VS Code never
  // resizes its activity bar — shell stability is the point.
  const [railExpanded, setRailExpanded] = useState(
    () => localStorage.getItem(RAIL_KEY) === "1",
  );
  // Below 1000px the labeled rail would crowd the content, so it compacts
  // regardless of the stored preference — which survives untouched and
  // takes effect again when the window widens.
  const narrow = useMediaQuery(RAIL_NARROW);
  const compact = !railExpanded || narrow;
  const railToggleLabel = narrow
    ? t("nav.sidebarNarrow")
    : compact
      ? t("nav.expandSidebar")
      : t("nav.collapseSidebar");
  const toggleRail = () => {
    const next = !railExpanded;
    localStorage.setItem(RAIL_KEY, next ? "1" : "0");
    setRailExpanded(next);
  };
  const workspaceMode = currentProject ? !currentProject.mode.startsWith("tool:") : false;

  return (
    <div className="app">
      {/* Frameless window: this slim bar is the drag region; the native
          min/max/close buttons overlay its right edge (same background). */}
      <header className="titlebar">
        <BrandMark size={18} />
        <span className="tb-name">{t("titlebar.appName")}</span>
        {currentProject && <span className="tb-project">{currentProject.title}</span>}
      </header>
      <nav className={`rail${compact ? " compact" : ""}`} aria-label={t("nav.navigationAria")}>
        <RailEntry
          icon={HomeIcon}
          label={t("nav.home")}
          hint={t("nav.homeCloseHint")}
          compact={compact}
          disabled={!firstRunDone}
          active={firstRunDone && onHome}
          onOpen={goHome}
        />
        {/* The Library is a destination, not a tab on Home (U2): the same
            activation rules, one row below, carrying the count so the size of
            what you have made is visible without opening it. */}
        <RailEntry
          icon={LibraryIcon}
          label={t("nav.library")}
          hint={plural("nav.libraryCount", projects.length)}
          compact={compact}
          disabled={!firstRunDone}
          active={firstRunDone && libraryOpen && !currentProject && !settingsOpen}
          count={projects.length}
          onOpen={() => {
            closeSettings();
            openLibrary();
          }}
        />
        {firstRunDone && openProjects.length > 0 && (
          <div className="rail-tabs">
            {/* Named, now that two destinations sit above it: without a label
                the tabs read as more navigation rather than what is open. */}
            <div className="group-label">{t("nav.open")}</div>
            {openProjects.map((id) => {
              const project =
                projects.find((entry) => entry.id === id) ??
                (currentProject?.id === id ? currentProject : null);
              const title = project?.title ?? id;
              const active = currentProject?.id === id && !settingsOpen;
              return (
                <div key={id} className="rail-tab">
                  {/* The same bubble the destinations above use, not the
                      native title: two tooltip mechanisms in one 200px strip
                      read as two different controls. It earns its place in
                      both widths — compact has only an initial to go on, and
                      expanded truncates the title. */}
                  <Tip label={title} side="right">
                    <button
                      className={active ? "active" : ""}
                      onClick={() => {
                        closeSettings();
                        if (currentProject?.id !== id) void openProject(id);
                      }}
                    >
                      {compact && (
                        <span className="rail-glyph" aria-hidden="true">
                          {/* spread: [0] would split a surrogate pair (emoji titles) */}
                          {([...title.trim()][0] ?? "?").toUpperCase()}
                        </span>
                      )}
                      <i
                        className={`dot ${project ? tileStatus(project, allJobs) : "draft"}`}
                        aria-hidden="true"
                      />
                      <span className="rail-label">{title}</span>
                    </button>
                  </Tip>
                  {/* The ✕ is the one control here that is not self-evident,
                      so it says what it does rather than leaving the browser
                      to. No confirmation: closing puts the project back in
                      the Library it came from, and the hint says so — a
                      dialog over an act that loses nothing is the one that
                      teaches people to dismiss the dialog over one that
                      does. */}
                  <Tip
                    label={t("nav.closeProject")}
                    hint={t("nav.closeProjectHint")}
                    side="right"
                    className="tip-tab-close"
                  >
                    <button
                      className="rail-tab-close"
                      aria-label={t("nav.closeProjectAria", { title })}
                      onClick={() => closeOpenProject(id)}
                    >
                      <X size={12} strokeWidth={1.8} />
                    </button>
                  </Tip>
                </div>
              );
            })}
          </div>
        )}
        <div className="rail-bottom">
          <Tip
            label={remoteEngine ? t("nav.remoteEngine") : t("nav.localEngine")}
            hint={
              compact
                ? t("nav.engineSettingsHintCompact", { detail: engineDetail })
                : t("nav.engineSettingsHint")
            }
            side="right"
          >
            <button
              className="engine-chip"
              style={{ width: "100%" }}
              disabled={!firstRunDone}
              onClick={() => openSettings("engine")}
              aria-label={t("nav.engineStatusAria")}
            >
              <span className={`pulse${engineError ? " err" : ""}`} />
              <span className="engine-detail" style={{ minWidth: 0 }}>
                <b>{remoteEngine ? t("nav.remoteEngine") : t("nav.localEngine")}</b>
                <small>{engineDetail}</small>
              </span>
            </button>
          </Tip>
          <HelpMenu compact={compact} />
          <RailAction
            compact={compact}
            label={theme === "dark" ? t("nav.lightMode") : t("nav.darkMode")}
            aria={theme === "dark" ? t("nav.switchToLight") : t("nav.switchToDark")}
            onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun {...ICON} /> : <Moon {...ICON} />}
          </RailAction>
          <RailAction
            compact={compact}
            label={t("nav.settings")}
            active={settingsOpen}
            disabled={!firstRunDone}
            onClick={() => openSettings("general")}
          >
            <SettingsIcon {...ICON} />
          </RailAction>
          {/* Disabled while the window forces compact: the click would
              write a preference with no visible effect, so the control
              would look broken AND quietly discard the stored choice. */}
          <RailAction
            compact={compact}
            label={t("nav.collapse")}
            aria={railToggleLabel}
            disabled={narrow}
            onClick={toggleRail}
          >
            {compact ? <ChevronsRight {...ICON} /> : <ChevronsLeft {...ICON} />}
          </RailAction>
        </div>
      </nav>
      <main className={`content${workspaceMode ? " project-mode" : ""}`}>
        {engineError && <div className="banner error">{engineError}</div>}
        <TemplateNotice />
        {screen}
        {firstRunDone && settingsOpen && (
          <div className="settings-layer screen-enter">
            <Settings />
          </div>
        )}
      </main>
      {/* One host for the naming dialog: the Library's tile menu and the
          palette's in-project command both ask for the same question, and
          two hosts is two dialogs that drift. */}
      {saveTemplateFor && (
        <SaveTemplateDialog project={saveTemplateFor} onClose={closeSaveTemplate} />
      )}
      <QueueTray />
      <Palette />
    </div>
  );
}
