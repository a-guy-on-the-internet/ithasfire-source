/**
 * The search params a Next.js page receives: every key in the request's query
 * string, whatever the page's own type claims to read.
 */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/**
 * Re-serialise a page's search params as a `?…` suffix (or `""` when there
 * are none), for a redirect that must land on the new URL with the SAME query.
 *
 * Used by the event slug-history redirects: an old event URL can carry a
 * magic-link `token`, a `ref` attribution tag, `resumeOrderId`, UTM tags —
 * none of which is the redirect's business to drop. Repeated keys are kept in
 * order; values are URL-encoded.
 */
export function forwardSearchParams(
  params: PageSearchParams | null | undefined,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      query.append(key, item);
    }
  }
  const serialised = query.toString();
  return serialised ? `?${serialised}` : "";
}
