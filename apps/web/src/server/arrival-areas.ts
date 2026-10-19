import "server-only";

import {
  listArrivalAreasForViewerOutputSchema,
  type ListArrivalAreasForViewerOutput,
  type VisibleArrivalArea,
} from "@th/core/use-cases/arrival-areas";

import { headers as getRequestHeaders } from "next/headers";

import { hasSessionCookie } from "@/lib/auth/session-cookie";
import {
  eventApplicationGrantCookieName,
  eventInviteGrantCookieName,
  eventUnlockCookieName,
} from "@/lib/event-unlock-cookie";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { getPublicTrpcClient, getServerTrpcClient } from "@/server/trpc-client";

// ─────────────────────────────────────────────────────────────────────────────
// Arrival areas for the public place and event pages (arrival-areas FR-006,
// FR-008, NFR-001, NFR-002). Two reads per page, never mixed:
//
//  · PUBLIC (`loadPublic*`): through `getPublicTrpcClient`, which sends no
//    bearer token and no cookies, so the API resolves an ANONYMOUS context
//    and the answer is a property of the place/event, not of the caller.
//    Kept only when the API also says `cacheablePublic: true`. This is the
//    one answer allowed into the edge-cached HTML/RSC (`/events/*` and
//    `/places/*` are `public, s-maxage=120` with no Cookie in Vary).
//
//  · VIEWER (`loadViewer*`): through `getServerTrpcClient`, which forwards
//    the session (as a bearer token) and the event gate cookies
//    (th_eu_/th_ea_/th_ei_). Called ONLY from the `private, no-store` POST
//    routes the browser hits after hydration. Returns `null` for "nothing to
//    add, keep what the page already shows": the viewer's list equals the
//    anonymous one, or the read failed (fail closed).
//
// Every response is re-parsed against the strict output schema, so only the
// known keys reach the page. NFR-002: nothing here logs a geometry or a
// Directions point; failures are traced with fixed messages, never with the
// payload or a parse error that could quote it.
// ─────────────────────────────────────────────────────────────────────────────

class ArrivalAreasParseError extends Error {
  constructor(label: string) {
    super(`arrival areas response failed to parse (${label})`);
    this.name = "ArrivalAreasParseError";
  }
}

function parse(
  raw: unknown,
  label: string,
): ListArrivalAreasForViewerOutput | null {
  const parsed = listArrivalAreasForViewerOutputSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  traceIgnoredError(label)(new ArrivalAreasParseError(label));
  return null;
}

/** The cache-safe answer: areas only when the API marks them public. */
function publicAreas(
  result: ListArrivalAreasForViewerOutput | null,
): VisibleArrivalArea[] {
  return result?.cacheablePublic === true ? result.areas : [];
}

/**
 * The viewer answer, or `null` to keep the cached render. A viewer's grant
 * only ever ADDS to the anonymous list, so a list that equals the anonymous
 * one (`cacheablePublic`) or is empty (nothing granted, or a fail-closed
 * empty on the API side) changes nothing.
 */
function viewerAreas(
  result: ListArrivalAreasForViewerOutput | null,
): VisibleArrivalArea[] | null {
  if (!result || result.cacheablePublic || result.areas.length === 0) {
    return null;
  }
  return result.areas;
}

/** For the edge-cached place page. Anonymous by construction. */
export async function loadPublicPlaceArrivalAreas(
  placeId: string,
): Promise<VisibleArrivalArea[]> {
  try {
    const raw = await getPublicTrpcClient().arrivalAreas.listForPlace.query({
      placeId,
    });
    return publicAreas(parse(raw, "place.arrivalAreas.public"));
  } catch (err) {
    traceIgnoredError("place.arrivalAreas.public")(err);
    return [];
  }
}

/** For the edge-cached event page. Anonymous by construction. */
export async function loadPublicEventArrivalAreas(
  eventId: string,
): Promise<VisibleArrivalArea[]> {
  try {
    const raw = await getPublicTrpcClient().arrivalAreas.listForEvent.query({
      eventId,
    });
    return publicAreas(parse(raw, "event.arrivalAreas.public"));
  } catch (err) {
    traceIgnoredError("event.arrivalAreas.public")(err);
    return [];
  }
}

/** Per viewer. ONLY for a `private, no-store` response. */
export async function loadViewerPlaceArrivalAreas(
  placeId: string,
): Promise<VisibleArrivalArea[] | null> {
  try {
    const raw = await getServerTrpcClient().arrivalAreas.listForPlace.query({
      placeId,
    });
    return viewerAreas(parse(raw, "place.arrivalAreas.viewer"));
  } catch (err) {
    traceIgnoredError("place.arrivalAreas.viewer")(err);
    return null;
  }
}

/**
 * Whether this request could be anyone the event's areas widen for: a
 * session (holder, act, staff) or one of THIS event's gate grants
 * (`th_eu_` password, `th_ea_` application, `th_ei_` invite; names as in
 * `lib/event-unlock-cookie.ts`). Presence only, a cheap negative filter: the
 * API still verifies every one. A stranger's read could only ever come back
 * as the anonymous list, so it is skipped rather than paid for on every
 * event-page view.
 */
async function requestMayWidenEventAreas(eventId: string): Promise<boolean> {
  let cookie: string | null = null;
  try {
    cookie = (await getRequestHeaders()).get("cookie");
  } catch {
    // Outside a request there is no viewer to widen for.
    return false;
  }
  if (!cookie) return false;
  if (hasSessionCookie(cookie)) return true;
  const grants = new Set([
    eventUnlockCookieName(eventId),
    eventApplicationGrantCookieName(eventId),
    eventInviteGrantCookieName(eventId),
  ]);
  return cookie.split(";").some((pair) => {
    const eq = pair.indexOf("=");
    return grants.has((eq === -1 ? pair : pair.slice(0, eq)).trim());
  });
}

/** Per viewer, gate cookies forwarded. ONLY for a `private, no-store` response. */
export async function loadViewerEventArrivalAreas(
  eventId: string,
): Promise<VisibleArrivalArea[] | null> {
  if (!(await requestMayWidenEventAreas(eventId))) return null;
  try {
    const raw = await getServerTrpcClient().arrivalAreas.listForEvent.query({
      eventId,
    });
    return viewerAreas(parse(raw, "event.arrivalAreas.viewer"));
  } catch (err) {
    traceIgnoredError("event.arrivalAreas.viewer")(err);
    return null;
  }
}
