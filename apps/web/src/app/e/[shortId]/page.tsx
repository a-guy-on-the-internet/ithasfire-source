import { notFound, redirect } from "next/navigation";

import { eventPublicPath } from "@th/core/lib/public-urls";
import { parseShortId } from "@th/core/lib/slug-utils";

import {
  forwardSearchParams,
  type PageSearchParams,
} from "@/lib/forward-search-params";
import { resolvePublicEventShortLink } from "@/server/events";

// Declared, not inferred. This page must never be cached: its answer depends
// on the event's status and its slug, and the Cloudflare rule for this path
// respects origin headers. Without this line it stays dynamic only by accident
// of the code above (awaiting `searchParams`, the tRPC client reading
// `headers()`); drop the query forwarding and the invalid-id `notFound()`
// branch would lose its last dynamic signal.
export const dynamic = "force-dynamic";

type EventShortLinkPageParams = {
  params: Promise<{ shortId: string }>;
  searchParams?: Promise<PageSearchParams>;
};

/**
 * `/e/<shortId>` — the short link the event builder prints — sends the
 * visitor to the event's canonical page (`/events/<slug…>`).
 *
 * Only for an event the public may read; a DRAFT, an unknown ID or anything
 * that is not a short ID is the app's ordinary 404 (see
 * `resolveEventShortLink` for why a draft is withheld).
 */
export default async function EventShortLinkPage({
  params,
  searchParams,
}: EventShortLinkPageParams) {
  const { shortId: rawShortId } = await params;
  const query = await searchParams;

  // Not a short ID ⇒ 404 without an API round trip. The use case applies the
  // same check; this only saves the request.
  const shortId = parseShortId(rawShortId);
  if (!shortId) {
    notFound();
  }

  const resolution = await resolvePublicEventShortLink(shortId);
  const target = resolution ? eventPublicPath(resolution.currentSlug) : null;
  if (!target) {
    notFound();
  }

  // TEMPORARY (307), never `permanentRedirect`: the target depends on the
  // event's status (it 404s the moment the event stops being publicly
  // readable) and its slug can be regenerated. A 308 is cached by browsers
  // indefinitely and would pin the old answer. Query params (`ref`, UTM tags)
  // ride along, as on the slug-history redirects.
  redirect(`${target}${forwardSearchParams(query)}`);
}
