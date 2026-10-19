import type { Metadata } from "next";
import { Suspense } from "react";

import { SupportInbox } from "./_components/SupportInbox";

export const metadata: Metadata = {
  title: "Support · Platform",
  robots: { index: false, follow: false },
};

/**
 * Operator support inbox.
 *
 * RBAC: this route lives under `/platform/**`, whose shell (`PlatformShell`)
 * gates every child on `trpc.platform.checkStaffAccess` — only ADMIN /
 * REVIEWER / SUPPORT / DEVELOPER humans get past it, redirecting everyone
 * else to `/access-denied` (NFR-004). The underlying `support.listThreads` /
 * `support.replyToThread` / `support.setThreadStatus` procedures additionally
 * enforce the staff role server-side, so the page never trusts the client gate
 * alone.
 */
export default function PlatformSupportPage() {
  // SupportInbox reads `?thread=<id>` via useSearchParams, which requires a
  // Suspense boundary in the App Router. Mirrors /platform/orders/page.tsx.
  return (
    <Suspense>
      <SupportInbox />
    </Suspense>
  );
}
