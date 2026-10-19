import type { Metadata } from "next";
import { Suspense } from "react";

import { DisputeDesk } from "./_components/DisputeDesk";

export const metadata: Metadata = {
  title: "Disputes · Platform",
  robots: { index: false, follow: false },
};

/**
 * Platform dispute desk — chargeback evidence review and submission.
 *
 * RBAC: `/platform/**` is gated by the layout (server) and `PlatformShell`
 * (client); `platform.disputes.*` additionally enforces the desk roles inside
 * every use case (reads ADMIN|SUPPORT, writes ADMIN), so the page never
 * trusts the client gate alone.
 */
export default function PlatformDisputesPage() {
  // DisputeDesk reads `?dispute=<id>` via useSearchParams, which requires a
  // Suspense boundary in the App Router. Mirrors /platform/support/page.tsx.
  return (
    <Suspense>
      <DisputeDesk />
    </Suspense>
  );
}
