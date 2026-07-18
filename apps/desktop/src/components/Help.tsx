import { BookOpen, HelpCircle, Keyboard, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GLOSSARY } from "../help/terms";

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

/** The ? entry point: a small menu opening the shortcuts overlay and the
 * glossary — the same copy as every tooltip, from one file, so nothing
 * ever disagrees. The ? key opens shortcuts from anywhere. */
export function HelpMenu({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

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
