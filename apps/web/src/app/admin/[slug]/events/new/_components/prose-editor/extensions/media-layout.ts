/**
 * Shared float/align layout grammar for prose media nodes (image, audio,
 * media-embed). All three nodes have the same options:
 *
 *   - `float: "left" | "right"` puts the node in a side column with body
 *     copy wrapping around it.
 *   - `float: "none"` lays it out as a full-width block; `align` then picks
 *     left / center / right within the prose column.
 *
 * Keeping the math here means the editor NodeViews and the server-side
 * `renderHTML` paths can't drift — both produce the same CSS for the same
 * attribute combo.
 */

import type { CSSProperties } from "react";

export type MediaAlign = "left" | "center" | "right";
export type MediaFloat = "none" | "left" | "right";

const SIDE_COLUMN_MAX = "50%";
const BLOCK_MAX = 560;

/**
 * Audio is a horizontal control bar, not a thumbnail. The 560px BLOCK_MAX
 * meant to constrain image / video aspect ratios just leaves a narrow
 * player floating in the middle of a wide column. These helpers drop the
 * cap so audio fills whatever container it lands in.
 */
export function audioLayoutStyle(
  align: MediaAlign | undefined,
  float: MediaFloat | undefined,
): CSSProperties {
  if (float === "left") {
    return {
      float: "left",
      marginRight: 16,
      marginBottom: 8,
      width: "100%",
      maxWidth: SIDE_COLUMN_MAX,
      clear: "right",
    };
  }
  if (float === "right") {
    return {
      float: "right",
      marginLeft: 16,
      marginBottom: 8,
      width: "100%",
      maxWidth: SIDE_COLUMN_MAX,
      clear: "left",
    };
  }
  // Block layouts — full-width, no cap, but keep the alignment hint so a
  // future shorter-than-100% audio bar still respects left/right.
  const base = { width: "100%" } as const;
  if (align === "left") return { ...base, marginRight: "auto" };
  if (align === "right") return { ...base, marginLeft: "auto" };
  return { ...base, marginLeft: "auto", marginRight: "auto" };
}

export function audioLayoutCss(
  align: MediaAlign | undefined,
  float: MediaFloat | undefined,
): string {
  if (float === "left") {
    return `float:left;margin:0 16px 8px 0;width:100%;max-width:${SIDE_COLUMN_MAX};clear:right;`;
  }
  if (float === "right") {
    return `float:right;margin:0 0 8px 16px;width:100%;max-width:${SIDE_COLUMN_MAX};clear:left;`;
  }
  if (align === "left") return `margin:16px auto 16px 0;width:100%;`;
  if (align === "right") return `margin:16px 0 16px auto;width:100%;`;
  return `margin:16px auto;width:100%;`;
}

/**
 * Resolve layout to a React-style CSS object for use inside a NodeViewWrapper.
 */
export function mediaLayoutStyle(
  align: MediaAlign | undefined,
  float: MediaFloat | undefined,
): CSSProperties {
  if (float === "left") {
    return {
      float: "left",
      marginRight: 16,
      marginBottom: 8,
      width: "100%",
      maxWidth: SIDE_COLUMN_MAX,
      clear: "right",
    };
  }
  if (float === "right") {
    return {
      float: "right",
      marginLeft: 16,
      marginBottom: 8,
      width: "100%",
      maxWidth: SIDE_COLUMN_MAX,
      clear: "left",
    };
  }
  // Block layouts — pick which side of the prose column the figure hugs.
  const base = { width: "100%", maxWidth: BLOCK_MAX } as const;
  if (align === "left") return { ...base, marginRight: "auto" };
  if (align === "right") return { ...base, marginLeft: "auto" };
  return { ...base, marginLeft: "auto", marginRight: "auto" };
}

/**
 * Resolve layout to a CSS string for use inside a Tiptap `renderHTML` figure
 * style attribute. Output ends with a trailing semicolon so callers can
 * concatenate further declarations cleanly.
 */
export function mediaLayoutCss(
  align: MediaAlign | undefined,
  float: MediaFloat | undefined,
): string {
  if (float === "left") {
    return `float:left;margin:0 16px 8px 0;width:100%;max-width:${SIDE_COLUMN_MAX};clear:right;`;
  }
  if (float === "right") {
    return `float:right;margin:0 0 8px 16px;width:100%;max-width:${SIDE_COLUMN_MAX};clear:left;`;
  }
  if (align === "left")
    return `margin:16px auto 16px 0;width:100%;max-width:${BLOCK_MAX}px;`;
  if (align === "right")
    return `margin:16px 0 16px auto;width:100%;max-width:${BLOCK_MAX}px;`;
  return `margin:16px auto;width:100%;max-width:${BLOCK_MAX}px;`;
}
