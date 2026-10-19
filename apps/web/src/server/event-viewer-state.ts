import "server-only";

import type { SeoLocation } from "@th/types/seo/types";
import type { VisibleArrivalArea } from "@th/core/use-cases/arrival-areas";

import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { loadViewerEventArrivalAreas } from "@/server/arrival-areas";
import {
  loadEventSeo,
  loadViewerDateRsvps,
  resolveEditUrl,
} from "@/server/events";

/**
 * Everything on the event page that depends on WHO IS ASKING.
 *
 * The page itself is edge-cached (`public, s-maxage=120,
 * stale-while-revalidate=300`, no `Cookie` in `Vary`), so none of this may be
 * server-rendered. It is resolved after first paint against
 * `POST /api/events/[eventId]/viewer-state` — uncacheable, `private, no-store`
 * — and merged into the already-painted page by `EventPageBody`.
 *
 * ONE endpoint for all of it, deliberately: the next viewer-scoped field gets
 * an obvious home here instead of quietly reappearing in the cached payload.
 *
 * Every field's default is the SAFE one. {@link EMPTY_EVENT_VIEWER_STATE} is
 * what a stranger, an error, an outage and a parse failure all produce
 * identically: redacted location, no edit affordance, not going.
 */
export type EventViewerState = {
  /**
   * `/admin/<slug>/events/<id>` when this viewer may edit the event, else
   * `null`. Viewer-scoped by construction — it comes from the authed
   * `getEventForEdit` — and it used to ship an "Edit Event" button plus the
   * admin URL to every stranger behind the same colo.
   */
  editHref: string | null;
  /**
   * This viewer holds an active ticket AND the event is OBSCURED. (For an
   * EXACT-mode event the API never runs the lookup, so this stays false — the
   * address was already public.)
   */
  viewerHasTicket: boolean;
  /**
   * The exact location, ONLY once the API has actually revealed it to THIS
   * viewer: OBSCURED + active ticket or live RSVP (arrival-areas Q16) +
   * `addressRevealAt` has passed, or an act on the bill (arrival-areas
   * FR-009). `null` means "keep what the
   * server rendered", which is the obscured form — so every failure path, and
   * every viewer the API did not release it to, leaves the page redacted.
   */
  location: SeoLocation | null;
  /**
   * The viewer's own "I'm going" state for the event (RSVP listings only).
   * `null` = unknown/anonymous, which is what the toggle treats as "no seed".
   */
  viewerRsvped: boolean | null;
  /** Per-date RSVP flags for a RECURRING community listing, keyed by date id. */
  dateRsvps: Record<string, boolean>;
  /**
   * Arrival areas (arrival-areas FR-008, NFR-001) this viewer may see beyond
   * the anonymous list the cached page already carries: a holder after the
   * reveal, an act on the bill (load-in included), the place's managers,
   * a viewer who passed the event's gate. `null` = keep the cached list,
   * which is what every failure and every stranger produces.
   *
   * The `viewer` prefix is load-bearing: `assertNoViewerScopedFields` throws
   * if this key ever reaches the edge-cached `EventPageData`.
   */
  viewerArrivalAreas: VisibleArrivalArea[] | null;
};

/** The fail-closed value. See {@link EventViewerState}. */
export const EMPTY_EVENT_VIEWER_STATE: EventViewerState = {
  editHref: null,
  viewerHasTicket: false,
  location: null,
  viewerRsvped: null,
  dateRsvps: {},
  viewerArrivalAreas: null,
};

/**
 * Resolves the viewer half of the event page for the CURRENT request's
 * identity.
 *
 * Every sub-read is individually fail-closed: a throw degrades that one field
 * to its safe default rather than failing the whole response, because a
 * partial answer here is strictly better than none (the page stays usable and
 * still never over-reveals).
 */
export async function loadEventViewerState(
  eventId: string,
  currentSlug: string,
): Promise<EventViewerState> {
  const [seo, editHref, dateRsvps, viewerArrivalAreas] = await Promise.all([
    loadEventSeo(currentSlug).catch((err) => {
      // A gated event the viewer has NOT satisfied lands here (the API refuses
      // the read). So does an API outage. Both mean "no reveal".
      traceIgnoredError("event.viewerState.seoFailed")(err);
      return null;
    }),
    resolveEditUrl(eventId).catch((err) => {
      traceIgnoredError("event.viewerState.editHrefFailed")(err);
      return null;
    }),
    // Only the per-date flags are read here. The cadence and the truncation
    // flag are event-intrinsic and already rode the cached document, so this
    // loader asks the API to SKIP the Event row behind them — one fewer row
    // read on an uncacheable endpoint, for every viewer of every RSVP page.
    loadViewerDateRsvps(eventId).catch((err) => {
      traceIgnoredError("event.viewerState.datesFailed")(err);
      return {};
    }),
    // Fail-closed inside (null = keep the cached list); the catch is a
    // belt for a throw outside its own try.
    loadViewerEventArrivalAreas(eventId).catch((err) => {
      traceIgnoredError("event.viewerState.arrivalAreasFailed")(err);
      return null;
    }),
  ]);

  const viewerHasTicket = seo?.viewerHasTicket === true;
  // The API already applied BOTH halves of the reveal rule (active ticket AND
  // `now >= addressRevealAt`, fail-closed on a null reveal date —
  // `redactLocation`). `isExact` is that verdict, so keying on it preserves the
  // time gate exactly rather than re-deriving it here where it could drift.
  // `viewerAddressReleased` is the API saying a per-viewer rule released it:
  // a holder, a live RSVP-er (arrival-areas Q16, an RSVP-er counts like a
  // holder; not gated), or an act on the bill (arrival-areas FR-009, which
  // the API applies only while the `arrivalAreas` gate is on). `viewerHasTicket`
  // stays as an arm of its own for an API that predates the flag.
  const releasedToViewer =
    viewerHasTicket || seo?.viewerAddressReleased === true;
  const revealed = releasedToViewer && seo?.location?.isExact === true;

  return {
    editHref,
    viewerHasTicket,
    location: revealed ? (seo?.location ?? null) : null,
    viewerRsvped: seo?.viewerRsvped ?? null,
    dateRsvps,
    viewerArrivalAreas,
  };
}
