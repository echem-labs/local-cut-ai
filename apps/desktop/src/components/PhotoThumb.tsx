/**
 * A picture the user supplied, small — and openable.
 *
 * Small is the point. The first cut dropped the dropped image into the New
 * scene dialog at its natural width, which pushed the dialog wider than the
 * window and made the whole thing scroll sideways to read a field. A
 * thumbnail states WHICH picture this is about, which is all either caller
 * needs inline; anyone who wants to check the picture itself opens it.
 *
 * Full view goes through `Modal` rather than a hand-rolled overlay, per the
 * repo rule: one shell owns the backdrop, the focus trap and restore, Escape
 * and the labelled heading. A lightbox is exactly the surface that quietly
 * forgets the last two.
 *
 * Removal is the caller's business, not this component's — it only draws the
 * affordance. The Inspector's remove asks first and then rewires the graph,
 * neither of which a thumbnail should know about.
 */
import { X } from "lucide-react";
import { useState } from "react";

import { t } from "../i18n";
import { Modal } from "./Modal";
import { Tip } from "./Tooltip";

export function PhotoThumb({
  src,
  alt,
  title,
  onRemove,
}: {
  src: string;
  /** What the picture IS, for anyone who cannot see it. */
  alt: string;
  /** Heading for the full view. */
  title: string;
  /** Offered only when there is something to hand back to. */
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="photo-thumb">
      <button
        type="button"
        className="photo-thumb-open"
        onClick={() => setOpen(true)}
        aria-label={t("inspector.photoOpen")}
      >
        <img src={src} alt={alt} />
      </button>
      {onRemove && (
        // Outside the opening button, never inside it: ARIA specifies a
        // button's children as presentational, so a control nested in one
        // disappears from assistive tech however reachable it stays by Tab.
        // The CLASS goes on the tooltip wrapper, not the button: `.tip-wrap`
        // is `position: relative`, so it becomes the button's containing
        // block and an absolutely positioned button inside it anchors to the
        // wrapper's own place in the flow — below the picture — rather than
        // to the thumbnail's corner. `.ring-tip` and `.take-tip` style the
        // wrapper for the same reason.
        <Tip label={t("inspector.photoRemove")} className="photo-thumb-tip">
          <button
            type="button"
            className="photo-thumb-remove"
            onClick={onRemove}
            aria-label={t("inspector.photoRemove")}
          >
            <X size={13} />
          </button>
        </Tip>
      )}
      {open && (
        <Modal title={title} size="l" onClose={() => setOpen(false)}>
          <img className="photo-full" src={src} alt={alt} />
        </Modal>
      )}
    </div>
  );
}
