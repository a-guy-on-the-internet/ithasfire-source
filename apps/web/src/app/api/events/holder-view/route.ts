import { NextResponse, type NextRequest } from "next/server";
import superjson from "superjson";
import { z } from "zod";

import { webEnv } from "@/config/env.server";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import {
  loadUnlockedEventPageData,
  type EventPageData,
} from "@/server/event-page-data";
import { getServerTrpcClient } from "@/server/trpc-client";

/**
 * Ticket holders keep a banned owner's event page (owner ruling,
 * ban-that-sticks 2026-09-29).
 *
 * `/events/[...slug]` is edge-cached and rendered for NOBODY IN PARTICULAR
 * (`public, s-maxage`, no `Cookie` in `Vary`), so an event whose owner is
 * banned is a 404 there for everyone. The 404 page for that route asks this
 * endpoint ONCE, after first paint and only for a signed-in viewer: "may THIS
 * viewer see it?" — and it is safe to ask here for the same three reasons as
 * `../[eventId]/unlocked-view`:
 *
 *  1. It is a POST, which no CDN in this stack caches.
 *  2. EVERY response — including thrown ones — carries
 *     `Cache-Control: private, no-store`; the exported `POST` is the single
 *     exit.
 *  3. It lives under `/api`, outside the `/events/:path*` shared-cache rule.
 *
 * The API decides (`events.getBannedOwnerHolderAccess`): a signed-in viewer
 * holding an ACTIVE ticket, for an event hidden ONLY because its owner is
 * banned. The page payload is then loaded WITH identity
 * (`loadUnlockedEventPageData`), and the API re-checks read access on every
 * one of those reads, so a disagreement degrades to "none", never to a leak.
 *
 * Contract: POST `{ slug }` →
 *   `{ access: "none" }` | `{ access: "holder", data: <superjson EventPageData> }`
 * Every refusal is the same `{ access: "none" }` with status 200: a stranger,
 * an anonymous caller, an unknown slug and an outage look identical.
 */

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({ slug: z.string().trim().min(1).max(255) })
  .strict();

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  return res;
}

/**
 * The holder view never offers purchase: checkout refuses a banned owner's
 * event (`ensureEventOnSale` → EVENT_NOT_ON_SALE). Hides the CTA and
 * flags `holderView` (a neutral "sales are paused" notice that gives no reason),
 * set HERE, server-side, so the client cannot be talked into showing a buy button.
 */
function noSales(data: EventPageData): EventPageData {
  return {
    ...data,
    hideTicketCta: true,
    holderView: true,
    waitlistOpen: false,
  };
}

const NONE = { access: "none" } as const;

async function resolveHolderView(req: NextRequest): Promise<NextResponse> {
  const origin = req.headers.get("origin");
  const siteOrigin = (() => {
    try {
      return new URL(webEnv.siteUrl).origin;
    } catch {
      return null;
    }
  })();
  if (origin && siteOrigin && origin !== siteOrigin) {
    return NextResponse.json(NONE, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(NONE, { status: 400 });
  }

  const access =
    await getServerTrpcClient().events.getBannedOwnerHolderAccess.query({
      slug: parsed.data.slug,
    });
  if (!access) {
    return NextResponse.json(NONE);
  }

  const data = await loadUnlockedEventPageData(
    access.eventId,
    access.currentSlug,
  );
  if (!data) {
    return NextResponse.json(NONE);
  }

  return NextResponse.json({
    access: "holder",
    data: superjson.serialize(noSales(data)),
  });
}

export async function POST(req: NextRequest) {
  try {
    return noStore(await resolveHolderView(req));
  } catch (err) {
    // An API outage, or the page read disagreeing with the access verdict:
    // the 404 stands. Visible in traces, never to the viewer.
    traceIgnoredError("event.holderView.failed")(err);
    return noStore(NextResponse.json(NONE));
  }
}
