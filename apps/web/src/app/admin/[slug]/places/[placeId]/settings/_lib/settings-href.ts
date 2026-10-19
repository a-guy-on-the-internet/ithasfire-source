/**
 * The venue settings URL the retired `/edit` and `/verify` routes redirect to.
 *
 * Pure so the redirect contract is unit-testable without a Next runtime.
 * Query parameters survive (a bookmarked `?foo=1` still means what it meant);
 * the `section` becomes the fragment the settings page scrolls to and focuses
 * once its sections have rendered (`/verify` → `#verification`).
 *
 * A fragment the ORIGINAL request carried is never visible to a server
 * redirect. With no `section` the Location header carries none, and the
 * browser then keeps the original one (RFC 9110 §10.2.2), so `/edit#location`
 * still lands on `#location`.
 */
export function placeSettingsHref(args: {
  slug: string;
  placeId: string;
  searchParams?: Record<string, string | string[] | undefined>;
  section?: string;
}): string {
  const { slug, placeId, searchParams = {}, section } = args;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") query.append(key, value);
    else if (Array.isArray(value)) for (const v of value) query.append(key, v);
  }
  const qs = query.toString();
  // Raw, like every other admin href (`/admin/${slug}/…`) and the event
  // redirector: the params arrive exactly as the router matched them.
  const base = `/admin/${slug}/places/${placeId}/settings`;
  return `${base}${qs ? `?${qs}` : ""}${section ? `#${section}` : ""}`;
}
