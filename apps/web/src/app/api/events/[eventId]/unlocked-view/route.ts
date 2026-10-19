import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import superjson from "superjson";

import { webEnv } from "@/config/env.server";
import {
  eventUnlockCookieName,
  verifyEventUnlockCookie,
} from "@/lib/event-unlock-cookie";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { loadUnlockedEventPageData } from "@/server/event-page-data";
import {
  fetchEventGateState,
  isLockedByEventGate,
  resolveEventSlug,
} from "@/server/events";

/**
 * The per-viewer half of the gated event page.
 *
 * `/events/[...slug]` is stamped `public, s-maxage=120, stale-while-revalidate=300`
 * and its `Vary` carries no `Cookie`, so its HTML is shared across everyone
 * behind a colo. It therefore renders the gate wall for a gated event and
 * NOTHING else — no bypass check, no unlock check, no event body. This endpoint
 * is where "may THIS viewer in?" is answered, and it is safe to ask here for
 * three independent reasons:
 *
 *  1. It is a POST, which no CDN in this stack caches.
 *  2. Every response carries `Cache-Control: private, no-store`.
 *  3. It lives under `/api`, outside the `/events/:path*` header rule that
 *     applies the shared-cache policy.
 *
 * It is also SAME-ORIGIN with the web app, which is load-bearing: the anonymous
 * grants are HttpOnly cookies set on the web host — `th_eu_<eventId>`
 * (password), `th_ea_<eventId>` (approved application) and `th_ei_<eventId>`
 * (invite link, either gate) — and the browser will not send them to the API's
 * own origin. The route reads the password cookie here, and the SSR tRPC
 * client forwards all three upstream.
 *
 * Contract:
 *   POST → `{ access: "locked" }`
 *        | `{ access: "locked", removedByInviteReset: true }`
 *        | `{ access: "unlocked", data: <superjson EventPageData> }`
 *
 * `removedByInviteReset` is present (and only ever `true`) when the API found
 * that this viewer's own proof — their signed `th_ei_` grant or their own
 * revoked unlock — was ended by the organiser's "Reset and remove everyone"
 * (`viewerRemovedByInviteReset`). The gate uses it to say why they are
 * locked out. Every other locked answer, including every failure, is the
 * bare `{ access: "locked" }`.
 *
 * The payload it hands back carries NO viewer-scoped field either — the reveal,
 * the edit affordance and the RSVP state ride `POST .../viewer-state` on both
 * the gated and the ungated path, so there is exactly one place they come
 * from. (Nothing here is cached, so that is uniformity rather than necessity.)
 *
 * superjson (not `JSON.stringify`) because the payload is full of `Date`s —
 * `event.startsAt`, `ticketTypes[].upcomingPriceChange.at` — that the renderer
 * calls date methods on.
 */

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applied to EVERY response, including the failures — the exported `POST` is
 * the single exit, and it stamps whatever `resolveUnlockedView` returns OR
 * throws. A gated event's content rides this endpoint; there is no response
 * shape here that may be stored by a shared cache.
 */
function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  return res;
}

async function resolveUnlockedView(
  req: NextRequest,
  eventId: string,
): Promise<NextResponse> {
  // Origin check, mirroring `../unlock/route.ts`: SameSite=Lax already blocks
  // most cross-site POSTs, but this one hands back gated content, so the
  // belt-and-suspenders check stays.
  const origin = req.headers.get("origin");
  const siteOrigin = (() => {
    try {
      return new URL(webEnv.siteUrl).origin;
    } catch {
      return null;
    }
  })();
  if (origin && siteOrigin && origin !== siteOrigin) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  if (!UUID_RE.test(eventId)) {
    return NextResponse.json({ error: "invalid_event_id" }, { status: 400 });
  }

  const gateState = await fetchEventGateState(eventId);
  if (!gateState) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Same two inputs the page used to branch on, asked in the one place where
  // asking is safe. `hasValidPasswordUnlockCookie`'s PASSWORD-only scope is
  // preserved verbatim — the API's `ensureFullEventReadAccessByEventId` honours
  // the cookie under exactly that condition too, so widening it here would let
  // the page render content the API then refuses.
  //
  // APPLICATION gates need nothing here: the forwarded `th_ea_` grant was
  // already judged by the API (signature + submission still APPROVED) and is
  // folded into `gateState.applicationRequired`. The same holds for an invite
  // grant (`th_ei_`, either gate): the API re-checks the invite and folds
  // `viewerHasInviteGrant` into both *Required flags.
  const cookieUnlocked = await (async () => {
    if (gateState.gateType !== "PASSWORD") return false;
    const cookieStore = await cookies();
    return verifyEventUnlockCookie(
      eventId,
      cookieStore.get(eventUnlockCookieName(eventId))?.value,
    );
  })();

  if (isLockedByEventGate(gateState, cookieUnlocked)) {
    return NextResponse.json(
      gateState.viewerRemovedByInviteReset
        ? { access: "locked", removedByInviteReset: true }
        : { access: "locked" },
    );
  }

  const resolution = await resolveEventSlug(eventId);
  if (!resolution) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let data: Awaited<ReturnType<typeof loadUnlockedEventPageData>>;
  try {
    data = await loadUnlockedEventPageData(eventId, resolution.currentSlug);
  } catch (err) {
    // The API re-checks the gate on every read (`ensureFullEventReadAccess*`).
    // Landing here means this route's verdict and the API's disagreed, which is
    // a bug worth a Sentry event of its own — narrower than the outer catch, so
    // keep the distinct label.
    traceIgnoredError("event.unlockedView.loadFailed")(err);
    return NextResponse.json({ access: "locked" });
  }

  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    access: "unlocked",
    data: superjson.serialize(data),
  });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;
  try {
    return noStore(await resolveUnlockedView(req, eventId));
  } catch (err) {
    // `fetchEventGateState` and `resolveEventSlug` rethrow anything that is not
    // NOT_FOUND, so an API outage used to escape as a Next 500 — which never
    // passed through `noStore`, contradicting the invariant asserted on it. It
    // also failed OPEN in posture terms: the caller could not tell "no" from
    // "broken". Both are closed here — every exit is stamped, and an
    // unresolvable gate reads as `locked`.
    traceIgnoredError("event.unlockedView.failed")(err);
    return noStore(NextResponse.json({ access: "locked" }));
  }
}
