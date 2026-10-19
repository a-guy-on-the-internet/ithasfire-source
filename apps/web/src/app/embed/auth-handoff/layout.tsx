import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Minimal layout for the embed auth-handoff POPUP
 * (booking-request-embed-button FR-010). This page lives under /embed/* for
 * routing symmetry with the widget it serves, but it is a TOP-LEVEL popup —
 * it must never run framed (the page itself refuses to operate in an iframe;
 * see page.tsx).
 */
export default function EmbedAuthHandoffLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
