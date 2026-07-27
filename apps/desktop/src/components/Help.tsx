import { BookOpen, HelpCircle, Keyboard, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { m, t } from "../i18n";
import { shortcutLabel } from "../lib/platform";
import { useOutsideClick } from "../lib/useOutsideClick";

type Panel = "shortcuts" | "glossary" | null;

/** Panel-level "?" popovers dispatch this to open the glossary that
 * HelpMenu hosts — one modal, many entry points. */
export const OPEN_GLOSSARY_EVENT = "localcut:open-glossary";

const POP_WIDTH = 264;

/** A small "What am I looking at?" popover for a workspace panel: three
 * plain bullets + a jump into the glossary (review 3 §5). Fixed-positioned
 * from the button so a dockview panel's overflow can never clip it. */
export function PanelHelp({
  panel,
}: {
  panel: "board" | "timeline" | "inspector" | "canvas";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const copy = m().help.panels[panel];

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
        aria-label={t("help.panelHelp.whatLooking")}
        aria-expanded={open}
        title={t("help.panelHelp.whatLooking")}
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
            {t("help.panelHelp.openGlossary")}
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

  // Modal focus management: trap Tab, own Escape, and hand focus back where
  // it came from on close. Without this, Escape only worked while focus
  // happened to be inside the modal (the close button's autoFocus put it
  // there, but one click anywhere else lost it), and Tab walked straight out
  // into the page behind — so the "modal" was only visually modal.
  const modalRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (panel === null) {
      // Closing: restore focus to whatever opened us, so keyboard users are
      // not dumped back at the top of the document.
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
      return;
    }
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setPanel(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !modalRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [panel]);

  const glossary = m().terms.glossary.filter(
    (entry) =>
      !search.trim() ||
      entry.term.toLowerCase().includes(search.trim().toLowerCase()) ||
      entry.def.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <>
      <div className="help-menu" ref={ref}>
        <button
          aria-label={t("help.menu.help")}
          aria-expanded={open}
          title={t("help.menu.title")}
          onClick={() => setOpen(!open)}
        >
          <HelpCircle size={15} strokeWidth={1.8} />
          {!compact && t("help.menu.help")}
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
              {t("help.menu.shortcuts")}
              <small>{t("help.menu.shortcutsKey")}</small>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setPanel("glossary");
                setOpen(false);
              }}
            >
              <BookOpen size={13} strokeWidth={1.8} />
              {t("help.menu.glossary")}
              <small>{t("help.menu.glossaryHint")}</small>
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
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label={
              panel === "shortcuts" ? t("help.modal.shortcutsTitle") : t("help.modal.glossaryTitle")
            }
          >
            <div className="help-modal-head">
              <h2>
                {panel === "shortcuts"
                  ? t("help.modal.shortcutsTitle")
                  : t("help.modal.glossaryTitle")}
              </h2>
              <button
                className="icon-btn-sm"
                onClick={() => setPanel(null)}
                aria-label={t("common.close")}
                autoFocus
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
            {panel === "shortcuts" ? (
              <div className="shortcut-list">
                {m().help.shortcuts.map((entry) => (
                  <div key={entry.keys}>
                    <kbd>{shortcutLabel(entry.keys)}</kbd>
                    <span>{entry.what}</span>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <input
                  className="glossary-search"
                  placeholder={t("help.modal.searchPlaceholder")}
                  value={search}
                  aria-label={t("help.modal.searchAria")}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <div className="glossary-list">
                  {glossary.map((entry) => (
                    <div key={entry.term}>
                      <b>{entry.term}</b>
                      <p>{entry.def}</p>
                    </div>
                  ))}
                  {glossary.length === 0 && <p className="hint">{t("help.modal.nothingMatches")}</p>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
