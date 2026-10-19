import type { BubbleMenuProps } from "@tiptap/react/menus";

/** Gap between the selection and the bubble menu, in px (Floating UI `offset`). */
export const BUBBLE_MENU_OFFSET = 8;

/**
 * z-index for the bubble menu's positioned element. Above StickyHeader (40)
 * so the menu wins wherever the two meet.
 */
export const BUBBLE_MENU_Z_INDEX = 120;

/**
 * The top edge of the part of the viewport where editor text is visible, in
 * viewport px: the bottom of the editor's sticky toolbar, or the page's own
 * sticky stack (`stickyTopOffset`) once the toolbar has scrolled out with
 * the end of the editor. Read on every position update, because the toolbar
 * wraps onto more rows at narrow widths and grows when an insert bar opens.
 */
export function stickyTopInset(
  header: Pick<HTMLElement, "getBoundingClientRect"> | null,
  stickyTopOffset: number,
): number {
  const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
  return Math.max(0, stickyTopOffset, headerBottom);
}

/** A boundary rect in viewport coordinates (Floating UI's `Rect`). */
export type ViewportRect = { x: number; y: number; width: number; height: number };

/**
 * The visible-text band of the viewport: from `top` (viewport px) down to the
 * viewport's bottom edge, full width.
 */
export function viewportBandBelow(
  top: number,
  viewport: { width: number; height: number },
): ViewportRect {
  const y = Math.max(0, top);
  return {
    x: 0,
    y,
    width: viewport.width,
    height: Math.max(0, viewport.height - y),
  };
}

const windowViewport = () => ({
  width: window.innerWidth,
  height: window.innerHeight,
});

/**
 * Floating UI options for the selection bubble menu. It keeps `placement:
 * "top"`, but Floating UI's clipping boundary knows nothing about the sticky
 * toolbar sitting over the top of the visible text. A selection on the first
 * line has the toolbar directly above it, so the menu went there. Both
 * middlewares get an explicit boundary whose top edge is the toolbar's bottom:
 * - `flip` sends the menu below the selection when it would not fit above.
 *   Tiptap runs `flip` before `offset`, so the boundary starts the gap
 *   further down to leave room for it.
 * - `hide` hides the menu once the selection has scrolled fully under the
 *   toolbar, instead of leaving it floating over the toolbar buttons.
 *
 * Why a Rect boundary and not `padding`: padding is applied to the CLIPPING
 * ANCESTOR's rect, while the inset is measured in viewport coordinates. The
 * two only agree when the window is the scroller (the event builder). In
 * ComposeAnnouncementDialog the editor sits in Modal.Body, which scrolls
 * (`overflow: auto`), so the sticky toolbar's bottom already lies below that
 * ancestor's top and padding counted the distance twice: the menu flipped
 * below too often, and `hide` fired while the selection was still visible.
 * A Rect is taken as-is, in viewport coordinates (Floating UI intersects it
 * with the viewport root boundary), so both editors measure the same way.
 */
export function bubbleMenuOptions(
  getHeader: () => Pick<HTMLElement, "getBoundingClientRect"> | null,
  stickyTopOffset: number,
  getViewport: () => { width: number; height: number } = windowViewport,
): NonNullable<BubbleMenuProps["options"]> {
  const inset = () => stickyTopInset(getHeader(), stickyTopOffset);
  return {
    placement: "top",
    offset: BUBBLE_MENU_OFFSET,
    flip: () => ({
      boundary: viewportBandBelow(inset() + BUBBLE_MENU_OFFSET, getViewport()),
    }),
    hide: () => ({ boundary: viewportBandBelow(inset(), getViewport()) }),
  };
}
