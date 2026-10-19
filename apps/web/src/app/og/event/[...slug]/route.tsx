import { readFile } from "node:fs/promises";
import path from "node:path";

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";

import {
  eventStubVenueLine,
  resolveEventOgImage,
  STATIC_OG_FALLBACK_PATH,
} from "@th/types/seo/eventOgImage";

import { getSiteUrl } from "@/config/site";
import { hasRenderableGlyph } from "@/server/og/font-coverage";
import { isAllowedHeroImageUrl } from "@/server/og/hero-origin";
import { loadOgEvent } from "@/server/og/load-og-event";
import { loadOgFonts, renderDateStubResponse } from "@/server/og/render";

/**
 * `GET /og/event/<event-slug>` — the generated Open Graph "Date Stub".
 *
 * Keyed by SLUG, not by event id, because the only public, identity-free
 * accessor in the stack (`events.getEventSeo`) is slug-keyed; an id-keyed route
 * would have had to invent a privileged read for a publicly cached artifact.
 * Event slugs are multi-segment (`org/us/general/title--ab12cd`), hence the
 * catch-all.
 *
 * `runtime = "nodejs"`: the four OG TTFs are read off disk with `fs`.
 */
export const runtime = "nodejs";

/**
 * A URL whose `?v=` still matches the freshly computed signature.
 *
 * ── WHY THIS IS BOUNDED AND NOT `immutable` ─────────────────────────────────
 * The URL is content-addressed, so `immutable` LOOKS free: the bytes for a
 * given `?v=` really never change. But what an uploaded poster changes is not
 * the bytes behind key A — it is WHICH KEY IS CORRECT, and two whole classes of
 * consumer can never learn the new one:
 *
 *   - already-delivered emails, which embed `?v=A` permanently (there is no
 *     re-scrape of an email in somebody's inbox);
 *   - already-posted Slack / Twitter / Facebook links, whose unfurl caches hold
 *     `?v=A` and re-fetch on their own schedule, if ever.
 *
 * Cloudflare respects origin TTLs here (`infra/terraform/modules/cloudflare-
 * cache` uses `edge_ttl { mode = "respect_origin" }` with no `/og` exclusion)
 * and Gmail's image proxy caches hard, so a year of `immutable` means the
 * organiser's real poster NEVER reaches those surfaces. That is verbatim the
 * failure mode this feature exists to prevent, so content-addressing buys a
 * long ORIGIN/edge cache (`s-maxage`) and a generous `stale-while-revalidate`,
 * never an unbounded DOWNSTREAM one.
 */
const STUB_CACHE =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

/**
 * Everything that is not the canonical stub: redirects, the static poster, and
 * any answer a caller should re-ask for soon. Deliberately much shorter than
 * {@link STUB_CACHE} — these are pointers, and a pointer that outlives what it
 * points at is the whole problem.
 */
const SHORT_CACHE = "public, max-age=60, stale-while-revalidate=300";

/**
 * Last resort: the static poster, streamed with a short cache.
 *
 * An OG route must DEGRADE, never 500 — a 5xx here is a link preview with a
 * broken image slot on every surface that already fetched it. Streaming beats
 * a redirect because some crawlers do not follow one; the redirect is only the
 * fallback's fallback.
 */
const staticFallback = async (req: NextRequest): Promise<Response> => {
  try {
    const bytes = await readFile(
      path.join(process.cwd(), "public", STATIC_OG_FALLBACK_PATH.slice(1)),
    );
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": SHORT_CACHE,
      },
    });
  } catch {
    return NextResponse.redirect(
      new URL(STATIC_OG_FALLBACK_PATH, req.nextUrl.origin),
      302,
    );
  }
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string[] }> },
): Promise<Response> {
  try {
    const { slug: segments } = await ctx.params;
    const slug = (segments ?? []).join("/");
    if (!slug) return staticFallback(req);

    // Unknown or deleted event, and — see `isExpectedMiss` — a gated event read
    // anonymously: the static poster, not a 404. A crawler that already has the
    // URL should still get an image.
    const event = await loadOgEvent(slug);
    if (!event) return staticFallback(req);

    // A DRAFT / PRIVATE / ARCHIVED event's title, date and venue must not be
    // baked into a publicly cached PNG. The page itself is protected by
    // `robots: noindex` in `generateMetadata`, but there is no `X-Robots-Tag`
    // on `/og/*`, and a cached image is readable by anyone holding the URL
    // regardless of robots directives. Only PUBLISHED renders.
    if (event.status !== "PUBLISHED") return staticFallback(req);

    // An event that has SINCE gained a real poster: send it. This is the
    // healing half of the signature story — an old stub URL in a cached
    // <meta> tag stops serving a generated image the moment a hero exists.
    const resolved = resolveEventOgImage(event, getSiteUrl());
    if (resolved.kind === "hero") {
      if (!isAllowedHeroImageUrl(resolved.url, getSiteUrl())) {
        // Not reachable from user input today; a hit means a storage origin
        // nobody added to the allowlist, which is a misconfiguration worth
        // seeing rather than a silent downgrade of every healed poster.
        Sentry.captureException(
          new Error("og hero image origin is not allowed"),
          { tags: { area: "og-image", route: "og/event" } },
        );
        return staticFallback(req);
      }
      return NextResponse.redirect(resolved.url, {
        status: 302,
        headers: { "Cache-Control": SHORT_CACHE },
      });
    }

    // `?v=` is the cache key, and an absent or MISMATCHED one is a caller
    // holding a stale URL. REDIRECT rather than render:
    //
    //   - it heals properly. The consumer follows to the canonical key and
    //     caches THAT, so the next fetch is a cache hit on the right URL
    //     instead of a perpetual short-cached render of the wrong one;
    //   - it closes unauthenticated render amplification. `?v=` is part of the
    //     edge cache key and is attacker-chosen, so rendering on mismatch made
    //     `?v=<random>` an unauthenticated, unthrottled way to force two tRPC
    //     round-trips plus a full 1200x630 satori+resvg rasterisation per
    //     request, trivially looped. A 302 collapses that to a lookup.
    //
    // The hero arm above already 302s, so this is the same shape.
    const requested = req.nextUrl.searchParams.get("v");
    if (requested !== resolved.signature) {
      // Loop guard: only redirect to a URL that is genuinely DIFFERENT from the
      // one asked for. A canonical URL that somehow round-tripped back to the
      // rejected key would otherwise bounce forever, so render instead.
      const canonical = new URL(resolved.url, req.nextUrl.origin);
      if (canonical.searchParams.get("v") !== requested) {
        return NextResponse.redirect(canonical.toString(), {
          status: 302,
          headers: { "Cache-Control": SHORT_CACHE },
        });
      }
    }

    // A title with NO renderable codepoint (an entirely CJK / Cyrillic /
    // Devanagari title against Latin faces) would rasterise as a date column
    // beside an empty body. The static poster is the better artifact. A
    // PARTIALLY unrenderable title — "Comedy Night 🎤" minus the emoji — is
    // fine and deliberately still renders.
    const title = (event.title ?? "").trim();
    if (!hasRenderableGlyph(title, await loadOgFonts())) {
      return staticFallback(req);
    }

    return await renderDateStubResponse(
      {
        title,
        startsAt: event.startsAt,
        timezone: event.timezone,
        // The SAME helper the signature hashes, so the drawn line and the
        // cache key cannot drift apart. (`eventStubCaption` is not passed:
        // it is inert and the stub draws no caption row — see that function.)
        venueLine: eventStubVenueLine(event),
      },
      { "Cache-Control": STUB_CACHE },
    );
  } catch (err) {
    // Deliberate swallow: this route must produce an image or nothing useful
    // happens downstream. Reported rather than logged so a systematically
    // broken OG renderer (missing fonts in a new image, a transport failure)
    // is visible instead of showing up as "previews look plain". Rasterisation
    // failures land here too, now that `renderDateStubResponse` buffers the
    // bytes instead of handing back a 200 that fails mid-stream.
    Sentry.captureException(err, {
      tags: { area: "og-image", route: "og/event" },
    });
    return staticFallback(req);
  }
}
