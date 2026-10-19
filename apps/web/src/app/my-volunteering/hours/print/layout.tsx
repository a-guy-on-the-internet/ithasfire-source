import type { ReactNode } from "react";
import type { Metadata } from "next";

/**
 * An hours statement is not a bearer credential, but it IS a named record of
 * one person's whereabouts over months — where they were, when, and for whom.
 * So this route takes the same posture the printable ticket sheet does: out of
 * every index, out of every shared cache, out of every Referer header.
 *
 * `robots` covers the server-rendered HTML; `next.config.ts` adds the matching
 * `X-Robots-Tag`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
 * headers.
 *
 * App chrome is suppressed for this route by `AppChrome` via
 * `isPrintDocumentRoute` — a document page renders bare. Note that the same
 * bypass skips `AppAuthGate`, so the ownership check is entirely the data
 * layer's: the sheet reads one `authedProcedure` self-read scoped to the
 * session actor. See the SECURITY NOTE in `src/lib/print-route.ts`.
 */
export const metadata: Metadata = {
  title: "Volunteer hours statement",
  robots: { index: false, follow: false },
};

export default function VolunteerHoursPrintLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
