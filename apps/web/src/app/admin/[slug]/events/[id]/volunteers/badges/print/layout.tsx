import type { ReactNode } from "react";
import type { Metadata } from "next";

/**
 * A volunteer badge is a BEARER CREDENTIAL at roster scale: every badge on the
 * sheet carries a signed volunteer scan token that stays valid until shortly
 * after the event. So this route takes the same posture the printable ticket
 * sheet does — out of every index, out of every shared cache, out of every
 * Referer header.
 *
 * `robots` covers the server-rendered HTML; `next.config.ts` adds the matching
 * `X-Robots-Tag`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
 * headers for the client-component case.
 *
 * Chrome is suppressed twice over, and both are needed. `AppChrome` drops the
 * consumer shell via `isPrintDocumentRoute`; `AdminShellFrame` drops the ADMIN
 * shell via the same predicate, because layouts nest and `/admin/[slug]` would
 * otherwise wrap this document in the whole admin rail — which would then land
 * on the paper. Note that the first of those bypasses also skips
 * `AppAuthGate`, so authorization here is entirely the data layer's: every
 * read on the sheet is org-edit-gated server-side, and `mintScanToken`
 * authorizes before it inspects any state. See the SECURITY NOTE in
 * `src/lib/print-route.ts`.
 */
export const metadata: Metadata = {
  title: "Volunteer badges",
  robots: { index: false, follow: false },
};

export default function VolunteerBadgePrintLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
