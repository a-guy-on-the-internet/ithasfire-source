import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Minimal layout for the embeddable membership-tiers widget
 * (recurring-memberships owner flow step 3). No navigation chrome, no footer —
 * renders cleanly inside a third-party iframe.
 *
 * Framing policy comes for free: next.config.ts serves `/embed/:path*` with
 * the open `frame-ancestors *` CSP override (the allowlist is enforced
 * server-side per request via `hostOrigin`, fail-closed — the settled embed
 * hardening posture).
 *
 * Theming and the transparent canvas come from the `/embed/*` route context
 * (middleware + root layout) — see the main embed layout
 * (`/embed/[embedId]/layout.tsx`).
 */
export default function EmbedMembershipsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
