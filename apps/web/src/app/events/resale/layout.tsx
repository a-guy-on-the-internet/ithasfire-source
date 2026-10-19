import type { ReactNode } from "react";

import { assertFeatureEnabled } from "@/server/feature-gates";

/**
 * Route-level gate for the buyer-facing resale checkout surface. `resale` is
 * off by default; when off this `notFound()`s so the surface is unreachable by
 * direct URL. Sitting at `events/resale/` it covers every listing sub-route
 * (`/events/resale/[listingId]` and anything added later) in one place.
 */
export default async function ResaleCheckoutLayout({
  children,
}: {
  children: ReactNode;
}) {
  await assertFeatureEnabled("resale");
  return <>{children}</>;
}
