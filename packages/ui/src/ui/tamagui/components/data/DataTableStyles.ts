import {
  CARD_LIST_CLASS,
  DT_FRAME_ATTR,
  FOCUS_ROW_CLASS,
  HOVER_ROW_CLASS,
  SELECTED_ROW_CLASS,
} from "./DataTableCardList";
import type { DataTableDensity } from "./DataTableTypes";
import {
  DT_ACCENT,
  DT_ACCENT_SOFT,
  DT_ACCENT_TEXT,
  DT_BACKGROUND_HOVER,
  DT_FOCUS,
  DT_INK,
  DT_INK_MUTED,
  DT_SURFACE,
} from "./tokens";

// ── Hover-highlight styles (web only; class names live in DataTableCardList) ──
// Bump the suffix whenever the rules change, so a tag left by HMR or an older
// bundle (same id, old text) never wins over the current rules.
const DT_STYLE_ID_PREFIX = "dt-hover-styles";
export const DT_STYLE_ID = `${DT_STYLE_ID_PREFIX}-v4`;

/** Class applied to a selected row's <tr> (and its card-mode counterpart). */
export { SELECTED_ROW_CLASS };
/** See `DataTableCardList`: a frame owner suppresses the card list's rules. */
export { CARD_LIST_CLASS, DT_FRAME_ATTR };

/**
 * Class on an inactive sortable column's double caret. The caret is taken out
 * of flow (it sits in the header cell's padding, see `DataTableHeader`) and is
 * invisible until the sort button is hovered or keyboard-focused, so it never
 * costs the label any width.
 */
export const SORT_CARET_IDLE_CLASS = "dt-sort-caret-idle";

/**
 * Opt-in class for a cell's secondary line (the caption under the bold
 * primary line in stacked two-line cells). Cells that add it collapse to a
 * single line when the table renders with `density="compact"`.
 */
export const DT_CELL_SUB_CLASS = "dt-cell-sub";

/** Inject a <style> tag once for row hover + focus-visible highlights + column resize handles. */
export function ensureWebStyles() {
  if (typeof document === "undefined") return;
  // Drop any older version of this tag (HMR leftovers, a previous bundle):
  // a stale v2 tag would keep painting the retired hover rail.
  document
    .querySelectorAll(`style[id^="${DT_STYLE_ID_PREFIX}"]`)
    .forEach((el) => {
      if (el.id !== DT_STYLE_ID) el.remove();
    });
  if (document.getElementById(DT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = DT_STYLE_ID;
  style.textContent = `
    /* A wrapper that draws the top/bottom rules itself (data-dt-frame)
       owns the frame: the card list's inline rules stand down so there is
       one 2px rule above and below, not two. */
    [${DT_FRAME_ATTR}] .${CARD_LIST_CLASS} {
      border-top: none !important;
      border-bottom: none !important;
    }
    .${FOCUS_ROW_CLASS}:focus-visible {
      outline: 2px solid ${DT_FOCUS};
      outline-offset: -2px;
    }
    .${SELECTED_ROW_CLASS} {
      background: ${DT_ACCENT_SOFT};
    }
    /* Safari doesn't paint box-shadow on <tr>, so the selected rail hangs on
       the row's first cell. The div selector covers card mode, where the row
       IS a plain div. Hover sets no box-shadow, so a hovered selected row
       keeps its rail. */
    .${SELECTED_ROW_CLASS} > td:first-child,
    div.${SELECTED_ROW_CLASS} {
      box-shadow: inset 3px 0 0 ${DT_ACCENT};
    }
    .dt-sort-button {
      color: inherit;
    }
    .dt-sort-button:focus-visible {
      outline: 2px solid ${DT_FOCUS};
      outline-offset: -2px;
    }
    /* Inline opacity: 0 keeps the idle caret hidden from first paint (before
       this tag is injected); the reveal therefore needs !important. */
    .${SORT_CARET_IDLE_CLASS} {
      transition: opacity 150ms ease;
    }
    .dt-sort-button:focus-visible .${SORT_CARET_IDLE_CLASS} {
      opacity: 0.55 !important;
    }
    @media (prefers-reduced-motion: reduce) {
      .${SORT_CARET_IDLE_CLASS} {
        transition: none;
      }
    }
    .dt-resize-handle {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: col-resize;
      user-select: none;
      touch-action: none;
      z-index: 3;
    }
    .dt-resize-handle::after {
      content: "";
      position: absolute;
      right: 2px;
      top: 25%;
      bottom: 25%;
      width: 2px;
      border-radius: 0;
      background: transparent;
      transition: background 0.15s ease;
    }
    .dt-resize-handle.dt-resizing::after {
      background: ${DT_ACCENT};
    }
    /* Touch browsers apply hover on tap and hold it, so the hover washes
       apply only where the pointer can really hover. Source order and
       specificity between the two row rules are unchanged. */
    @media (hover: hover) {
      /* Hover is a wash only. The accent rail is reserved for selection. */
      .${HOVER_ROW_CLASS}:hover {
        background: ${DT_BACKGROUND_HOVER} !important;
      }
      /* A hovered selected row keeps its tint (the hover wash is !important;
         this selector is more specific). Same classes on <tr> and card div. */
      .${SELECTED_ROW_CLASS}.${HOVER_ROW_CLASS}:hover {
        background: ${DT_ACCENT_SOFT} !important;
      }
      .dt-sort-button:hover {
        color: ${DT_ACCENT_TEXT};
      }
      .dt-sort-button:hover .${SORT_CARET_IDLE_CLASS} {
        opacity: 0.55 !important;
      }
      .dt-resize-handle:hover::after {
        background: ${DT_ACCENT};
      }
    }
    table.dt-resizing {
      cursor: col-resize;
      user-select: none;
    }
    .dt-search-bar:focus-within {
      outline: 2px solid ${DT_FOCUS};
      outline-offset: -2px;
    }
    .dt-search-bar input::placeholder {
      color: ${DT_INK_MUTED};
      opacity: 1;
    }
    table[style*="table-layout: fixed"] td {
      overflow-wrap: break-word;
      word-break: break-word;
    }
    table[data-density="compact"] .${DT_CELL_SUB_CLASS} {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

// ── Shared header/cell style fragments (web) ──────────────────────────────

/**
 * The automation wrapper around the web `<table>` (see `DataTableFrame`).
 * `scrollContainer` is applied here once, for every state.
 *
 * No inline padding: the header baseline and row hairlines run the full width
 * of the frame. (An 8px `paddingInlineEnd` used to sit here, with no recorded
 * reason; the 14px / 10px cell padding already keeps the last column's content
 * clear of an overlay scrollbar.)
 */
export const tableWrapperStyle = (scrollContainer: boolean) =>
  scrollContainer ? { overflow: "auto" as const } : {};

export const headerCellPadding = (density: DataTableDensity) =>
  density === "compact" ? "8px 10px" : "12px 14px";

export const bodyCellPadding = (density: DataTableDensity) =>
  density === "compact" ? "7px 10px" : "12px 14px";

/**
 * Header treatment: the mono label idiom at the `xs` rung — IBM Plex Mono
 * 10px / 2.5px tracking / 600, uppercase.
 *
 * Plex is wider per character than Montserrat, and the tracking is wider too,
 * so a header label occupies more room than it did on the sans. That is
 * absorbed by dropping a step (11 → 10px, the ladder's table-head rung) rather
 * than by letting headers push their columns.
 */
export const headerTextStyle = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontWeight: 600,
  fontSize: 10,
  letterSpacing: "2.5px",
  textTransform: "uppercase" as const,
  color: DT_INK,
};

export const stickyHeadStyle = {
  position: "sticky" as const,
  top: 0,
  zIndex: 2,
  background: DT_SURFACE,
};
