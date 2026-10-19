import { NextResponse, type NextRequest } from "next/server";

import { webEnv } from "@/config/env.server";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import {
  EMPTY_EVENT_VIEWER_STATE,
  loadEventViewerState,
  type EventViewerState,
} from "@/server/event-viewer-state";
import { resolveEventSlug } from "@/server/events";

/**
 * The per-viewer half of EVERY event page — gated or not.
 *
 * `/events/[...slug]` is stamped `public, s-maxage=120, stale-while-revalidate=300`
 * and its `Vary` carries no `Cookie`, so its HTML and RSC payload are shared
 * across everyone behind a colo, and indexed. It therefore renders the event as
 * resolved for NOBODY: an OBSCURED venue's address stays obscured, there is no
 * "Edit Event" affordance, and no "you're going". Whether THIS viewer is a
 * ticket holder / an editor / going is answered here, and it is safe to ask
 * here for three independent reasons:
 *
 *  1. It is a POST, which no CDN in this stack caches.
 *  2. Every response carries `Cache-Control: private, no-store` — including
 *     the thrown ones, because the exported `POST` is the single exit.
 *  3. It lives under `/api`, outside the `/events/:path*` header rule that
 *     applies the shared-cache policy.
 *
 * Same-origin matters as much as it does for `../unlocked-view`: an anonymous
 * viewer's gate grant is an HttpOnly cookie set on the web host —
 * `th_eu_<eventId>` (password), `th_ea_<eventId>` (approved application) or
 * `th_ei_<eventId>` (invite link) —
 * which the browser will not send to the API's origin. The SSR tRPC client
 * forwards it upstream from here.
 *
 * Contract: POST → {@link EventViewerState} as plain JSON (no `Date`s in it —
 * `location` is scalars and the RSVP flags are booleans — so superjson would
 * buy nothing).
 *
 * FAIL-CLOSED on every path, and "closed" here means REDACTED: the empty state
 * leaves the page exactly as the cache-safe render left it. A stranger, an
 * outage, a bad event id and an unhandled throw are indistinguishable from the
 * outside, which is the point.
 */

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Applied to EVERY response — see the note on the module. */
function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  return res;
}

async function resolveViewerState(
  req: NextRequest,
  eventId: string,
): Promise<NextResponse> {
  // Origin check, mirroring `../unlock/route.ts` and `../unlocked-view`:
  // SameSite=Lax already blocks most cross-site POSTs, but this one hands back
  // a hidden venue's street address, so the belt-and-suspenders check stays.
  const origin = req.headers.get("origin");
  const siteOrigin = (() => {
    try {
      return new URL(webEnv.siteUrl).origin;
    } catch {
      return null;
    }
  })();
  if (origin && siteOrigin && origin !== siteOrigin) {
    return NextResponse.json(EMPTY_EVENT_VIEWER_STATE, { status: 403 });
  }

  if (!UUID_RE.test(eventId)) {
    return NextResponse.json(EMPTY_EVENT_VIEWER_STATE, { status: 400 });
  }

  const resolution = await resolveEventSlug(eventId);
  if (!resolution) {
    return NextResponse.json(EMPTY_EVENT_VIEWER_STATE, { status: 404 });
  }

  return NextResponse.json(
    await loadEventViewerState(eventId, resolution.currentSlug),
  );
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;
  try {
    return noStore(await resolveViewerState(req, eventId));
  } catch (err) {
    // `resolveEventSlug` rethrows anything that is not NOT_FOUND, so an API
    // outage would otherwise escape as a Next 500 that never passed through
    // `noStore`. Every exit is stamped, and an unresolvable request reads as
    // "no viewer state" — i.e. the redacted page stands.
    traceIgnoredError("event.viewerState.failed")(err);
    return noStore(NextResponse.json(EMPTY_EVENT_VIEWER_STATE));
  }
}
