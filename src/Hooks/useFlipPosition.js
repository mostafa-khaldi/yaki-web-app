import { useLayoutEffect, useState } from "react";

/**
 * Keeps a popover (the emoji picker) inside the area the user can actually see.
 *
 * The pickers are anchored above their trigger with `bottom: calc(100% + 5px)`.
 * When there is not enough room above, the popover is cut off and its upper
 * rows become unreachable (GitHub issue #127).
 *
 * The bounding area is NOT always the viewport. Inside a modal the popover is
 * clipped by the modal's own scroll container, so a picker that fits the screen
 * can still punch out through the top of the dialog. This hook therefore
 * measures against the nearest scrolling/clipping ancestor and falls back to
 * the viewport when there is none.
 *
 * @param {React.RefObject<HTMLElement>} ref  the popover element
 * @param {boolean} isOpen                    whether it is currently rendered
 * @param {number} estimatedHeight            picker height in px, used before measuring
 * @returns {{flip:boolean, shiftX:number, shiftY:number}}
 */

/**
 * Walks up from `el` and returns the rect of the nearest ancestor that clips
 * its overflow, or the viewport rect when nothing does.
 */
function getBoundingRect(el) {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = window.getComputedStyle(node);
    const clips = [cs.overflow, cs.overflowX, cs.overflowY].some(
      (v) => v === "auto" || v === "scroll" || v === "hidden" || v === "clip",
    );
    if (clips) {
      const r = node.getBoundingClientRect();
      // A zero-sized container tells us nothing useful; keep walking.
      if (r.height > 0 && r.width > 0) {
        return {
          top: Math.max(r.top, 0),
          bottom: Math.min(r.bottom, window.innerHeight),
          left: Math.max(r.left, 0),
          right: Math.min(r.right, window.innerWidth),
        };
      }
    }
    node = node.parentElement;
  }
  return {
    top: 0,
    bottom: window.innerHeight,
    left: 0,
    right: window.innerWidth,
  };
}

export default function useFlipPosition(ref, isOpen, estimatedHeight = 350) {
  const [placement, setPlacement] = useState({
    flip: false,
    shiftX: 0,
    shiftY: 0,
  });

  useLayoutEffect(() => {
    if (!isOpen) {
      setPlacement({ flip: false, shiftX: 0, shiftY: 0 });
      return;
    }

    const measure = () => {
      const el = ref.current;
      if (!el) return;

      // Measure the anchor, not the popover: the popover's own box already
      // reflects the placement we are deciding, so using it would oscillate.
      const anchor = el.parentElement;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const height = el.offsetHeight || estimatedHeight;
      const width = el.offsetWidth || 350;
      const margin = 8;

      // The area the popover must stay inside: the modal's scroll box when
      // there is one, otherwise the viewport.
      const bounds = getBoundingRect(el);

      const spaceAbove = rect.top - bounds.top;
      const spaceBelow = bounds.bottom - rect.bottom;

      // Flip below only when there is not room above and below is roomier, so
      // the default upward placement is kept wherever it genuinely fits.
      const flip = spaceAbove < height + margin && spaceBelow > spaceAbove;

      // Neither side may be large enough (a short modal or viewport). Nudge the
      // popover back inside so the whole grid stays reachable.
      const projectedTop = flip ? rect.bottom + 5 : rect.top - 5 - height;
      const projectedBottom = projectedTop + height;
      let shiftY = 0;
      if (projectedBottom > bounds.bottom - margin) {
        shiftY = bounds.bottom - margin - projectedBottom;
      }
      if (projectedTop + shiftY < bounds.top + margin) {
        shiftY = bounds.top + margin - projectedTop;
      }

      // Horizontal clamp, against the same bounds.
      let shiftX = 0;
      if (rect.left + width + margin > bounds.right) {
        shiftX = Math.min(0, bounds.right - margin - (rect.left + width));
      }
      if (rect.left + shiftX < bounds.left + margin) {
        shiftX = bounds.left + margin - rect.left;
      }

      setPlacement((prev) =>
        prev.flip === flip && prev.shiftX === shiftX && prev.shiftY === shiftY
          ? prev
          : { flip, shiftX, shiftY },
      );
    };

    measure();

    // The picker mounts lazily and grows when the user expands it from the
    // reactions bar to the full grid, so re-measure on size changes.
    let observer = null;
    if (ref.current && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(ref.current);
    }
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [ref, isOpen, estimatedHeight]);

  return placement;
}
