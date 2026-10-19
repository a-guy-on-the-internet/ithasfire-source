import type { ReactNode } from "react";

import { assertFeatureEnabled } from "@/server/feature-gates";

/**
 * Route-level gate for the ticket-resale admin listings surface. `resale` is
 * off by default; when off this `notFound()`s so the surface is unreachable by
 * direct URL. Resale is not in the main admin nav, so the route guard is the
 * primary defence here.
 */
export default async function ResaleLayout({
  children,
}: {
  children: ReactNode;
}) {
  await assertFeatureEnabled("resale");
  return <>{children}</>;
}
