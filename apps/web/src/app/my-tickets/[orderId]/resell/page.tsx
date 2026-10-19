import { redirect } from "next/navigation";

import { assertFeatureEnabled } from "@/server/feature-gates";

type PageProps = {
  params: Promise<{ orderId: string }>;
};

/**
 * Legacy resell route — redirects to the Seller Hub.
 *
 * The old `/my-tickets/[orderId]/resell` flow is superseded by
 * `/sell/listings/new`. We pass orderId so the new-listing page
 * can pre-select the correct tickets.
 *
 * `resale` is off by default; when off this `notFound()`s BEFORE redirecting,
 * so the legacy URL is dark rather than bouncing users to a 404'd Seller Hub.
 */
export default async function ResellRedirectPage({ params }: PageProps) {
  await assertFeatureEnabled("resale");
  const { orderId } = await params;
  redirect(`/sell/listings/new?orderId=${encodeURIComponent(orderId)}`);
}
