import type { ReactNode } from "react";
import type { Metadata } from "next";

/**
 * The volunteer's own check-in code is a BEARER CREDENTIAL in the same sense a
 * printed ticket is: the signed token on the paper is the whole of the
 * identity assertion, and it stays valid until shortly after the event (or 14
 * days, whichever is sooner — `computeSelfPrintTtlSeconds`). So this route
 * takes the posture the ticket sheet and the badge sheet take: out of every
 * index, out of every shared cache, out of every Referer header.
 *
 * `robots` covers the server-rendered HTML; `next.config.ts` adds the matching
 * `X-Robots-Tag`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
 * headers — the last of which matters here because the URL carries an event id
 * in a query string.
 *
 * App chrome is suppressed by `AppChrome` via `isPrintDocumentRoute` — a
 * document page renders bare. Note that the same bypass skips `AppAuthGate`,
 * so ownership is entirely the data layer's: the sheet reads one
 * `authedProcedure` self-read scoped to the session actor, and the mint
 * authorizes before it inspects any state. See the SECURITY NOTE in
 * `src/lib/print-route.ts`.
 */
export const metadata: Metadata = {
  title: "Volunteer check-in code",
  robots: { index: false, follow: false },
};

export default function VolunteerQrPrintLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
