import type { CSSProperties, ReactNode } from "react";

import { getStubThemeSnapshot } from "@th/ui";

import "./print.css";
import "./print-hide.css";

/**
 * THE PAPER — the reusable wrapper every printable document renders into.
 *
 * Ithas Fire produces PDFs by styling a route for `@media print` and letting the
 * browser's Print → Save as PDF do the work. There is no pdfkit / puppeteer /
 * jspdf anywhere in the repo and there is not meant to be. `print.css` holds the
 * shared rules; this component holds the shared MARKUP and, critically, the
 * palette.
 *
 * ── Why the palette is written here, inline ────────────────────────────────
 *
 * The root layout resolves the theme SERVER-side and stamps a complete token
 * snapshot onto `<body>` as inline custom properties (`layout.tsx`). Inline
 * styles beat stylesheets, so a document that merely *asked* for light colours
 * in CSS would still inherit navy ink for any user whose ACCOUNT preference is
 * dark — and a printed dark-mode QR is an unscannable QR.
 *
 * Redeclaring the palette on this wrapper wins for the whole subtree: custom
 * properties inherit, and the nearest declaration is the one that resolves.
 * Two mechanisms were rejected:
 *   - a pre-paint `document.body.classList.add(...)` (what the embed layer
 *     does) — Tamagui overwrites `body.className`, so the class can be
 *     clobbered after hydration;
 *   - mutating `document.documentElement.style.colorScheme` — that survives
 *     client-side navigation OFF the print route and would leave the rest of
 *     the app in light form controls under a dark theme.
 *
 * The values come from `getStubThemeSnapshot()`, the canonical Stub (light)
 * theme, so this cannot drift from the design system and no hex is scattered
 * across the stylesheet.
 */
const stub = getStubThemeSnapshot();

/**
 * The snapshot enumerates its keys from `lightTheme` but reads values from
 * `stubTheme` (`packages/ui/src/ui/tamagui/tokens/colors.ts`). If those two
 * ever diverge — a token added to stub, or renamed on one side — a key here
 * resolves to `undefined`, React silently drops the custom property, and
 * `var(--print-ink)` falls back to inherited `color`: on a dark-theme account
 * that is near-white text on a white sheet. A blank-looking ticket, at a door.
 *
 * TypeScript cannot catch it: `Record<ThemeTokenKey, string>` is satisfied by
 * construction. So assert at module scope and fail loudly at import time
 * instead of quietly at the door.
 */
const requirePaletteValue = (
  key: string,
  value: string | undefined,
): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `[PaperSheet] Stub theme token "${key}" is missing from getStubThemeSnapshot(). ` +
        `The print palette cannot resolve, which renders an unreadable ticket sheet. ` +
        `Check packages/ui/src/ui/tamagui/tokens/colors.ts for a stub/light token divergence.`,
    );
  }
  return value;
};

const PAPER_PALETTE = {
  /** Warm ink (#211C16) — every printed glyph and hard rule. */
  "--print-ink": requirePaletteValue("color", stub.color),
  /** Secondary ink (#5C544A) — labels and sub-lines. 7.4:1 on white. */
  "--print-muted": requirePaletteValue("colorMuted", stub.colorMuted),
  /** Hard structural rule — the ink itself, per the Swiss border rule. */
  "--print-rule": requirePaletteValue("borderColor", stub.borderColor),
  /** Hairline / dashed rule — ink at 30%. */
  "--print-rule-soft": requirePaletteValue(
    "borderColorSoft",
    stub.borderColorSoft,
  ),
  /**
   * Accent as INK, not as a fill: `accent` (#E2481D) is the one brand value
   * with no AA foreground and, at 10pt on paper, it is also the one that
   * photocopies to mush. `accentText` (#B93312) is the sanctioned
   * accent-as-small-text rung and clears AA on white at 5.68:1.
   */
  "--print-accent": requirePaletteValue("accentText", stub.accentText),
  /**
   * The sheet itself, and the QR quiet zone. Pure white — NOT the Stub paper
   * cream (#FDFAF3). Two reasons: a scanner wants a true-white quiet zone
   * around a QR, and if the operator happens to have "Background graphics" ON
   * we should spend no ink tinting an entire sheet. `onBrandSecondary` is the
   * snapshot's pure white.
   */
  "--print-paper": requirePaletteValue(
    "onBrandSecondary",
    stub.onBrandSecondary,
  ),
} as CSSProperties;

/**
 * DOCUMENT-LIFETIME RULES — deliberately NOT in `print.css`.
 *
 * These target `@page`, `html` and `body`, so if they lived in a route
 * stylesheet they would follow the user off the print route: Next does not
 * unload route stylesheets on client-side navigation (see the header comment in
 * `print.css` for the citation), so "print sheet → Back to order → ⌘P" would
 * print the ORDER page with our 12mm page margin and transparent body.
 *
 * Rendered as a <style> element with NO `precedence` prop: React only hoists —
 * and only keeps — stylesheets that declare a precedence. Without it the tag
 * stays where it is rendered and is REMOVED when this component unmounts, which
 * is exactly the lifetime these rules should have.
 *
 * `html { color-scheme: light !important }` is the root half of the forced-light
 * mechanism. `color-scheme` on `.th-paper` only governs UA widgets inside that
 * subtree; the page CANVAS derives from the root, which the root layout stamps
 * `color-scheme: dark` on inline for a dark-mode user — so with "Background
 * graphics" ON and a sheet shorter than the page, the area below the paper
 * could render dark. An author `!important` beats an inline non-important
 * declaration, so this wins without touching the DOM and without outliving the
 * route.
 */
const DOCUMENT_RULES = `
@media print {
  /* 12mm all round: inside every consumer printer's unprintable margin on both
     Letter and A4, and wide enough that a stub's tear column never brushes the
     paper edge. */
  @page { margin: 12mm; }

  html { color-scheme: light !important; }

  html, body {
    background: transparent !important;
    margin: 0 !important;
    padding: 0 !important;
  }
}
`;

export type PaperSheetProps = {
  /** The document body. */
  children: ReactNode;
  /**
   * Screen-only controls rendered ABOVE the sheet (print button, back link).
   * Automatically hidden in print media.
   */
  toolbar?: ReactNode;
  /** Optional test hook / document identifier. */
  "data-testid"?: string;
};

export const PaperSheet = ({
  children,
  toolbar,
  "data-testid": testId,
}: PaperSheetProps) => (
  <>
    {/* No `precedence` — see DOCUMENT_RULES. React must NOT hoist this, so that
        it is torn down with the route rather than leaking `@page` onto the next
        page the user prints. */}
    <style>{DOCUMENT_RULES}</style>
    {toolbar ? (
      <div className="th-paper-toolbar" data-print-hide>
        {toolbar}
      </div>
    ) : null}
    <div className="th-paper" style={PAPER_PALETTE} data-testid={testId}>
      {children}
    </div>
  </>
);

PaperSheet.displayName = "PaperSheet";
