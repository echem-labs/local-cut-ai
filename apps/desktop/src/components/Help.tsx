import { BookOpen, HelpCircle, Keyboard, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GLOSSARY } from "../help/terms";
import { useOutsideClick } from "../lib/useOutsideClick";

const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "Space", what: "Play / pause the draft preview" },
  { keys: "Ctrl K", what: "Focus the composer — commands or a described edit" },
  { keys: "Enter", what: "Open the focused scene's details" },
  { keys: "R", what: "Regenerate the focused scene (new take)" },
  { keys: "P", what: "Pin / unpin the focused scene" },
  { keys: "Esc", what: "Close the inspector" },
  { keys: "Ctrl ↵", what: "Generate (Home prompt)" },
  { keys: "?", what: "This overlay" },
];

type Panel = "shortcuts" | "glossary" | null;

/** Panel-level "?" popovers dispatch this to open the glossary that
 * HelpMenu hosts — one modal, many entry points. */
export const OPEN_GLOSSARY_EVENT = "localcut:open-glossary";

const PANEL_COPY: Record<
  "board" | "timeline" | "inspector",
  { title: string; bullets: string[] }
> = {
  board: {
    title: "The storyboard",
    bullets: [
      "Each card is one scene — the still image it starts from, a few seconds of video, and its narration.",
      "The pill shows where it is: Draft (fast, for deciding) · Rendering · Final · Failed.",
      "Click a card to open its details; drag cards to change the order of the cut.",
    ],
  },
  timeline: {
    title: "The timeline",
    bullets: [
      "Your scenes in play order — a wider block runs longer.",
      "The diamonds between blocks set the transition: cut, crossfade, or dip to black.",
      "▶ plays a quick draft preview of the whole cut, scene by scene.",
    ],
  },
  inspector: {
    title: "Scene details",
    bullets: [
      "Everything about the selected scene — its Image, Motion and Voice.",
      "Apply & regenerate re-renders only this scene with your changes.",
      "Pin keeps the scene exactly as it is; New take tries again with fresh randomness.",
    ],
  },
};

const POP_WIDTH = 264;

/** A small "What am I looking at?" popover for a workspace panel: three
 * plain bullets + a jump into the glossary (review 3 §5). Fixed-positioned
 * from the button so a dockview panel's overflow can never clip it. */
export function PanelHelp({ panel }: { panel: "board" | "timeline" | "inspector" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const copy = PANEL_COPY[panel];

  useOutsideClick(ref, open, () => setOpen(false));

  // The coords were measured at open — anything that moves the anchor
  // (window resize, panel scroll) would strand the popover, so close it.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.right - POP_WIDTH, window.innerWidth - POP_WIDTH - 8));
    // The timeline lives at the screen's foot — its popover opens upward.
    setPos(
      panel === "timeline"
        ? { left, bottom: window.innerHeight - rect.top + 6 }
        : { left, top: rect.bottom + 6 },
    );
    setOpen(true);
  };

  return (
    <div className="panel-help" ref={ref}>
      <button
        ref={btnRef}
        className="icon-btn-sm"
        aria-label="What am I looking at?"
        aria-expanded={open}
        title="What am I looking at?"
        onClick={toggle}
      >
        <HelpCircle size={13} strokeWidth={1.8} />
      </button>
      {open && pos && (
        <div
          className="panel-help-pop"
          role="note"
          aria-label={copy.title}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}
        >
          <b>{copy.title}</b>
          <ul>
            {copy.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
          <button
            className="link"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new CustomEvent(OPEN_GLOSSARY_EVENT));
            }}
          >
            <BookOpen size={12} strokeWidth={1.8} />
            Open glossary
          </button>
        </div>
      )}
    </div>
  );
}

/** The ? entry point: a small menu opening the shortcuts overlay and the
 * glossary — the same copy as every tooltip, from one file, so nothing
 * ever disagrees. The ? key opens shortcuts from anywhere. */
export function HelpMenu({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useOutsideClick(ref, open, () => setOpen(false));

  // "?" opens the shortcut overlay when no field owns the keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "?") return;
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
        return;
      event.preventDefault();
      setPanel((current) => (current === "shortcuts" ? null : "shortcuts"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (panel === null) setSearch("");
  }, [panel]);

  // Panel-level "?" popovers deep-link here.
  useEffect(() => {
    const onOpen = () => setPanel("glossary");
    window.addEventListener(OPEN_GLOSSARY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_GLOSSARY_EVENT, onOpen);
  }, []);

  const glossary = GLOSSARY.filter(
    (entry) =>
      !search.trim() ||
      entry.term.toLowerCase().includes(search.trim().toLowerCase()) ||
      entry.def.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <>
      <div className="help-menu" ref={ref}>
        <button
          aria-label="Help"
          aria-expanded={open}
          title="Shortcuts & glossary"
          onClick={() => setOpen(!open)}
        >
          <HelpCircle size={15} strokeWidth={1.8} />
          {!compact && "Help"}
        </button>
        {open && (
          <div className="menu-pop help-pop" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setPanel("shortcuts");
                setOpen(false);
              }}
            >
              <Keyboard size={13} strokeWidth={1.8} />
              Keyboard shortcuts
              <small>?</small>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setPanel("glossary");
                setOpen(false);
              }}
            >
              <BookOpen size={13} strokeWidth={1.8} />
              Glossary
              <small>what's a scene?</small>
            </button>
          </div>
        )}
      </div>

      {panel !== null && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPanel(null);
          }}
        >
          <div
            className="modal help-modal"
            role="dialog"
            aria-label={panel === "shortcuts" ? "Keyboard shortcuts" : "Glossary"}
            onKeyDown={(event) => {
              if (event.key === "Escape") setPanel(null);
            }}
          >
            <div className="help-modal-head">
              <h2>{panel === "shortcuts" ? "Keyboard shortcuts" : "Glossary"}</h2>
              <button
                className="icon-btn-sm"
                onClick={() => setPanel(null)}
                aria-label="Close"
                autoFocus
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
            {panel === "shortcuts" ? (
              <div className="shortcut-list">
                {SHORTCUTS.map((entry) => (
                  <div key={entry.keys}>
                    <kbd>{entry.keys}</kbd>
                    <span>{entry.what}</span>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <input
                  className="glossary-search"
                  placeholder="Search terms…"
                  value={search}
                  aria-label="Search the glossary"
                  onChange={(event) => setSearch(event.target.value)}
                />
                <div className="glossary-list">
                  {glossary.map((entry) => (
                    <div key={entry.term}>
                      <b>{entry.term}</b>
                      <p>{entry.def}</p>
                    </div>
                  ))}
                  {glossary.length === 0 && <p className="hint">Nothing matches.</p>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
