import { NextResponse, type NextRequest } from "next/server";

import type { VisibleArrivalArea } from "@th/core/use-cases/arrival-areas";

import { webEnv } from "@/config/env.server";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { loadViewerPlaceArrivalAreas } from "@/server/arrival-areas";

/**
 * The per-viewer arrival areas of a place page (arrival-areas FR-008,
 * NFR-001), modelled on `POST /api/events/[eventId]/viewer-state`.
 *
 * `/places/*` is edge-cached (`public, s-maxage=120`, no Cookie in Vary), so
 * the document carries only the anonymous, `cacheablePublic` list. A place's
 * managers also see its load-in, and the areas of a place that withholds its
 * address; that answer depends on WHO IS ASKING and is fetched here, after
 * hydration. Safe for three independent reasons:
 *
 *  1. It is a POST, which no CDN in this stack caches.
 *  2. Every response carries `Cache-Control: private, no-store`, including
 *     the thrown ones: the exported `POST` is the single exit.
 *  3. It lives under `/api`, outside the `/places/:path*` header rule.
 *
 * The browser could reach the API's tRPC directly, but the session cookie is
 * scoped to the web host; this route mints the bearer token server-side the
 * same way every other per-viewer read does (`getServerTrpcClient`).
 *
 * Contract: POST → `{ areas: VisibleArrivalArea[] | null }`. `null` means
 * "keep what the page already shows" and is what a stranger, an error, a bad
 * id and an outage all produce. FAIL-CLOSED: nothing here ever widens the
 * page on a failure. NFR-002: nothing here logs a geometry or a point.
 */

export const dynamic = "force-dynamic";

export type PlaceArrivalAreasResponse = {
  areas: VisibleArrivalArea[] | null;
};

const EMPTY: PlaceArrivalAreasResponse = { areas: null };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Applied to EVERY response; see the note on the module. */
function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  return res;
}

async function resolve(
  req: NextRequest,
  placeId: string,
): Promise<NextResponse> {
  // Origin check, as viewer-state: SameSite=Lax blocks most cross-site POSTs,
  // and this one can hand back a withheld place's parking for its manager.
  const origin = req.headers.get("origin");
  const siteOrigin = (() => {
    try {
      return new URL(webEnv.siteUrl).origin;
    } catch {
      return null;
    }
  })();
  if (origin && siteOrigin && origin !== siteOrigin) {
    return NextResponse.json(EMPTY, { status: 403 });
  }

  if (!UUID_RE.test(placeId)) {
    return NextResponse.json(EMPTY, { status: 400 });
  }

  const areas = await loadViewerPlaceArrivalAreas(placeId);
  return NextResponse.json({ areas } satisfies PlaceArrivalAreasResponse);
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ placeId: string }> },
) {
  try {
    const { placeId } = await context.params;
    return noStore(await resolve(req, placeId));
  } catch (err) {
    traceIgnoredError("place.arrivalAreas.route")(err);
    return noStore(NextResponse.json(EMPTY));
  }
}
