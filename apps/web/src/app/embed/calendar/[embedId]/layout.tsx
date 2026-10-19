import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Minimal layout for the embeddable calendar widget.
 * No navigation chrome, no footer — renders cleanly inside a third-party iframe.
 *
 * This route hosts the FULL ticket widget (EmbedWidget with a calendar browse
 * view — detail/checkout/confirmation included), so this layout must stay in
 * lockstep with the ticket widget's `/embed/[embedId]/layout.tsx`. Theming and
 * the transparent canvas come from the `/embed/*` route context, which covers
 * both (see that layout and lib/route-context.ts).
 */
export default function EmbedCalendarLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
