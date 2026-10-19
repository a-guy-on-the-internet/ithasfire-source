import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Minimal layout for the embeddable "Request to book" widget
 * (booking-request-embed-button FR-002). No navigation chrome, no footer —
 * renders cleanly inside a third-party iframe.
 *
 * Theming and the transparent canvas come from the `/embed/*` route context
 * (middleware + root layout) — see the main embed layout
 * (`/embed/[embedId]/layout.tsx`).
 */
export default function EmbedBookingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
