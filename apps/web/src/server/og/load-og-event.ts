import "server-only";

import { TRPCClientError } from "@trpc/client";

import type { EventOgImageInput } from "@th/types/seo/eventOgImage";

import { getPublicTrpcClient } from "@/server/trpc-client";

/**
 * Loads just enough of an event to render (or key) its OG image.
 *
 * ── WHY THIS IS NOT `loadPublicEventSeo` ────────────────────────────────────
 * Both steps run on {@link getPublicTrpcClient} — no bearer token, no
 * forwarded cookies. (`loadPublicEventSeo` is identity-free too, slug
 * resolution included; this loader stays separate because it reads only the
 * few fields the image needs, with no body-excerpt fallback.) The OG route is served with a long, shared `Cache-Control` and no
 * `Vary: Cookie`, so nothing it asks may be answerable differently for
 * different callers. In particular an OBSCURED
 * event's exact address must never be able to influence a publicly cached
 * artifact — `get-event-seo` redacts `location` when there is no
 * `viewerHumanId`, and asking anonymously is the only way to guarantee that,
 * since the obfuscation inputs never cross the wire and redaction cannot be
 * re-applied downstream. Same reasoning as the doc comment above
 * `loadPublicEventSeo` in `@/server/events`.
 *
 * NOT `cache()`d: a route handler is one read per request, and `cache()` only
 * memoizes inside a React request scope anyway.
 */
export type OgEvent = EventOgImageInput & { status: string };

/**
 * The tRPC codes that mean "there is no event this route may draw" — an answer,
 * not a fault.
 *
 * FORBIDDEN belongs here with NOT_FOUND. `ensureFullEventReadAccessBySlug`
 * throws FORBIDDEN for a GATED event read anonymously, and this loader is
 * anonymous BY DESIGN (see above), so every gated event produces one on every
 * OG fetch. Rethrowing put that on the route's `Sentry.captureException`, which
 * turned routine, expected, correct behaviour into a stream of exceptions — and
 * systematically so, since the waitlist email embeds this URL and every
 * image-proxy fetch of every such email minted another. Both codes mean the
 * same thing to a caller that can only draw public data: nothing to draw, serve
 * the static poster. Genuinely unexpected failures still rethrow and are still
 * reported.
 */
const isExpectedMiss = (err: unknown): boolean => {
  if (!(err instanceof TRPCClientError)) return false;
  const code = (err.data as { code?: string } | undefined)?.code;
  return code === "NOT_FOUND" || code === "FORBIDDEN";
};

export const loadOgEvent = async (slug: string): Promise<OgEvent | null> => {
  const client = getPublicTrpcClient();

  let canonicalSlug = slug;
  try {
    const resolution = await client.events.resolveEventBySlug.query({ slug });
    canonicalSlug = resolution.currentSlug;
  } catch (err) {
    if (isExpectedMiss(err)) return null;
    throw err;
  }

  try {
    const payload = await client.events.getEventSeo.query({
      slug: canonicalSlug,
    });
    return {
      id: payload.id,
      slug: payload.slug,
      title: payload.title,
      startsAt: payload.startsAt,
      timezone: payload.timezone ?? null,
      updatedAt: payload.updatedAt ?? null,
      images: payload.images ?? [],
      // `location.name` is the venue label, and it is DISCLOSURE-gated on the
      // server (see `buildEventSeo`): a confirmed, listed venue is named; an
      // unconfirmed community listing may be named as plain text (owner ruling
      // 2026-10-06; no endorsement implied); anything else, or a withheld,
      // hidden or approximate location, comes back without a name. A missing
      // name stays common, so `city`/`region` ride along as the stub's fallback
      // line — same payload, same public disclosure decision, and already
      // published in the page's `event:location:city` / `…:region` meta tags.
      // Nothing finer than city/region is read here (see `eventStubVenueLine`).
      venueName: payload.location?.name ?? null,
      city: payload.location?.city ?? null,
      region: payload.location?.region ?? null,
      status: payload.status,
    };
  } catch (err) {
    if (isExpectedMiss(err)) return null;
    throw err;
  }
};
