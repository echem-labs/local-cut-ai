import { BookOpen, HelpCircle, Keyboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { m, t } from "../i18n";
import { shortcutLabel } from "../lib/platform";
import { useOutsideClick } from "../lib/useOutsideClick";
import { useMenuFit } from "../lib/useMenuFit";
import { Modal } from "./Modal";
import { Tip } from "./Tooltip";

type Panel = "shortcuts" | "glossary" | null;

/** Panel-level "?" popovers dispatch this to open the glossary that
 * HelpMenu hosts — one modal, many entry points. */
export const OPEN_GLOSSARY_EVENT = "localcut:open-glossary";

/** Same trick for the shortcut overlay: About's Support row offers it, and
 * a second copy of the shortcut list to keep in sync is exactly the drift
 * this modal exists to prevent. */
export const OPEN_SHORTCUTS_EVENT = "localcut:open-shortcuts";

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
      <Tip label={t("help.panelHelp.whatLooking")}>
        <button
          ref={btnRef}
          className="icon-btn-sm"
          aria-label={t("help.panelHelp.whatLooking")}
          aria-expanded={open}
          onClick={toggle}
        >
          <HelpCircle size={13} strokeWidth={1.8} />
        </button>
      </Tip>
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
  const fit = useMenuFit();

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

  // About → Support does the same for the shortcut overlay. Not a toggle
  // like the "?" key: the caller is a button that says "open this", and a
  // second click on it closing the modal it opened reads as a dead button.
  useEffect(() => {
    const onOpen = () => setPanel("shortcuts");
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
  }, []);

  // Escape, the Tab trap and handing focus back on close all live in
  // `Modal` now — this overlay had its own copy of each, which is how the
  // app ended up with two dialogs that trapped focus and three that did not.

  const glossary = m().terms.glossary.filter(
    (entry) =>
      !search.trim() ||
      entry.term.toLowerCase().includes(search.trim().toLowerCase()) ||
      entry.def.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const helpButton = (
    <button aria-label={t("help.menu.help")} aria-expanded={open} onClick={() => setOpen(!open)}>
      <HelpCircle size={15} strokeWidth={1.8} />
      {!compact && t("help.menu.help")}
    </button>
  );

  return (
    <>
      <div className="help-menu" ref={ref}>
        {/* Compact leaves only the glyph, so it takes the rail's tooltip —
            the same bubble on the same side as every other row. */}
        {compact ? (
          <Tip label={t("help.menu.help")} hint={t("help.menu.title")} side="right">
            {helpButton}
          </Tip>
        ) : (
          helpButton
        )}
        {open && (
          <div className="menu-pop help-pop" role="menu" ref={fit}>
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
        <Modal
          title={
            panel === "shortcuts" ? t("help.modal.shortcutsTitle") : t("help.modal.glossaryTitle")
          }
          size="m"
          onClose={() => setPanel(null)}
        >
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
        </Modal>
      )}
    </>
  );
}
