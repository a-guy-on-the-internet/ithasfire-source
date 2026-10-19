import type { ActiveCart } from "@/hooks/useCartRecovery";

/**
 * Where a held cart resumes: the slug-addressed checkout route, which reads
 * `resumeOrderId`. Returns null when the event has no slug, because there is
 * no slug-free checkout route to fall back to. The slug is multi-segment
 * (`org/us/city/name-…`), so it is NOT URI-encoded.
 */
export function cartResumeHref(
  cart: Pick<ActiveCart, "id" | "eventSlug">,
): string | null {
  if (!cart.eventSlug) return null;
  return `/events/checkout/${cart.eventSlug}?resumeOrderId=${encodeURIComponent(cart.id)}`;
}
