import type { ReactNode } from "react";
import type { Metadata } from "next";

/**
 * A printed ticket is a BEARER CREDENTIAL: the code on the paper is the whole
 * of the authorisation at the door. So this route is kept out of every index
 * and every cache.
 *
 * `robots` covers the server-rendered HTML; `next.config.ts` adds the matching
 * `X-Robots-Tag`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
 * headers so a ticket code can never ride out in a Referer header or sit in a
 * shared cache. Belt and braces, deliberately, and the same posture the QR
 * route itself takes.
 *
 * App chrome is suppressed for this route in `AppChrome` (`isPrintDocumentRoute`)
 * — a document page renders bare, exactly as `/embed/*` does.
 */
export const metadata: Metadata = {
  title: "Print tickets",
  robots: { index: false, follow: false },
};

export default function TicketPrintLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
