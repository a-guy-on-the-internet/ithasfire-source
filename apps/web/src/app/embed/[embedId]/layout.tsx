import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Minimal layout for the embeddable widget.
 * No navigation chrome, no footer — just the bare content so it renders
 * cleanly inside a third-party iframe.
 *
 * Theming comes from the `/embed/*` route context (middleware + root layout —
 * see lib/route-context.ts), not from this layout:
 *  - the appearance is LOCKED to the platform's light theme (Stub + the active
 *    preset), whatever the viewer toggled on ithasfire.com. That also pins
 *    `color-scheme: light` on <html> from the first byte, which matters for
 *    transparency: the CSS color-adjust spec gives an iframe whose scheme
 *    differs from its host an OPAQUE canvas of its own scheme, so a
 *    dark-scheme embed on a light host painted a dark backdrop;
 *  - `<body data-th-embed>` makes the canvas transparent so the host page
 *    shows through (globals.css).
 */
export default function EmbedLayout({ children }: { children: ReactNode }) {
  return children;
}
