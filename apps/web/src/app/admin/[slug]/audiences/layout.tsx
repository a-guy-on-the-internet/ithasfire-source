import type { ReactNode } from "react";

import { assertFeatureEnabled } from "@/server/feature-gates";

/**
 * Route-level gate for the messaging-CRM audiences surface (list + import +
 * detail). `broadcasts` is off by default; when off this `notFound()`s so the
 * surface is unreachable by direct URL, not just hidden from the admin nav.
 * Guarding here covers every leaf (`/audiences`, `/audiences/import`,
 * `/audiences/[listId]`) in one server-rendered place.
 */
export default async function AudiencesLayout({
  children,
}: {
  children: ReactNode;
}) {
  await assertFeatureEnabled("broadcasts");
  return <>{children}</>;
}
