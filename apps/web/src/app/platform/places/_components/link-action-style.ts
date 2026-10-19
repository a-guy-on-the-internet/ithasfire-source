import { ACCENT_TEXT } from "@/lib/design-tokens";

/**
 * Text-weight action on /platform/places: an accent label in the button
 * idiom, no frame. The padding/negative margin pair gives a 44px hit area
 * without growing the row. Shared by the place panel and the merge dialog.
 */
export const LINK_ACTION_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "12px 0",
  margin: "-12px 0",
  background: "none",
  border: 0,
  cursor: "pointer",
  color: ACCENT_TEXT,
  fontFamily: "var(--font-body, sans-serif)",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  textDecoration: "none",
  lineHeight: "20px",
  whiteSpace: "nowrap",
};

/** The same action for a label that may wrap (a place name inside it). */
export const LINK_ACTION_WRAP_STYLE: React.CSSProperties = {
  ...LINK_ACTION_STYLE,
  whiteSpace: "normal",
  textAlign: "left",
};
