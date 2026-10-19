import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";

import { webEnv } from "@/config/env.server";
import { getTrpcHttpUrl } from "@/config/trpc";
import { mintTokenFromCookie } from "@/server/trpc-client";

/**
 * Purge the Next route cache for ONE place's public entity page.
 *
 * WHAT WAS MEASURED, because the obvious diagnosis is wrong. `/places/[slug]`
 * and `/p/[slug]` both declare `export const revalidate = 60`, which reads like
 * "anonymous visitors see a snapshot for up to a minute". THEY DO NOT. Both
 * routes build as `ƒ` (Dynamic, server-rendered on demand) — `loadEntityPageBySlug`
 * goes through the SSR tRPC client, whose `httpBatchLink` header callback awaits
 * `headers()`, and that one dynamic API opts the whole render out of the route
 * cache. Verified against a real `next build --turbopack` served by `next start`:
 * flipping `Place.acceptsBookingRequests` straight in Postgres and re-requesting
 * changed the rendered CTA on the VERY NEXT request, in both directions, with no
 * revalidation call at all. `revalidate = 60` is inert today.
 *
 * SO WHY KEEP THIS. Because the declaration is the stated intent, and the only
 * reason it does not hold is an incidental `headers()` call several layers down.
 * The day someone makes these pages genuinely cacheable — a sensible perf win,
 * and a one-line change from where they sit — a venue's booking switch would
 * silently go back to taking a minute to show up, with nothing to catch it.
 * This endpoint is what makes the toggle correct under BOTH regimes, and it is
 * the seam an edge purge belongs in (see the note at the bottom).
 *
 * SECURITY. An unauthenticated or path-taking revalidation endpoint is a
 * cache-busting DoS vector, so this one is neither:
 *
 *   - **Authenticated.** The viewer's session cookie is exchanged for a Bearer
 *     JWT (`mintTokenFromCookie`, the same helper `sync-unlock/route.ts` uses).
 *     No session, no token, no revalidation.
 *   - **Authorized against the place.** The upstream call is
 *     `entityPages.getMyPage({ ownerType: "PLACE", ownerId: placeId })`, whose
 *     gate is `authz.canManagePlace` — a verified human owner of the place, or
 *     an OWNER/ADMIN/EDITOR of an owning org — or, on a place NOBODY owns, a
 *     community moderator or platform ADMIN (`resolveEntityPageEditor`,
 *     moderator place page spec). That is the SAME bar as editing the public
 *     page itself, and it is BROADER than the bar on the two
 *     switches that call here: `places.setBookingAcceptance` and
 *     `places.setCommunityListingAcceptance` both require OWNER/ADMIN
 *     (`ORG_ADMIN_ROLES`), so an EDITOR can purge this cache without being
 *     able to move either flag. That is deliberate and it is safe, because a
 *     purge is not an edit: it is idempotent, it writes nothing, it DERIVES
 *     its own two paths from an authorized lookup (see the next bullet), and
 *     the page it re-renders is the very page an EDITOR may rewrite at will.
 *     The most an EDITOR gains is making their own content edit appear
 *     sooner. The two switches each call this ONE endpoint from their own
 *     local `purgePublicPage` — a single place-scoped purge serves both, and
 *     it needs to know nothing about which flag moved.
 *   - **Scoped to paths it DERIVES.** The caller supplies a place id and
 *     nothing else. The slug comes back from the authorized lookup, is shape-
 *     checked, and is interpolated into two fixed route templates. There is no
 *     caller-supplied path, so no way to aim this at `/` or at another venue.
 *
 * Not rate-limited on purpose: the blast radius of an authorized owner
 * hammering it is their own two paths, and a per-instance counter would be
 * decorative on a multi-instance Cloud Run deployment. If that changes, the
 * limiter belongs at the edge, not here.
 *
 * WHAT THIS STILL DOES NOT COVER, and it is the real staleness in deployed
 * production: Cloudflare. `next.config.ts` sends
 * `Cache-Control: public, s-maxage=120, stale-while-revalidate=300` for
 * `/places/:path*` and `/p/:path*`, and the cache ruleset
 * (`infra/terraform/modules/cloudflare-cache`) caches web HTML with
 * `edge_ttl.mode = "respect_origin"`. So a visitor can be served the old page
 * from the edge for up to two minutes (plus the stale window) no matter what
 * this handler does — `revalidatePath` reaches the Next route cache, never the
 * CDN. Closing that needs a scoped Cloudflare purge for these two paths, which
 * needs a zone-scoped API token wired into the web service. That is infra work,
 * it cannot be exercised locally, and it belongs right here when it lands. The
 * toggle's success copy tells the owner about that window rather than promising
 * an instant flip it cannot deliver.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Defence in depth on a value we already trust: the slug is server-derived, but
 * it is about to be interpolated into a cache key, so anything that could climb
 * out of the segment (`/`, `..`, `%`) is refused rather than sanitised.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/i;

/** Every public route that renders a PLACE entity page. Both are ISR-cached. */
function publicPathsForPlaceSlug(slug: string): string[] {
  return [`/places/${slug}`, `/p/${slug}`];
}

function log(
  outcome: "revalidated" | "rejected" | "upstream_error" | "no_page",
  fields: Record<string, unknown>,
): void {
  // Single-line JSON, matching `events/[eventId]/unlock/route.ts` — pino lives
  // in apps/api, not here.
  console.log(
    JSON.stringify({ event: "place_page_revalidate", outcome, ...fields }),
  );
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ placeId: string }> },
) {
  const { placeId } = await context.params;

  // ── Origin check ─────────────────────────────────────────────────────────
  // Same belt-and-suspenders as the unlock route: SameSite=Lax already blocks
  // most cross-site POSTs, but a stale tab or a misconfigured CDN can leak.
  const origin = req.headers.get("origin");
  const siteOrigin = (() => {
    try {
      return new URL(webEnv.siteUrl).origin;
    } catch {
      return null;
    }
  })();
  if (origin && siteOrigin && origin !== siteOrigin) {
    log("rejected", { reason: "origin_mismatch", origin, placeId });
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  if (!UUID_RE.test(placeId)) {
    log("rejected", { reason: "invalid_place_id", placeId });
    return NextResponse.json({ error: "invalid_place_id" }, { status: 400 });
  }

  const cookie = req.headers.get("cookie");
  const token = cookie ? await mintTokenFromCookie(cookie, req.headers) : null;
  if (!token) {
    log("rejected", { reason: "no_session", placeId });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── Authorize + derive the slug (one call, deliberately) ─────────────────
  // Plain fetch rather than the SSR tRPC client: that client is `React.cache`d
  // around `headers()` and hangs when invoked outside an RSC render — the same
  // reason `events/[eventId]/unlock/route.ts` proxies by hand.
  const input = encodeURIComponent(
    JSON.stringify({
      "0": { json: { ownerType: "PLACE", ownerId: placeId } },
    }),
  );
  const trpcUrl = `${getTrpcHttpUrl()}/entityPages.getMyPage?batch=1&input=${input}`;
  let upstream: Response;
  try {
    upstream = await fetch(trpcUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (err) {
    log("upstream_error", {
      reason: "fetch_threw",
      placeId,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "revalidate_failed" }, { status: 502 });
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    log("upstream_error", { reason: "non_json", placeId });
    return NextResponse.json({ error: "revalidate_failed" }, { status: 502 });
  }

  const entry = Array.isArray(body) ? body[0] : null;
  if (entry && typeof entry === "object" && "error" in entry) {
    const errBody = (
      entry as {
        error: { json?: { message?: string; data?: { code?: string } } };
      }
    ).error?.json;
    const upstreamCode = errBody?.data?.code;
    // Map on the tRPC code rather than the app code: the authorization answer
    // is what matters here, and NOT_FOUND ("this place has no page") is a
    // legitimate nothing-to-do rather than a failure.
    if (upstreamCode === "UNAUTHORIZED") {
      log("rejected", { reason: "unauthorized", placeId });
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (upstreamCode === "FORBIDDEN") {
      log("rejected", { reason: "not_place_owner", placeId });
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (upstreamCode === "NOT_FOUND") {
      log("no_page", { placeId });
      return NextResponse.json({ revalidated: [] }, { status: 404 });
    }
    log("upstream_error", {
      reason: "trpc_error",
      placeId,
      code: upstreamCode ?? null,
    });
    return NextResponse.json({ error: "revalidate_failed" }, { status: 502 });
  }

  const slug = (
    entry as { result?: { data?: { json?: { page?: { slug?: unknown } } } } }
  )?.result?.data?.json?.page?.slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    log("upstream_error", { reason: "unusable_slug", placeId });
    return NextResponse.json({ error: "revalidate_failed" }, { status: 502 });
  }

  const paths = publicPathsForPlaceSlug(slug);
  for (const path of paths) {
    revalidatePath(path);
  }
  log("revalidated", { placeId, paths });
  return NextResponse.json({ revalidated: paths });
}
