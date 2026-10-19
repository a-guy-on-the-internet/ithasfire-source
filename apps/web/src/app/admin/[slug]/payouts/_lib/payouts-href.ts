/**
 * The Payouts URL the retired `/payments` route redirects to.
 *
 * Pure so the redirect contract is unit-testable without a Next runtime (same
 * shape as `placeSettingsHref`). Every query parameter survives, repeated ones
 * included: Stripe sends the account holder back to the onboarding
 * `returnUrl`, and an onboarding started before Payments merged into Payouts
 * still points at `/payments?…`.
 */
export function payoutsHref(args: {
  slug: string;
  searchParams?: Record<string, string | string[] | undefined>;
  section?: string;
}): string {
  const { slug, searchParams = {}, section } = args;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") query.append(key, value);
    else if (Array.isArray(value)) for (const v of value) query.append(key, v);
  }
  const qs = query.toString();
  // Raw, like every other admin href (`/admin/${slug}/…`): the slug arrives
  // exactly as the router matched it.
  return `/admin/${slug}/payouts${qs ? `?${qs}` : ""}${section ? `#${section}` : ""}`;
}
