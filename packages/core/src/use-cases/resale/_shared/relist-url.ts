import { trimTrailingSlash } from "../../../lib/url";

/**
 * Where a seller lists a ticket again: the Seller Hub's new-listing form,
 * opened on the order that holds the ticket when it is known
 * (`apps/web/src/app/sell/listings/new/page.tsx` reads `?orderId=`). The
 * older `/my-tickets/[orderId]/resell` route only redirects there.
 */
export function relistUrl(
  publicAppUrl: string | null | undefined,
  orderId: string | null | undefined,
): string {
  const base = `${trimTrailingSlash(publicAppUrl ?? "")}/sell/listings/new`;
  return orderId ? `${base}?orderId=${encodeURIComponent(orderId)}` : base;
}
