import type { ReactNode } from "react";

import { assertFeatureEnabled } from "@/server/feature-gates";

/**
 * Route-level gate for the messaging-CRM announcements surface. Shares the
 * `broadcasts` gate with audiences (announcements send to audiences). Off by
 * default; when off this `notFound()`s so the surface is unreachable by direct
 * URL, not just hidden from the admin nav.
 */
export default async function AnnouncementsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await assertFeatureEnabled("broadcasts");
  return <>{children}</>;
}
