import "server-only";

import { cache } from "react";

import type { VisibleArrivalArea } from "@th/core/use-cases/arrival-areas";

import { isSuggestEditVisible } from "@/app/events/[...slug]/_components/event-detail.helpers";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import {
  loadEventAudio,
  loadEventBody,
  loadEventFeeRates,
  loadEventHumans,
  loadEventSeo,
  loadEventSeriesDates,
  loadEventTags,
  loadEventTicketTypes,
  loadEventSellability,
  loadPublicEventDates,
  loadPublicEventGate,
  loadPublicEventSeo,
  type CommunityRecurrenceSummary,
  type EventSellability,
  type PublicAudioItem,
  type PublicCommunityDates,
  type PublicCommunityEventDate,
  type PublicEventHuman,
  type PublicEventSeo,
  type PublicEventTag,
  type PublicFeeRates,
  type PublicSeriesDate,
  type PublicTicketType,
} from "@/server/events";
import { getServerTrpcClient } from "@/server/trpc-client";
import { loadPublicEventArrivalAreas } from "@/server/arrival-areas";
import type { EventJsonLdEnrichment } from "@/lib/seo/event-json-ld-enrichment";
import {
  buildEventJsonLdEnrichment,
  type EventJsonLdEnrichmentOptions,
} from "@/server/event-json-ld-enrichment";

/**
 * Keys anywhere in the event page payload that are resolved from WHO IS
 * ASKING. They live in {@link EventViewerState} and are fetched after first
 * paint; none of them may appear in the payload the server renders.
 */
export type ViewerScopedPageField =
  | "editHref"
  | "viewerHasTicket"
  | "viewerRsvped"
  | "viewerAddressReleased"
  | "viewerArrivalAreas";

/**
 * Everything the public event page renders below the gate — and NOTHING that
 * depends on the viewer.
 *
 * `/events/[...slug]` is served `public, s-maxage=120, stale-while-revalidate=300`
 * with a `Vary` carrying no `Cookie`, so this payload is shared verbatim with
 * every visitor behind the same Cloudflare colo for up to seven minutes, and
 * with crawlers. Three things keep viewer identity out of it:
 *
 *  1. TRANSPORT. {@link loadPublicEventPageData} reads the SEO payload through
 *     `getPublicTrpcClient` — no bearer token, no cookies — so the API cannot
 *     resolve a caller at all. This is what redacts an OBSCURED event's
 *     address: `redactLocation` reveals the exact street/postcode/lat-lng to a
 *     ticket holder, and once revealed it CANNOT be re-obscured downstream.
 *  2. TYPE. The `?: never` members below mean an object literal carrying
 *     `editHref`, `viewerHasTicket` or `viewerRsvped` does not typecheck as
 *     this type, and neither does a nested `event` / `communityDates` that
 *     carries them (see `PublicEventSeo`, `PublicCommunityEventDate`).
 *  3. RUNTIME. {@link assertNoViewerScopedFields} walks the finished payload
 *     outside production and throws on any key that looks viewer-scoped, so a
 *     field added under a new name still trips something.
 *
 * Every field must be serializable: `unlocked-view` ships this over the wire
 * with superjson, which is what keeps the `Date`s on `event` / `ticketTypes`
 * from arriving as strings.
 */
export type EventPageData = {
  eventId: string;
  slug: string;
  event: PublicEventSeo;
  bodyContent: unknown | null;
  imageMap: Record<string, string>;
  audioItems: PublicAudioItem[];
  ticketTypes: PublicTicketType[];
  eventHumans: PublicEventHuman[];
  tags: PublicEventTag[];
  feeRates: PublicFeeRates | null;
  seriesDates: PublicSeriesDate[];
  communityDates: PublicCommunityEventDate[];
  /**
   * The rule BEHIND `communityDates`, so the page can state the cadence
   * ("Every Wednesday, 8:00 PM") instead of enumerating every row. `null` when
   * there is no summarisable rule. Event-intrinsic — a cadence describes the
   * listing, never the reader — so it belongs in the cached payload.
   */
  communityRecurrence: CommunityRecurrenceSummary | null;
  /**
   * `communityDates` stops SHORT of the end of the series (more occurrences
   * exist than the ones carried here). Server-computed — the page can see
   * neither the row cap nor the materialisation window, and treating the last
   * row as the end of the schedule is what printed "52 dates through Sep 2027"
   * for a weekly listing with no end date. Event-intrinsic, same as
   * `communityRecurrence`, so it belongs in the cached payload.
   */
  communityDatesTruncated: boolean;
  /**
   * The occurrence the schedule section must LEAD with — the first upcoming one
   * still SCHEDULED, `null` when every upcoming night is called off.
   * `communityDates[0]` is NOT this: a called-off night sorts first like any
   * other, so leading with it advertises a night that is off. Event-intrinsic,
   * so it rides the cached payload.
   */
  communityNextScheduledDateId: string | null;
  /**
   * The listing is driven by a stored recurrence rule. Deliberately not derived
   * from `communityRecurrence` (null for FIXED_DATES and unphrasable rules,
   * which are still series) nor from `communityDates.length` (a drained series
   * has none). It is what keeps a recurring listing off the single event-level
   * RSVP button — the button that otherwise attaches "I'm going" to a night
   * that already happened.
   */
  communityHasRecurrenceRule: boolean;
  hideTicketCta: boolean;
  /**
   * Set ONLY by `POST /api/events/holder-view` (never by the cached loaders):
   * the page is being shown to a ticket holder of an otherwise-hidden event.
   * Purchase is not offered and the sales notices are replaced by a neutral
   * "sales are paused" one that gives no reason.
   */
  holderView?: boolean;
  sellabilityReason: EventSellability["reason"];
  waitlistOpen: boolean;
  waitlistDescription: string | null;
  suggestEditHref: string | null;
  /** `resale` platform gate — fail-CLOSED, so a failed gate read hides it. */
  resaleEnabled: boolean;
  /**
   * Arrival areas ANY anonymous visitor may see (arrival-areas FR-006,
   * NFR-001): read through `getPublicTrpcClient` and kept only when the API
   * marks the answer `cacheablePublic`. Empty for an obscured or hidden
   * place, a gated event, and on any failure. Per-viewer areas arrive in
   * `EventViewerState.viewerArrivalAreas`, never here.
   */
  arrivalAreas: VisibleArrivalArea[];
  /**
   * schema.org JSON-LD additions that need this app's site URL: the
   * organizer (absolute `/orgs/<slug>` url) and, on the public render only,
   * the generated Date Stub as the `image` of a posterless event. Read ONLY
   * by `EventJsonLd`; nothing visible renders from it. Event-intrinsic, so it
   * belongs in the cached payload.
   */
  jsonLdEnrichment: EventJsonLdEnrichment;
} & { [K in ViewerScopedPageField]?: never };

/**
 * Keys that must never appear in {@link EventPageData}, matched by SHAPE
 * rather than by an explicit list, so a viewer-scoped field introduced under a
 * new name (`viewerCanBypass`, `callerIsTicketHolder`, `myRsvp`, …) is caught
 * too. The type-level guard only knows the names it was told about; this is the
 * half that catches the ones nobody thought to add.
 */
const VIEWER_SCOPED_KEY_RE =
  // `hasRsvp` is the moderator-only per-date RSVP presence flag on
  // `community.listEventDates` — not viewer-scoped, MODERATOR-scoped, which
  // is the same reason it must never ride a document strangers share.
  /^(viewer|caller|my)[A-Z_]|^editHref$|^hasRsvp$/;

/**
 * Development/test-only deep scan. Throws rather than logs: the cost of a
 * missed viewer field here is a hidden venue's street address in a document
 * served to strangers, so it should stop a render in dev and fail a test,
 * loudly. Skipped in production — a live page must not 500 over this, and the
 * two guards above already hold there.
 */
export function assertNoViewerScopedFields(
  value: unknown,
  path = "data",
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      assertNoViewerScopedFields(item, `${path}[${i}]`, seen),
    );
    return;
  }
  if (value instanceof Date) return;
  for (const [key, child] of Object.entries(value)) {
    if (VIEWER_SCOPED_KEY_RE.test(key)) {
      throw new Error(
        `viewer-scoped field "${path}.${key}" reached the edge-cached event ` +
          `payload. Move it to EventViewerState (server/event-viewer-state.ts).`,
      );
    }
    assertNoViewerScopedFields(child, `${path}.${key}`, seen);
  }
}

/**
 * Assembles the payload around an already-resolved SEO event.
 *
 * The SEO read is the caller's choice because it is the ONE read whose answer
 * changes with the caller (`location`, and the two scalars this drops):
 * the cacheable page passes an anonymously-resolved payload; the gated
 * `unlocked-view` route passes the viewer-resolved one, because an anonymous
 * read of a gated event is refused by the API outright.
 */
const buildEventPageData = async (
  eventId: string,
  currentSlug: string,
  event: PublicEventSeo,
  jsonLdOptions: EventJsonLdEnrichmentOptions,
): Promise<EventPageData> => {
  const [{ body: bodyContent, imageMap }, gate] = await Promise.all([
    loadEventBody(currentSlug),
    loadPublicEventGate(eventId),
  ]);

  const [
    ticketTypes,
    sellability,
    eventHumans,
    feeRates,
    tags,
    audioItems,
    featureGates,
    seriesDates,
    community,
    arrivalAreas,
  ] = await Promise.all([
    loadEventTicketTypes(eventId),
    loadEventSellability(eventId),
    loadEventHumans(eventId),
    loadEventFeeRates(eventId),
    loadEventTags(eventId),
    loadEventAudio(eventId),
    getServerTrpcClient()
      .features.getFeatureGates.query()
      .catch((err) => {
        traceIgnoredError("event.page.featureGatesFallback")(err);
        return null;
      }),
    loadEventSeriesDates(eventId),
    // Only RSVP (community) listings can be recurring; skip the round-trip for
    // ticketed events (the loader would return an empty payload anyway).
    event.attendanceMode === "RSVP"
      ? loadPublicEventDates(eventId)
      : Promise.resolve({
          dates: [],
          recurrence: null,
          truncated: false,
          nextScheduledEventDateId: null,
          hasRecurrenceRule: false,
        } satisfies PublicCommunityDates),
    // Anonymous on purpose, on BOTH paths: the gated `unlocked-view` payload
    // gets the anonymous answer too (none, for a gated event), and the
    // viewer's own areas come from the viewer-state probe.
    loadPublicEventArrivalAreas(eventId),
  ]);

  // Hide the Buy CTA either when the platform feature gate is off OR the
  // organizer's payout account isn't ready (so users don't click through to
  // a guaranteed-to-fail checkout). RSVP (community) events additionally
  // force-hide it inside EventDetail — they have no ticketed path at all.
  const hideTicketCta =
    featureGates?.buyTickets === false || !sellability.available;

  // "Suggest an edit" is COMMUNITY-listings-only (reversed from FR-006's
  // universality on 2026-07-20; the backend rejects OWNED events too) —
  // and never on drafts, PRIVATE events, or gated events (the submit path
  // rejects those; no dead-end CTAs).
  const suggestEditHref = isSuggestEditVisible({
    status: event.status,
    visibility: event.visibility,
    gateType: gate?.gateType ?? null,
    stewardship: event.stewardship,
  })
    ? `/events/${currentSlug}/suggest`
    : null;

  const data: EventPageData = {
    eventId,
    slug: currentSlug,
    event,
    bodyContent,
    imageMap,
    audioItems,
    ticketTypes,
    eventHumans,
    tags,
    feeRates,
    seriesDates: seriesDates.dates,
    communityDates: community.dates,
    communityRecurrence: community.recurrence,
    communityDatesTruncated: community.truncated,
    communityNextScheduledDateId: community.nextScheduledEventDateId,
    communityHasRecurrenceRule: community.hasRecurrenceRule,
    hideTicketCta,
    sellabilityReason: sellability.reason,
    waitlistOpen: gate?.waitlistOpen ?? false,
    waitlistDescription: gate?.waitlistDescription ?? null,
    suggestEditHref,
    resaleEnabled: featureGates?.resale === true,
    arrivalAreas,
    jsonLdEnrichment: buildEventJsonLdEnrichment(
      event,
      currentSlug,
      jsonLdOptions,
    ),
  };

  if (process.env.NODE_ENV !== "production") {
    assertNoViewerScopedFields(data);
  }
  return data;
};

/**
 * The payload for the EDGE-CACHED render of an ungated event.
 *
 * De-identified at the transport (`loadPublicEventSeo` → `getPublicTrpcClient`),
 * so an OBSCURED venue's exact address is never resolved in the first place —
 * not for a ticket holder, not for the organizer, not for anyone. Returns
 * `null` when the SEO payload can't be resolved (the caller 404s).
 *
 * Do NOT call this for a gated event: the API refuses an anonymous full read.
 */
export const loadPublicEventPageData = cache(
  async (eventId: string, currentSlug: string): Promise<EventPageData | null> => {
    const event = await loadPublicEventSeo(currentSlug);
    if (!event) return null;
    // The public render may name the generated stub: it is already this
    // document's `og:image`.
    return buildEventPageData(eventId, currentSlug, event, {
      generatedImage: true,
    });
  },
);

/**
 * The same payload for a viewer who has satisfied an event's GATE, served from
 * `POST /api/events/[eventId]/unlocked-view` — uncacheable, `private, no-store`.
 *
 * Reads the SEO payload WITH identity, which is both necessary (the API refuses
 * an anonymous read of a gated event) and harmless (nothing here is cached).
 * The viewer-scoped scalars are still dropped, so the client half is fed from
 * exactly one place — `EventViewerState` — on both paths.
 *
 * NOTE the API is the real authorization boundary: `getEventSeo`,
 * `getPublicEventBody`, `listEventTicketTypes` et al sit behind
 * `ensureFullEventReadAccess*`, so calling this as a viewer who has NOT
 * satisfied the gate throws rather than returning a payload. A bug in a
 * caller's gate check degrades to an error, not to a leak.
 */
export const loadUnlockedEventPageData = cache(
  async (eventId: string, currentSlug: string): Promise<EventPageData | null> => {
    const seo = await loadEventSeo(currentSlug);
    if (!seo) return null;
    const {
      viewerHasTicket: _viewerHasTicket,
      viewerRsvped: _viewerRsvped,
      viewerAddressReleased: _viewerAddressReleased,
      ...event
    } = seo;
    // No stub: a gated event's head never names it (see
    // `EventJsonLdEnrichmentOptions`).
    return buildEventPageData(eventId, currentSlug, event, {
      generatedImage: false,
    });
  },
);
