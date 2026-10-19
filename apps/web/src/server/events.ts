import "server-only";

import { cache } from "react";
import type { MetadataRoute } from "next";

import { TRPCClientError } from "@trpc/client";
import * as Sentry from "@sentry/nextjs";
import type {
  GetEventSeoOutput,
  GetPublicEventApplicationFormOutput,
} from "@th/core/use-cases/events";
import { extractPlainText } from "@th/core/use-cases/events/_shared/event-body-sanitizer";
import type { EventBody } from "@th/schema";
import type { AppRouter } from "@th/trpc";
import type { PlatformFeeRateParts } from "@/lib/pricing/fee-rate-label";
import type { TaxLineForLabel } from "@/lib/pricing/tax-rate-label";
import type { EventStatus } from "@th/types";
import type { EventSummary } from "@th/ui";
import { mapEventToSeo } from "@th/types/seo/mapEventToSeo";
import type { SeoEvent, SeoOfferAvailability } from "@th/types/seo/types";
import { serverRuntimeEnv } from "@/config/env";
import { buildCanonicalUrl } from "@/config/site";
import {
  getPublicTrpcClient,
  getServerTrpcClient,
} from "@/server/trpc-client";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import type { CategoryEventsSeed } from "@/app/_components/home/useCategoryBrowse";
import { CATEGORY_PAGE_SIZE } from "@/lib/events/category-page";

type SitemapEntry = MetadataRoute.Sitemap[number];

const toDate = (value: string | null | undefined): Date | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const toRequiredDate = (value: string, field: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for ${field}`);
  }
  return date;
};

const parseAvailability = (
  value: string | null | undefined,
): SeoOfferAvailability | undefined => {
  if (!value) return undefined;
  const candidates: SeoOfferAvailability[] = [
    "in_stock",
    "limited",
    "sold_out",
    "preorder",
  ];
  return candidates.find((candidate) => candidate === value) ?? undefined;
};

const parsePricing = (
  pricing: GetEventSeoOutput["pricing"] | null | undefined,
) => {
  if (!pricing) return undefined;
  const currency = pricing.currency?.trim();
  if (!currency) return undefined;

  const availability = parseAvailability(pricing.availability);
  const validFrom = pricing.validFrom ? toDate(pricing.validFrom) : undefined;

  return {
    currency,
    minPriceCents: pricing.minPriceCents ?? undefined,
    maxPriceCents: pricing.maxPriceCents ?? undefined,
    ...(availability ? { availability } : {}),
    ...(validFrom ? { validFrom } : {}),
  } as const;
};

/**
 * The public event page needs more than the pure SEO payload: the
 * community-managed-event-listings spec branches the ticket section vs the
 * "I'm going" toggle on `attendanceMode`, renders community attribution on
 * `stewardship`, and seeds the RSVP toggle with the viewer's own state
 * (`viewerRsvped` — personal state only, never a public count; FR-004).
 */
export type PublicSeoEvent = SeoEvent & {
  attendanceMode: GetEventSeoOutput["attendanceMode"];
  stewardship: GetEventSeoOutput["stewardship"];
  /** Gates the "Suggest an edit" CTA — suggestions are PUBLIC-only (FR-006). */
  visibility: GetEventSeoOutput["visibility"];
  viewerRsvped?: boolean;
  /**
   * The API released the exact `location` to THIS viewer by a per-viewer rule
   * (a ticket holder past the reveal, an act on the bill). Viewer-scoped.
   */
  viewerAddressReleased?: boolean;
  /**
   * Plain "Presented by {name}" attribution (calm-honest-ux FR-003). Also
   * the source of the JSON-LD organizer, built beside the page payload
   * (`server/event-json-ld-enrichment.ts`) rather than on `organizer` here,
   * so nothing but the JSON-LD changes. Null for ownerless COMMUNITY
   * listings.
   */
  organizerName: string | null;
  /** Internal `/orgs/{slug}` page link, derived from `organizerSlug` — never an external URL. */
  organizerHref: string | null;
  /**
   * Real, absolute self-serve refund deadline (calm-honest-ux FR-004), as an
   * ISO datetime. `null` means the organizer never overrode it — the
   * enforced deadline then defaults to `startsAt` (see
   * `get-refund-eligibility.ts`). NOT an hours-before-event window; display
   * code must compare it against `startsAt`.
   */
  refundCutoffAt: string | null;
  /**
   * Venue-confirmation spec (docs/specs/2026-08-27): the venue stamped this
   * event at its place. Lifted off `payload.location.venueConfirmed` because
   * `mapEventToSeo` copies `SeoLocation` field-by-field and does not carry
   * it. Display-only: the server nulls `location.placeSlug` when this is
   * false, and `location.name` too EXCEPT for an unconfirmed community
   * listing it may name as plain text (owner ruling 2026-10-06). So a name
   * can be present while this is false; it carries no endorsement and no
   * link. This flag only adds the mark.
   * Always false for an event with no place.
   */
  venueConfirmed: boolean;
  /**
   * Pixel size of `images[0]` (the poster), read from the file at upload.
   * The poster `<img>` carries it as `width`/`height` so the browser reserves
   * the box before the bytes arrive. Null when unknown (older uploads before
   * the backfill, an unreadable header); the poster then renders as before.
   */
  heroImageSize?: { width: number; height: number } | null;
};

const mapSeoPayload = (payload: GetEventSeoOutput): PublicSeoEvent => {
  // A slugless event is a 500 waiting to happen: `mapEventToSeo` throws
  // `TypeError("event.slug is required")` on a null slug, and `fetchEventSeo`
  // below only catches NOT_FOUND, so the TypeError escaped as a 500 on the
  // public page of every never-published draft. Drafts are slugged at create
  // now, but that assignment is BEST-EFFORT (an event with no resolvable
  // country code still has no slug), so this class of failure has to be closed
  // here too rather than assumed away upstream.
  //
  // The id is the right fallback: `events.resolveBySlug` accepts a UUID as a
  // stable identifier precisely so a slugless event is still reachable. A UUID
  // canonical on a page that is `noindex` (draft) costs nothing. The fallback
  // lives at THIS call site on purpose — `mapEventToSeo`'s own contract
  // ("a slug is required") stays strict, since a PUBLISHED event with no slug
  // really is a bug worth surfacing to its other callers.
  const publicSlug = payload.slug ?? payload.id;
  const canonicalUrl = buildCanonicalUrl(`/events/${publicSlug}`);

  const mapped = mapEventToSeo({
    canonicalUrl,
    event: {
      id: payload.id,
      slug: publicSlug,
      title: payload.title,
      description: payload.description ?? null,
      startsAt: toRequiredDate(payload.startsAt, "startsAt"),
      endsAt: payload.endsAt ? toRequiredDate(payload.endsAt, "endsAt") : null,
      status: payload.status as EventStatus,
      updatedAt: payload.updatedAt
        ? (toDate(payload.updatedAt) ?? undefined)
        : undefined,
      // ISO string on the wire; the JSON-LD free Offer's `validFrom` fallback.
      publishedAt: toDate(payload.publishedAt) ?? null,
      // schema.org Event @type (data-driven per category); the JSON-LD builder
      // validates it against the allowlist and falls back to "Event".
      seoType: payload.seoType ?? null,
    },
    ticketingUrl: payload.ticketingUrl ?? null,
    images: payload.images ?? [],
    location: payload.location ?? undefined,
    organizer: payload.organizer ?? undefined,
    pricing: parsePricing(payload.pricing),
    performers: (payload.performers ?? []).map((p) => ({
      eventHumanId: p.eventHumanId,
      name: p.name,
      role: p.role,
      url: p.url ?? undefined,
    })),
  });

  return {
    ...mapped,
    addressRevealAt: payload.addressRevealAt
      ? (toDate(payload.addressRevealAt) ?? null)
      : null,
    timezone: payload.timezone ?? null,
    categoryName: payload.categoryName ?? null,
    viewerHasTicket: payload.viewerHasTicket ?? false,
    // Default to the pre-community behavior when the API predates the enums.
    attendanceMode: payload.attendanceMode ?? "TICKETED",
    stewardship: payload.stewardship ?? "OWNED",
    visibility: payload.visibility ?? "PUBLIC",
    organizerName: payload.organizerName ?? null,
    organizerHref: payload.organizerSlug
      ? `/orgs/${payload.organizerSlug}`
      : null,
    refundCutoffAt: payload.refundCutoffAt ?? null,
    venueConfirmed: payload.location?.venueConfirmed === true,
    heroImageSize: payload.heroImageSize ?? null,
    ...(payload.viewerRsvped !== undefined
      ? { viewerRsvped: payload.viewerRsvped }
      : {}),
    ...(payload.viewerAddressReleased !== undefined
      ? { viewerAddressReleased: payload.viewerAddressReleased }
      : {}),
  };
};

const isNotFoundError = (
  error: unknown,
): error is TRPCClientError<AppRouter> => {
  if (!(error instanceof TRPCClientError)) {
    return false;
  }
  const code =
    typeof error.data === "object" &&
    error.data !== null &&
    "code" in error.data
      ? (error.data as { code?: string }).code
      : undefined;
  return code === "NOT_FOUND";
};

const SMOKE_SITEMAP_FIXTURES = [
  {
    slug: "brooklyn-block-party-night",
    lastModified: "2024-10-05T18:30:00.000Z",
  },
  {
    slug: "hollywood-bowl-summer-series",
    lastModified: "2024-08-12T03:15:00.000Z",
  },
  {
    slug: "techstars-demo-day-nyc",
    lastModified: "2024-09-22T16:00:00.000Z",
  },
] as const;

const getSmokeSitemapEntries = (): SitemapEntry[] =>
  SMOKE_SITEMAP_FIXTURES.map(({ slug, lastModified }) => ({
    url: buildCanonicalUrl(`/events/${slug}`),
    lastModified: toDate(lastModified),
  }));

const SMOKE_EVENT_SUMMARIES: EventSummary[] = [
  {
    id: "evt-smoke-001",
    title: "Brooklyn Block Party Night",
    date: "Sat • Jul 12 • 6:00 PM",
    venue: "Franklin + Classon Lot — Brooklyn, NY",
    priceLabel: "From $45",
    media: {
      url: "https://images.unsplash.com/photo-1492684223066-81342ee5ff30",
      alt: "Crowd dancing at sunset",
    },
    badge: {
      text: "Hot",
      tone: "hot",
    },
  },
  {
    id: "evt-smoke-002",
    title: "Hollywood Bowl Summer Series",
    date: "Sun • Aug 18 • 8:00 PM",
    venue: "Hollywood Bowl — Los Angeles, CA",
    priceLabel: "From $72",
    media: {
      url: "https://images.unsplash.com/photo-1489515217757-5fd1be406fef",
      alt: "Open air amphitheater",
    },
    badge: {
      text: "Featured",
      tone: "promo",
    },
  },
  {
    id: "evt-smoke-003",
    title: "Techstars Demo Day NYC",
    date: "Thu • Sep 26 • 4:00 PM",
    venue: "Industry City Stage D — Brooklyn, NY",
    priceLabel: "Request invite",
    media: {
      url: "https://images.unsplash.com/photo-1531058020387-3be344556be6",
      alt: "Panel talk on stage",
    },
    badge: {
      text: "Limited",
      tone: "cold",
    },
  },
];

export const getSmokeEventSummaries = (): EventSummary[] =>
  SMOKE_EVENT_SUMMARIES;

const fetchEventSeo = async (
  slug: string,
  client: ReturnType<typeof getServerTrpcClient> = getServerTrpcClient(),
): Promise<PublicSeoEvent | null> => {
  try {
    const payload = await client.events.getEventSeo.query({ slug });
    return mapSeoPayload(payload);
  } catch (err) {
    if (isNotFoundError(err)) {
      return null;
    }
    throw err;
  }
};

export type EventSlugResolution = {
  eventId: string;
  currentSlug: string;
  redirect: boolean;
};

async function querySlugResolution(
  client: ReturnType<typeof getServerTrpcClient>,
  slug: string,
): Promise<EventSlugResolution | null> {
  try {
    return await client.events.resolveEventBySlug.query({ slug });
  } catch (err) {
    if (isNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Resolves a slug AS THE VIEWER. A history slug (or an event id) of an event
 * that is not publicly readable — a DRAFT, or cancelled / archived without
 * ever going live — resolves only for a viewer who can edit it; everyone else
 * gets `null`, same as an unknown slug (N3, `resolveEventBySlug`).
 *
 * Viewer-scoped, so NOT for an edge-cached render: `/events/[...slug]` is
 * served `public, s-maxage` with no `Cookie` in its `Vary`, and a 308 issued
 * there for an editor would be stored at the colo and hand the draft's new
 * slug to everyone behind it. Those renders use {@link resolvePublicEventSlug}.
 */
export const resolveEventSlug = cache(
  async (slug: string): Promise<EventSlugResolution | null> =>
    querySlugResolution(getServerTrpcClient(), slug),
);

/**
 * {@link resolveEventSlug} for NOBODY IN PARTICULAR: asked on the
 * de-identified client, so a redirect answer depends on the event alone
 * (publicly readable or not), never on who is looking. The one to use in any
 * document that lands in the edge cache.
 */
export const resolvePublicEventSlug = cache(
  async (slug: string): Promise<EventSlugResolution | null> =>
    querySlugResolution(getPublicTrpcClient(), slug),
);

/**
 * The CURRENT slug a `/e/<shortId>` short link points at, or `null` for every
 * "no" (not a short ID, unknown, or an event the public may not read — a
 * DRAFT among them; see `resolveEventShortLink`). Asked on the de-identified
 * client, like {@link resolvePublicEventSlug}: the answer never depends on
 * who is looking.
 */
export const resolvePublicEventShortLink = cache(
  async (shortId: string): Promise<{ currentSlug: string } | null> => {
    try {
      return await getPublicTrpcClient().events.resolveEventShortLink.query({
        shortId,
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Gate State & Preview (for password-protected events)
// ─────────────────────────────────────────────────────────────────────────────

export type EventGateState = {
  eventId: string;
  gateType: "NONE" | "PASSWORD" | "APPLICATION";
  passwordRequired: boolean;
  applicationRequired: boolean;
  viewerCanBypass: boolean;
  viewerIsUnlocked: boolean;
  /**
   * The viewer's `th_ea_<eventId>` application grant (forwarded by this
   * identity client) is what lets them through — the API verified it AND
   * found its submission still APPROVED. Already folded into
   * `applicationRequired`; the checkout uses it to sync a durable unlock.
   */
  viewerHasApplicationGrant: boolean;
  /**
   * The viewer's `th_ei_<eventId>` invite grant (forwarded by this identity
   * client) is what lets them through, on either gate type — the API
   * verified it AND re-checked the invite (not revoked, event live and not
   * over). Already folded into `passwordRequired` / `applicationRequired`;
   * the checkout uses it to sync a durable unlock.
   */
  viewerHasInviteGrant: boolean;
  /**
   * The gate is shut for this viewer and what used to let them in (their own
   * forwarded `th_ei_<eventId>` grant, or their own revoked unlock) was ended
   * by the organiser's "Reset and remove everyone". Lets the gate say why.
   * Viewer-scoped: never put it on the cached document.
   */
  viewerRemovedByInviteReset: boolean;
  waitlistOpen: boolean;
  waitlistDescription: string | null;
};

/**
 * Whether THIS VIEWER should be shown the gate wall for this event.
 *
 * Viewer-scoped by construction — do NOT call it from anything that reaches an
 * edge-cached render. `/events/[...slug]` is served
 * `public, s-maxage=120, stale-while-revalidate=300` with a `Vary` carrying no
 * `Cookie`. Branching a cached document on this stores ONE viewer's answer at a
 * colo and serves it to everyone behind it. The cached surfaces ask
 * {@link isEventGateActive} instead; this one runs only where the response is
 * uncacheable — `POST /api/events/[eventId]/unlocked-view` and the (no longer
 * edge-cached) checkout page.
 *
 * Locks ONLY when a real, unsatisfied gate exists. `passwordRequired` and
 * `applicationRequired` already fold in `viewerCanBypass`/`viewerIsUnlocked`
 * (see `getEventGateState`), so an ungated (`gateType: "NONE"`) event is NEVER
 * locked here.
 *
 * ── What `cookieUnlocked` actually means ─────────────────────────────────────
 *
 * It is "the caller verified the signed `th_eu_<eventId>` cookie", and BOTH
 * callers only look for that cookie when `gateType === "PASSWORD"`:
 *
 *   - `app/api/events/[eventId]/unlocked-view/route.ts`
 *   - `app/events/checkout/[...slug]/page.tsx`
 *
 * That is deliberate and must stay in step with the API, which enforces the
 * same PASSWORD-only condition on every full event read
 * (`packages/transport/trpc/src/event-read-access.ts`, the
 * `gateType === "PASSWORD" && verifyEventUnlockCookie(...)` clause). Widening
 * the web-side check alone would render a page whose every loader the API then
 * 403s — a slower wall plus a Sentry event per view.
 *
 * APPLICATION gates do not use `cookieUnlocked` at all. An approved guest
 * holds the separate `th_ea_<eventId>` grant set by
 * `app/api/events/[eventId]/claim/route.ts`; the SSR client forwards it, and
 * the API folds it into `applicationRequired` only while the submission it
 * names is still APPROVED for this event (so rescind / withdraw revoke it on
 * the next request). The web never verifies that grant itself — it cannot see
 * the submission — so do not widen the PASSWORD guard to "help" it: a
 * `th_eu_` cookie must never open an APPLICATION gate, nor a grant a PASSWORD
 * one.
 *
 * Invite links are the one proof that opens EITHER gate: the `th_ei_<eventId>`
 * grant set by `app/api/events/[eventId]/invite/route.ts`. Like `th_ea_` it is
 * forwarded, judged by the API (`viewerHasInviteGrant`) and already folded
 * into both `passwordRequired` and `applicationRequired`; it never feeds
 * `cookieUnlocked`.
 *
 * (The humanId path has no such restriction: `EventUnlock.isUnlocked` ignores
 * `source`, so a signed-in viewer's grant is genuinely gate-agnostic. Switching
 * gateType does not evict an existing grant — rescind / token rotation is the
 * eviction path.)
 */
export function isLockedByEventGate(
  gateState: EventGateState | null,
  cookieUnlocked: boolean,
): boolean {
  return Boolean(
    gateState &&
      (gateState.passwordRequired || gateState.applicationRequired) &&
      !cookieUnlocked,
  );
}

export const fetchEventGateState = cache(
  async (eventId: string): Promise<EventGateState | null> => {
    const client = getServerTrpcClient();
    try {
      const result = await client.events.getGateState.query({ eventId });
      return {
        eventId: result.eventId,
        gateType: result.gateType as EventGateState["gateType"],
        passwordRequired: result.passwordRequired,
        applicationRequired: result.applicationRequired,
        viewerCanBypass: result.viewerCanBypass,
        viewerIsUnlocked: result.viewerIsUnlocked,
        viewerHasApplicationGrant: result.viewerHasApplicationGrant,
        viewerHasInviteGrant: result.viewerHasInviteGrant,
        viewerRemovedByInviteReset: result.viewerRemovedByInviteReset,
        waitlistOpen: result.waitlistOpen,
        waitlistDescription: result.waitlistDescription ?? null,
      };
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
);

/**
 * The gate facts that are safe to render into an EDGE-CACHED document: every
 * field here is a property of the EVENT, not of the viewer.
 *
 * `EventGateState` above carries `viewerCanBypass` / `viewerIsUnlocked` — and
 * `passwordRequired` / `applicationRequired`, which fold those two in. Any SSR
 * branch on those varies the response by identity, and `/events/[...slug]` is
 * served `public, s-maxage=120` with a `Vary` that has no `Cookie` in it, so
 * one viewer's document is handed to everyone else behind that colo. This type
 * exists so the public event page CANNOT reach those fields by construction.
 */
export type PublicEventGate = {
  eventId: string;
  gateType: "NONE" | "PASSWORD" | "APPLICATION";
  waitlistOpen: boolean;
  waitlistDescription: string | null;
};

/**
 * Whether this EVENT is gated at all — the only gate question the cached
 * document is allowed to ask. Whether THIS viewer may pass the gate is decided
 * after first paint by the client (see `GatedEventShell`), against an
 * uncacheable same-origin POST.
 *
 * Deliberately `gateType !== "NONE"` rather than the `passwordRequired` /
 * `applicationRequired` pair: those already have the viewer folded in. It also
 * matches the API's own read gate verbatim — `ensureFullEventReadAccessByEventId`
 * (packages/transport/trpc/src/event-read-access.ts) opens only on
 * `gateType === "NONE"` plus per-viewer grants — so an event whose gateType is
 * PASSWORD but whose password was cleared stays walled here instead of
 * rendering a page whose every data fetch the API would 403.
 */
export function isEventGateActive(
  gate: PublicEventGate | null,
): gate is ActiveEventGate {
  return gate !== null && gate.gateType !== "NONE";
}

/** A {@link PublicEventGate} narrowed to the two gates that actually wall a page. */
export type ActiveEventGate = PublicEventGate & {
  gateType: "PASSWORD" | "APPLICATION";
};

/**
 * Event-intrinsic gate facts for the public event page.
 *
 * Wraps the `cache()`d {@link fetchEventGateState} (so a render that needs both
 * still makes one HTTP call) and DROPS every viewer-scoped field before it can
 * reach a component. Do not widen the return type — see {@link PublicEventGate}.
 */
export const loadPublicEventGate = cache(
  async (eventId: string): Promise<PublicEventGate | null> => {
    const state = await fetchEventGateState(eventId);
    if (!state) return null;
    return {
      eventId: state.eventId,
      gateType: state.gateType,
      waitlistOpen: state.waitlistOpen,
      waitlistDescription: state.waitlistDescription,
    };
  },
);

export type EventGatedPreview = {
  eventId: string;
  slug: string;
  title: string;
  heroImageUrl: string | null;
  /**
   * The date the gate shows, the event's local day as `YYYY-MM-DD` (the next
   * SCHEDULED occurrence for a recurring listing; `null` when it has none).
   * Never a place, so never the zone either — a gate says WHEN, not WHERE.
   * Event-intrinsic, so safe on the edge-cached gated document.
   */
  gateDate: string | null;
};

export const fetchEventGatedPreview = cache(
  async (eventId: string): Promise<EventGatedPreview | null> => {
    const client = getServerTrpcClient();
    try {
      return await client.events.getGatedPreview.query({ eventId });
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
);

/**
 * The PUBLIC application form of an APPLICATION-gated event, as it rides the
 * gated page's server HTML.
 *
 * The form definition is what the gate shows first, so fetched in the browser
 * alone it arrived after hydration and grew the gate from its loading line to
 * the first question (0.30 CLS at 320px). Sent in the HTML, the real form is
 * the first paint.
 *
 * Dates travel as ISO strings and are revived by the client wrapper, so the
 * shape crossing the RSC boundary is plain JSON whatever Flight does with a
 * `Date`. `fetchedAt` is when this server read it: the wrapper seeds React
 * Query with it (`initialDataUpdatedAt`, so a seed older than the app's
 * staleTime is refetched on mount) and computes the application window from
 * it on the hydrating render, so the server HTML and that render agree.
 */
export type PublicApplicationFormSeed = {
  form: Omit<GetPublicEventApplicationFormOutput, "opensAt" | "closesAt"> & {
    opensAt: string | null;
    closesAt: string | null;
  };
  fetchedAt: string;
};

/** The tRPC error code and the domain `appCode` off a client error, if any. */
const trpcClientErrorData = (
  err: unknown,
): { code?: string; appCode?: string } => {
  if (!(err instanceof TRPCClientError)) return {};
  const data: unknown = err.data;
  if (typeof data !== "object" || data === null) return {};
  const { code, appCode } = data as { code?: unknown; appCode?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof appCode === "string" ? { appCode } : {}),
  };
};

/**
 * Reads {@link PublicApplicationFormSeed} for the gated page.
 *
 * `getPublicTrpcClient`, never the identity client: the gated document is
 * edge-cached with no `Vary: Cookie` (page.tsx). `getPublicApplicationForm`
 * takes no actor and returns event-level data any visitor already gets, which
 * is the only reason it may enter that document.
 *
 * Every failure degrades to `null` and the wrapper fetches the form after
 * paint, as before: a rate-limited (per visitor IP) or failed read must never
 * break the gated page. That swallow is REPORTED (same shape as
 * `prefetchHomeDiscovery`), or a read failing on every render would look like
 * a page that works and is just a little jumpier. Two answers are shaped:
 *
 * - The use case's own `EVENT_NOT_FOUND` (`data.appCode`) is expected and not
 *   reported. It is one collapsed answer for every ineligible event: missing,
 *   a banned owner, not PUBLISHED (the common case here: a past or cancelled
 *   gated event still renders the gate), a gate other than APPLICATION, or no
 *   attendee form yet (`get-public-event-application-form.ts`). Any OTHER
 *   `NOT_FOUND` is reported: tRPC's "No procedure found on path" carries the
 *   same code with no `appCode`, and swallowing it would hide web/API version
 *   skew.
 * - `TOO_MANY_REQUESTS` is reported at `warning` under one fingerprint. A
 *   per-visitor 429 is the limiter working; what must stay visible is the
 *   case where every render shares one bucket (the visitor IP is not being
 *   forwarded), and one quiet issue whose count climbs shows that without a
 *   crawl filing an event per render.
 */
export const fetchPublicApplicationFormSeed = cache(
  async (eventId: string): Promise<PublicApplicationFormSeed | null> => {
    try {
      const form =
        await getPublicTrpcClient().events.getPublicApplicationForm.query({
          eventId,
        });
      return {
        form: {
          ...form,
          opensAt: form.opensAt ? form.opensAt.toISOString() : null,
          closesAt: form.closesAt ? form.closesAt.toISOString() : null,
        },
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      const data = trpcClientErrorData(err);
      if (data.code === "NOT_FOUND" && data.appCode === "EVENT_NOT_FOUND") {
        return null;
      }
      console.warn(
        "[fetchPublicApplicationFormSeed] failed; the gate fetches the form after paint",
        { eventId, err },
      );
      try {
        Sentry.captureException(err, {
          tags: { area: "event-gate-ssr", section: "applicationForm" },
          extra: { eventId },
          ...(data.code === "TOO_MANY_REQUESTS"
            ? {
                level: "warning" as const,
                fingerprint: [
                  "event-gate-ssr",
                  "applicationForm",
                  "TOO_MANY_REQUESTS",
                ],
              }
            : {}),
        });
      } catch {
        // Reporting is best-effort; the seed still degrades to null.
      }
      return null;
    }
  },
);

const fetchSitemapEntries = async (): Promise<SitemapEntry[]> => {
  const client = getServerTrpcClient();

  try {
    const payload = await client.events.listEventSitemapEntries.query({});
    return payload.map((item) => ({
      url: buildCanonicalUrl(`/events/${item.slug}`),
      lastModified: item.updatedAt ? toDate(item.updatedAt) : undefined,
    }));
  } catch (err) {
    if (isNotFoundError(err)) {
      return [];
    }
    throw err;
  }
};

const isIndexableEvent = (event: SeoEvent): boolean =>
  event.status === "PUBLISHED";

// Meta descriptions and JSON-LD `description` read best around ~155–160 chars;
// Google truncates well past that. We trim on a word boundary and append an
// ellipsis so an excerpt never ends mid-word.
const DESCRIPTION_EXCERPT_MAX_CHARS = 160;

const truncateAtWordBoundary = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${base.trimEnd()}…`;
};

/**
 * Community listings (and other body-only events) keep their copy in the prose
 * `content` body, so the SEO payload's `description` is null and metadata/JSON-LD
 * fall back to `name · <ISO date>`. Derive a plaintext excerpt from the body so
 * those pages carry a real, indexable description.
 *
 * Reuses the canonical server-side body walker (`extractPlainText`) rather than
 * hand-rolling prose stripping. Null-safe: no body / empty text → null so the
 * existing fallback stands.
 */
const deriveBodyExcerpt = async (slug: string): Promise<string | null> => {
  const { body } = await loadEventBody(slug);
  if (!body) return null;
  const text = extractPlainText(body as EventBody);
  if (!text) return null;
  return truncateAtWordBoundary(text, DESCRIPTION_EXCERPT_MAX_CHARS);
};

export const loadEventSeo = cache(
  async (slug: string): Promise<PublicSeoEvent | null> => {
    const resolution = await resolveEventSlug(slug);
    if (!resolution) return null;
    const seo = await fetchEventSeo(resolution.currentSlug);
    // When the structured SEO payload carries no description, fall back to a
    // plaintext excerpt of the event body (community/body-only listings).
    if (seo && !seo.description) {
      const excerpt = await deriveBodyExcerpt(resolution.currentSlug);
      if (excerpt) {
        return { ...seo, description: excerpt };
      }
    }
    return seo;
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// The de-identified SEO payload (for EDGE-CACHED renders)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fields of {@link PublicSeoEvent} that the API resolves from WHO IS
 * ASKING rather than from the event.
 *
 * `/events/[...slug]` is served `public, s-maxage=120, stale-while-revalidate=300`
 * with a `Vary` that carries no `Cookie`, so any one of these in a rendered
 * document is one viewer's answer stored at a colo and served to everyone
 * behind it for up to seven minutes.
 */
export type ViewerScopedSeoField =
  | "viewerHasTicket"
  | "viewerRsvped"
  | "viewerAddressReleased";

/**
 * A {@link PublicSeoEvent} with every viewer-scoped field removed — and made
 * UNSETTABLE, not merely absent: the optional `never` members mean an object
 * literal that carries `viewerHasTicket` or `viewerRsvped` will not typecheck
 * as this type. Same shape of guarantee as {@link PublicEventGate}.
 *
 * `location` is not in that list and cannot be: it is a single object whose
 * CONTENTS the API redacts per viewer (`redactLocation`). There is no way to
 * turn a revealed address back into its obscured form on this side — the
 * obfuscation inputs never cross the wire — so the only safe construction is to
 * never ask with an identity. {@link loadPublicEventSeo} does exactly that.
 */
export type PublicEventSeo = Omit<PublicSeoEvent, ViewerScopedSeoField> & {
  [K in ViewerScopedSeoField]?: never;
};

/** Drops the viewer-scoped members at the boundary. See {@link PublicEventSeo}. */
const toPublicEventSeo = (seo: PublicSeoEvent): PublicEventSeo => {
  const {
    viewerHasTicket: _viewerHasTicket,
    viewerRsvped: _viewerRsvped,
    viewerAddressReleased: _viewerAddressReleased,
    ...rest
  } = seo;
  return rest;
};

/**
 * The event's SEO payload as resolved for NOBODY IN PARTICULAR.
 *
 * Two independent mechanisms, because one is not enough:
 *
 *  1. The query runs on {@link getPublicTrpcClient}, which sends no bearer
 *     token and no cookies. `get-event-seo` therefore has no `viewerHumanId`,
 *     so `callerIsTicketHolder` is false and an OBSCURED event's `location`
 *     comes back obscured — for every caller, including a ticket holder. This
 *     is the part that MATTERS: redaction cannot be reapplied downstream.
 *  2. The two scalar viewer fields are dropped at this boundary and the return
 *     type forbids them.
 *
 * Not a drop-in for {@link loadEventSeo}: an anonymous read of a GATED event is
 * refused by the API (`ensureFullEventReadAccess*`). Only the ungated page and
 * `generateMetadata` use this.
 */
export const loadPublicEventSeo = cache(
  async (slug: string): Promise<PublicEventSeo | null> => {
    const resolution = await resolvePublicEventSlug(slug);
    if (!resolution) return null;
    const seo = await fetchEventSeo(
      resolution.currentSlug,
      getPublicTrpcClient(),
    );
    if (!seo) return null;
    if (!seo.description) {
      const excerpt = await deriveBodyExcerpt(resolution.currentSlug);
      if (excerpt) {
        return toPublicEventSeo({ ...seo, description: excerpt });
      }
    }
    return toPublicEventSeo(seo);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Event Body Content (for the public page renderer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the structured body content for a published event.
 * Returns the raw `EventBody` JSON or null when the event has no body yet.
 */
export type LoadEventBodyResult = {
  body: unknown | null;
  imageMap: Record<string, string>;
};

export const loadEventBody = cache(
  async (slug: string): Promise<LoadEventBodyResult> => {
    const client = getServerTrpcClient();
    try {
      const payload = await client.events.getPublicEventBody.query({ slug });
      return {
        body: payload.body ?? null,
        imageMap:
          (payload as { imageMap?: Record<string, string> }).imageMap ?? {},
      };
    } catch (err) {
      if (isNotFoundError(err)) {
        return { body: null, imageMap: {} };
      }
      // In dev, missing body is expected and not worth logging.
      if (process.env.NODE_ENV !== "production") {
        return { body: null, imageMap: {} };
      }
      throw err;
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Event Audio (for the public page custom player)
// ─────────────────────────────────────────────────────────────────────────────

export type PublicAudioItem = {
  id: string;
  hlsPlaylistUrl: string | null;
  // Raw source URL. The public renderer prefers it over the playlist: it is
  // one direct file, downloadable, and needs no hls.js. An HLS-only item
  // (sourceUrl null) still plays: attachAudioSource uses hls.js where the
  // browser has no native HLS.
  sourceUrl: string | null;
  status: string;
  waveformPeaks: number[] | null;
};

export const loadEventAudio = cache(
  async (eventId: string): Promise<PublicAudioItem[]> => {
    const client = getServerTrpcClient();
    try {
      const payload = await client.events.resolveAudio.query({ eventId });
      return payload.items.map((item) => ({
        id: item.id,
        hlsPlaylistUrl: item.hlsPlaylistUrl,
        sourceUrl: (item as { sourceUrl?: string | null }).sourceUrl ?? null,
        status: item.status,
        waveformPeaks: (item as any).waveformPeaks ?? null,
      }));
    } catch (err) {
      // Degrades to an empty audio map. `resolveAudioNode` then falls back to
      // whatever URLs the editor baked into the saved doc, which may be
      // expired presigned links (a dead player), and a block with none
      // renders as the placeholder. Either way buyers may get no audio, so a
      // failure here must reach Sentry (console.error alone does not). Same
      // shape as `fetchPublicApplicationFormSeed` above.
      console.error("[loadEventAudio] failed for eventId:", eventId, err);
      const data = trpcClientErrorData(err);
      // The use case's own access answers (it carries a domain `appCode`).
      // Today the read gate returns `{ items: [] }` instead of throwing; this
      // keeps a future throwing gate quiet. A bare NOT_FOUND with no appCode
      // is tRPC's missing procedure (web/API version skew) and IS reported.
      const expectedGateAnswer =
        (data.code === "NOT_FOUND" || data.code === "FORBIDDEN") &&
        data.appCode !== undefined;
      if (!expectedGateAnswer) {
        try {
          Sentry.captureException(err, {
            tags: { area: "event-page-ssr", section: "audio" },
            extra: { eventId },
            ...(data.code === "TOO_MANY_REQUESTS"
              ? {
                  level: "warning" as const,
                  fingerprint: ["event-page-ssr", "audio", "TOO_MANY_REQUESTS"],
                }
              : {}),
          });
        } catch {
          // Reporting is best-effort; the page still renders without audio.
        }
      }
      return [];
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Event Tags (for the public event detail page)
// ─────────────────────────────────────────────────────────────────────────────

export type PublicEventTag = {
  id: string;
  slug: string;
  name: string;
};

export const loadEventTags = cache(
  async (eventId: string): Promise<PublicEventTag[]> => {
    const client = getServerTrpcClient();
    try {
      const payload = await client.tags.getEventTags.query({ eventId });
      return payload.tags;
    } catch (err) {
      traceIgnoredError("server.events.loadTagsFallback")(err);
      // Graceful fallback — tags are supplementary info
      return [];
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Ticket Types (for the public event detail page)
// ─────────────────────────────────────────────────────────────────────────────

export type PublicTicketType = {
  id: string;
  name: string;
  /** EFFECTIVE online price at request time (core resolves the flip, FR-004). */
  priceCents: number;
  /**
   * Pay-what-you-want tier (`ADJUSTABLE`): `priceCents` is then always 0 and
   * the row is quoted "From" its minimum (or its suggestion when there is no
   * minimum) — never "Free". Straight off `listEventTicketTypes`, which has
   * always sent these; optional so a story fixture may omit them.
   */
  pricingMode?: "FIXED" | "ADJUSTABLE";
  minimumCents?: number | null;
  suggestedCents?: number | null;
  /**
   * The AUTHORED capacity column — the tier's configured size, NOT its
   * availability: no write path decrements it. Deriving "sold out" from it is
   * what made this page advertise tiers checkout would refuse.
   */
  capacity: number;
  /**
   * TRUE availability: `capacity - issued - held`, resolved server-side on the
   * same basis the pre-charge gate refuses on.
   */
  remainingCapacity: number;
  /** The server's sold-out verdict (`remainingCapacity <= 0`). */
  soldOut?: boolean;
  /**
   * PER-TIER availability (FR-010) — the COMPLETE answer for this row: core
   * already folded the event-wide verdict in, so this does NOT need ANDing with
   * `EventSellability` below. Optional so a cached payload from before FR-010
   * still type-checks and renders exactly as today.
   */
  sellability?: PublicTicketTypeSellability;
  /**
   * Pending scheduled price change (Q-002), for "$12 until Fri, Oct 3" copy.
   * Already null once the flip has passed — never re-derive it from the
   * browser's clock.
   */
  upcomingPriceChange?: { toPriceCents: number; at: Date } | null;
};

export type PublicTicketTypeSellability = {
  available: boolean;
  reason:
    | "ok"
    | "free"
    | "no_payee"
    | "stripe_not_connected"
    | "sales_closed"
    | "not_yet_on_sale"
    | "sales_ended";
  /** Non-null only for `not_yet_on_sale`. */
  opensAt: Date | null;
  /** Non-null only for `sales_ended`. */
  closedAt: Date | null;
};

/**
 * EVENT-WIDE sellability. Retained verbatim through FR-010's per-type move —
 * same five reasons, same semantics — because these are genuinely event-wide
 * facts and three surfaces already switch on them. Per-TIER state lives on
 * {@link PublicTicketType.sellability}.
 */
export type EventSellability = {
  available: boolean;
  reason: "ok" | "free" | "no_payee" | "stripe_not_connected" | "sales_closed";
};

export type PublicSeriesDate = {
  occurrenceId: string;
  eventId: string;
  slug: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  isCurrent: boolean;
};

export type EventSeriesDates = {
  seriesId: string | null;
  seriesName: string | null;
  dates: PublicSeriesDate[];
};

export const loadEventTicketTypes = cache(
  async (eventId: string): Promise<PublicTicketType[]> => {
    const client = getServerTrpcClient();
    try {
      const payload = await client.events.listEventTicketTypes.query({
        eventId,
      });
      return payload.ticketTypes;
    } catch (err) {
      if (isNotFoundError(err)) {
        return [];
      }
      if (process.env.NODE_ENV !== "production") {
        return [];
      }
      throw err;
    }
  },
);

/**
 * Loads the runtime sellability flag for an event — used by the public
 * detail page to gate the Buy CTA when the organizer's Stripe Connect
 * account isn't ready. Free events return `{ available: true, reason: "free" }`.
 */
export const loadEventSellability = cache(
  async (eventId: string): Promise<EventSellability> => {
    const client = getServerTrpcClient();
    try {
      const payload = await client.events.listEventTicketTypes.query({
        eventId,
      });
      return payload.sellability;
    } catch (err) {
      if (isNotFoundError(err)) {
        // Treat unknown events as not sellable; the page itself will 404.
        return { available: false, reason: "no_payee" };
      }
      if (process.env.NODE_ENV !== "production") {
        // In dev, fail open so an unrelated tRPC outage doesn't hide every Buy
        // button. Real errors surface via the global query logger.
        return { available: true, reason: "ok" };
      }
      throw err;
    }
  },
);

/**
 * Loads the published sibling dates of an event's series for the buyer-facing
 * date switcher. Non-blocking: any failure (including "not part of a series")
 * degrades to an empty list so the event page renders unchanged.
 */
export const loadEventSeriesDates = cache(
  async (eventId: string): Promise<EventSeriesDates> => {
    const empty: EventSeriesDates = {
      seriesId: null,
      seriesName: null,
      dates: [],
    };
    const client = getServerTrpcClient();
    try {
      return await client.series.publicSeriesDates.query({ eventId });
    } catch (err) {
      traceIgnoredError("event.page.seriesDatesFallback")(err);
      return empty;
    }
  },
);

/**
 * One UPCOMING occurrence of a recurring COMMUNITY listing, with the VIEWER's
 * own per-date RSVP state (never a public count). Serialized as ISO strings so
 * it can cross the RSC → client-island boundary as props.
 *
 * CANCELLED occurrences are included. A night a moderator called off stays on
 * the page, struck through, until it passes — dropping it says "that date was
 * never on the schedule" when what happened is "that date is off", and the
 * person who heard "it's on Wednesday" deserves an answer rather than silence.
 */
export type CommunityEventDate = {
  eventDateId: string;
  startsAt: string;
  endsAt: string | null;
  viewerRsvped: boolean;
  /**
   * `CANCELLED` → render struck through and offer no RSVP on it. Event-
   * intrinsic (it describes the night, not the reader), so unlike
   * `viewerRsvped` this rides the edge-cached document — which is what makes
   * the called-off marker visible to anonymous readers at all.
   */
  status: "SCHEDULED" | "CANCELLED";
};

/**
 * Plain-language shape of a recurring listing's rule, so the page can lead with
 * "Every Wednesday, 8:00 PM" instead of painting all 52 upcoming rows. `null`
 * when there is no summarisable rule (single-date listing, fixed date list, or
 * a rule outside the subset a sentence can state).
 *
 * Event-intrinsic by construction — a cadence says nothing about who is asking
 * — so unlike `viewerRsvped` it is allowed to ride the edge-cached document.
 *
 * `until` is an ISO string: the core use-case returns a `Date`, and this is the
 * RSC → client-island boundary.
 */
export type CommunityRecurrenceSummary = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  /** >= 1. 1 means every day/week/month. */
  interval: number;
  /** RRULE two-letter weekday codes, Monday-first; `[]` when absent. */
  byday: string[];
  until: string | null;
};

/** A recurring listing's upcoming occurrences plus the rule behind them. */
export type CommunityDates = {
  dates: CommunityEventDate[];
  recurrence: CommunityRecurrenceSummary | null;
  /**
   * `true` when `dates` does NOT run to the end of the series — there are more
   * occurrences than the ones here.
   *
   * Server-computed and NOT derivable here: the list is capped by the use
   * case's row limit AND by how far ahead occurrences are materialised, and
   * neither cap is visible to a caller. Rendering the last row as the end of
   * the schedule is how "52 dates through Sep 2027" got printed under an
   * open-ended weekly rule that never ends.
   *
   * It sits beside `dates` rather than inside `recurrence` on purpose: it
   * describes THIS LIST, and it is meaningful for a FIXED_DATES listing with no
   * summarisable rule at all. Event-intrinsic either way, so it may ride the
   * edge-cached document.
   */
  truncated: boolean;
  /**
   * The occurrence the page must LEAD with — the first upcoming one still
   * SCHEDULED, or `null` when every upcoming occurrence is called off (or
   * there are none).
   *
   * Server-computed, and `dates[0]` is now routinely the WRONG answer: a
   * called-off night sorts first like any other, and leading with it
   * advertises a night that is off.
   */
  nextScheduledEventDateId: string | null;
  /**
   * Whether the listing is driven by a stored recurrence rule at all.
   *
   * NOT derivable from `recurrence`, which is `null` for FIXED_DATES and for
   * any rule outside the summarisable phrasebook — both of which are very much
   * series. This is the field that makes the zero-dates ruling expressible, and
   * the one that keeps a drained recurring listing off the single event-level
   * RSVP button (whose `Event.startsAt` is by then a past or synthetic instant,
   * so it attaches "I'm going" to a night that already happened).
   */
  hasRecurrenceRule: boolean;
};

/**
 * Loads a recurring community listing's upcoming schedule (recurring-dates
 * spec, slice 4) for the public event page. Returns UPCOMING SCHEDULED dates
 * ascending, the recurrence rule summarised, and whether the list stops short
 * of the end of the series; EMPTY / `null` / `false` for single-date and
 * non-recurring listings. Non-blocking: any failure degrades to
 * `{ dates: [], recurrence: null, truncated: false }` so the event page renders
 * unchanged (mirrors {@link loadEventSeriesDates}).
 *
 * For the per-date RSVP flags ALONE, use {@link loadViewerDateRsvps} — it skips
 * the recurrence half and the Event row read behind it.
 */
export const loadEventDates = cache(
  async (eventId: string): Promise<CommunityDates> => {
    const client = getServerTrpcClient();
    try {
      const payload = await client.community.listEventDates.query({ eventId });
      return {
        dates: payload.dates.map((d) => ({
          eventDateId: d.eventDateId,
          startsAt: new Date(d.startsAt).toISOString(),
          endsAt: d.endsAt ? new Date(d.endsAt).toISOString() : null,
          viewerRsvped: d.viewerRsvped,
          status: d.status,
        })),
        recurrence: payload.recurrence
          ? {
              freq: payload.recurrence.freq,
              interval: payload.recurrence.interval,
              byday: payload.recurrence.byday,
              until: payload.recurrence.until
                ? new Date(payload.recurrence.until).toISOString()
                : null,
            }
          : null,
        truncated: payload.truncated,
        nextScheduledEventDateId: payload.nextScheduledEventDateId,
        hasRecurrenceRule: payload.hasRecurrenceRule,
      };
    } catch (err) {
      traceIgnoredError("event.page.eventDatesFallback")(err);
      // A failed read resolves toward the UNCHANGED single-date rendering:
      // `hasRecurrenceRule: false` is the same "we do not know" the use case
      // answers with, and it is the only value that cannot turn a degraded read
      // into a "this series has ended" claim about a live listing.
      return {
        dates: [],
        recurrence: null,
        truncated: false,
        nextScheduledEventDateId: null,
        hasRecurrenceRule: false,
      };
    }
  },
);

/**
 * The VIEWER's own per-date RSVP flags, keyed by `eventDateId` — and nothing
 * else.
 *
 * For `POST /api/events/[eventId]/viewer-state`, which is `private, no-store`
 * and renders no cadence: it asks for `includeRecurrence: false` so the API
 * skips the Event row read that backs the summary. That read was happening once
 * per viewer per RSVP event page and its result was thrown away here.
 *
 * Returns only the map on purpose: the cadence and `truncated` are
 * event-intrinsic, already ride the edge-cached document, and `truncated`
 * cannot be computed in full without the row this path declines to read — so
 * there is nothing here to mistakenly forward. `{}` on any failure (the RSVP
 * toggles then show the cached "not going" seed, which is the safe default).
 */
export const loadViewerDateRsvps = cache(
  async (eventId: string): Promise<Record<string, boolean>> => {
    const client = getServerTrpcClient();
    try {
      const payload = await client.community.listEventDates.query({
        eventId,
        includeRecurrence: false,
      });
      return Object.fromEntries(
        payload.dates.map((d) => [d.eventDateId, d.viewerRsvped]),
      );
    } catch (err) {
      traceIgnoredError("event.page.viewerDateRsvpsFallback")(err);
      return {};
    }
  },
);

/**
 * One upcoming occurrence with the viewer's own RSVP state DROPPED — the
 * edge-cacheable half of {@link CommunityEventDate}. The optional `never`
 * makes it unsettable rather than merely absent (see {@link PublicEventSeo}).
 */
export type PublicCommunityEventDate = Omit<
  CommunityEventDate,
  "viewerRsvped"
> & { viewerRsvped?: never };

/** The edge-cacheable half of {@link CommunityDates}. */
export type PublicCommunityDates = {
  dates: PublicCommunityEventDate[];
  recurrence: CommunityRecurrenceSummary | null;
  truncated: boolean;
  nextScheduledEventDateId: string | null;
  hasRecurrenceRule: boolean;
};

/**
 * {@link loadEventDates} with the per-date `viewerRsvped` removed at the
 * boundary. The dates and their ids are event-intrinsic; which of them THIS
 * viewer said yes to is not, and it used to ride the cached document — showing
 * "you're going" to whoever happened to hit the same colo. The viewer's own
 * flags come back after first paint via `POST /api/events/[id]/viewer-state`.
 *
 * `recurrence`, `truncated`, `nextScheduledEventDateId`, `hasRecurrenceRule`
 * and each date's `status` pass through UNCHANGED: they describe the rule, the
 * list and the nights, not the reader, so they are as shareable as the dates
 * themselves. That is exactly why a called-off night can be struck through for
 * an anonymous reader served from a warm edge, while the moderator controls
 * beside it cannot ride this document at all.
 *
 * Wraps the `cache()`d loader so a render needing both still makes one call.
 */
export const loadPublicEventDates = cache(
  async (eventId: string): Promise<PublicCommunityDates> => {
    const {
      dates,
      recurrence,
      truncated,
      nextScheduledEventDateId,
      hasRecurrenceRule,
    } = await loadEventDates(eventId);
    return {
      dates: dates.map(({ viewerRsvped: _viewerRsvped, ...rest }) => rest),
      recurrence,
      truncated,
      nextScheduledEventDateId,
      hasRecurrenceRule,
    };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Fee Rates (for the public event detail page — shows "From $X + ~$Y fees")
// ─────────────────────────────────────────────────────────────────────────────

export type PublicFeeEstimate = {
  ticketTypeId: string;
  unitPriceCents: number;
  platformFeeCents: number;
  processorFeeCents: number;
  taxEstimateCents: number;
  buyerUnitTotalCents: number;
};

export type PublicFeeRates = {
  feeMode: "ABSORB" | "PASS_THROUGH" | null;
  admissionTaxRateBps: number | null;
  platformFeeLabel: string | null;
  /**
   * The per-ticket fee policy (`platformFeeRates`): pct, cap, floor and fixed
   * part, so the fee label can say "3.33%, max $0.50/ticket" — or "3.33%
   * (max $0.50) + $0.30" when a fixed part sits outside the cap. Optional:
   * older fixtures.
   */
  platformFeeRates?: PlatformFeeRateParts | null;
  processorFeeLabel: string | null;
  perTicketEstimates: PublicFeeEstimate[];
  /**
   * Every tax line the admission owes (`getCheckoutFeeRates.taxImpositions`).
   * The tooltip's rate label comes from these (`taxRateLabelBps`), never from
   * `admissionTaxRateBps`, which is the SALES line alone. Optional: older
   * fixtures.
   */
  taxImpositions?: ReadonlyArray<TaxLineForLabel> | null;
};

export const loadEventFeeRates = cache(
  async (eventId: string): Promise<PublicFeeRates | null> => {
    const client = getServerTrpcClient();
    try {
      const payload = await client.events.getCheckoutFeeRates.query({
        eventId,
      });
      return {
        feeMode: payload.feeMode,
        admissionTaxRateBps: payload.admissionTaxRateBps,
        platformFeeLabel: payload.platformFeeLabel,
        platformFeeRates: payload.platformFeeRates ?? null,
        processorFeeLabel: payload.processorFeeLabel,
        perTicketEstimates: payload.perTicketEstimates,
        taxImpositions: payload.taxImpositions,
      };
    } catch (err) {
      traceIgnoredError("server.events.loadFeesFallback")(err);
      // Graceful fallback — fees are supplementary info
      return null;
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Event Humans / Lineup (for the public event detail page)
// ─────────────────────────────────────────────────────────────────────────────

export type PublicEventHuman = {
  id: string;
  name: string;
  role: string;
  customRoleLabel: string | null;
  profileUrl: string | null;
  sortOrder: number;
  /**
   * Music URL derived at read time from the act's performer profile
   * (lineup-listen-embeds spec). Optional until `eventHumans.listPublic`
   * ships the field — consumers must treat a missing value as null.
   */
  listenUrl?: string | null;
};

export const loadEventHumans = cache(
  async (eventId: string): Promise<PublicEventHuman[]> => {
    const client = getServerTrpcClient();
    try {
      return await client.eventHumans.listPublic.query({ eventId });
    } catch (err) {
      if (isNotFoundError(err)) {
        return [];
      }
      if (process.env.NODE_ENV !== "production") {
        return [];
      }
      throw err;
    }
  },
);

export const listEventSitemapEntries = cache(
  async (): Promise<SitemapEntry[]> => {
    if (serverRuntimeEnv.flags.smokeBuild) {
      return getSmokeSitemapEntries();
    }

    const entries = await fetchSitemapEntries();
    if (entries.length === 0) return entries;

    // Defensive filter: only include indexable (published) events.
    // The upstream endpoint should already be published-only, but this keeps the web
    // sitemap safe if that ever changes.
    const checks = await Promise.all(
      entries.map(async (entry) => {
        try {
          const url = new URL(entry.url);
          const slug = decodeURIComponent(
            url.pathname.replace(/^\/events\//, ""),
          );
          const seo = await loadEventSeo(slug);
          return seo && isIndexableEvent(seo) ? entry : null;
        } catch (err) {
          traceIgnoredError("server.events.sitemapEntryCheck")(err);
          return null;
        }
      }),
    );

    return checks.filter((entry): entry is SitemapEntry => Boolean(entry));
  },
);

const LOCAL_EVENTS_QUERY = { limit: 12, offset: 0 } as const;

const fetchLocalEventsPayload = async (): Promise<{
  events: EventSummary[];
}> => {
  const client = getServerTrpcClient();
  return client.events.localEvents.query(LOCAL_EVENTS_QUERY);
};

export const loadInitialLocalEvents = cache(
  async (): Promise<{ summaries: EventSummary[] }> => {
    if (serverRuntimeEnv.flags.smokeBuild) {
      return { summaries: getSmokeEventSummaries() };
    }

    try {
      const payload = await fetchLocalEventsPayload();
      return { summaries: payload.events };
    } catch (err) {
      // Local/dev is frequently run without an API or without a selected region.
      // Don't spam the console with expected fetch/validation errors.
      if (process.env.NODE_ENV !== "production") {
        return { summaries: [] };
      }

      console.error("Failed to load local events", err);
      return { summaries: [] };
    }
  },
);

export const listLocalEventSummaries = cache(
  async (): Promise<EventSummary[]> => {
    const { summaries } = await loadInitialLocalEvents();
    return summaries;
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Geo × Category landing pages (`/events/category/<slug>/<city>`)
//
// Server-rendered, indexable aggregates of upcoming events for one category in
// one city. The list is fetched here (not client-side) so it lands in the
// initial HTML for crawlers. Slow-changing → the route uses ISR, not
// force-dynamic.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many events to render on a single geo×category page. These pages are one
 * flat, un-paginated list (no `?sort`/`?filter`/`?page` params to keep one
 * canonical per combo), so we cap at a healthy-but-bounded page size.
 */
const GEO_CATEGORY_PAGE_LIMIT = 48;

export type GeoCategoryEventsPayload = {
  events: EventSummary[];
  total: number;
  /** Ungated matches; the robots threshold counts these only. */
  indexableTotal: number;
  /** English: page metadata and JSON-LD stay English (NFR-001). */
  categoryName: string;
  /** Every name the category has (`{ en, es? }`), for visible text. */
  names?: Partial<Record<string, string>>;
  cityLabel: string;
  regionCode: string | null;
};

/**
 * True when the error means "this category/city combo doesn't exist / isn't
 * live" — either a plain tRPC NOT_FOUND or the `CATEGORY_NOT_FOUND` app error
 * (the router maps that appCode onto a NOT_FOUND tRPC code, so `isNotFoundError`
 * already covers it; the appCode check is a defensive belt-and-suspenders in
 * case the mapping changes). Callers turn this into a `null` payload → 404.
 */
const isGeoCategoryNotFoundError = (error: unknown): boolean => {
  if (isNotFoundError(error)) return true;
  if (error instanceof TRPCClientError) {
    const data = error.data as { appCode?: string } | null | undefined;
    return data?.appCode === "CATEGORY_NOT_FOUND";
  }
  return false;
};

export const loadGeoCategoryEvents = cache(
  async (
    categorySlug: string,
    citySegment: string,
  ): Promise<GeoCategoryEventsPayload | null> => {
    const client = getServerTrpcClient();
    try {
      return await client.events.geoCategoryEvents.query({
        categorySlug,
        citySegment,
        limit: GEO_CATEGORY_PAGE_LIMIT,
      });
    } catch (err) {
      if (isGeoCategoryNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
);

/** The tRPC error code of a client error, if it is one. */
const trpcErrorCode = (error: unknown): string | undefined => {
  if (!(error instanceof TRPCClientError)) return undefined;
  const data = error.data as { code?: unknown } | null | undefined;
  return typeof data?.code === "string" ? data.code : undefined;
};

/**
 * "There is no such category page": unknown/inactive category, or a slug the
 * input schema rejects (too long, empty) — a URL nobody can fix by retrying,
 * so a 404, not a Sentry event and a soft 200.
 */
const isCategoryPageNotFoundError = (error: unknown): boolean =>
  isGeoCategoryNotFoundError(error) || trpcErrorCode(error) === "BAD_REQUEST";

/**
 * Search failures that are a known state, not an incident: the category is
 * not found (the DB read decides that), or search is not configured in this
 * environment (PRECONDITION_FAILED). Not reported per page view.
 *
 * BAD_REQUEST is deliberately NOT here. Search's input has no slug max, so it
 * can only reject OUR input (e.g. a page size over its limit of 50), and that
 * would fail search on every view: it must reach Sentry.
 */
const isExpectedCategorySearchError = (error: unknown): boolean =>
  isGeoCategoryNotFoundError(error) ||
  trpcErrorCode(error) === "PRECONDITION_FAILED";

export type CategoryPageLoad =
  | {
      status: "found";
      /** English: page metadata and JSON-LD stay English (NFR-001). */
      categoryName: string;
      /**
       * Every name the category has (`{ en, es? }`), for the visible heading
       * in the viewer's language. Absent when the list failed or predates it.
       */
      categoryNames?: Partial<Record<string, string>>;
      /** Upcoming listed events in the category (the page's whole count). */
      total: number;
      /**
       * Upcoming listed events that are NOT gated. The page is indexable only
       * when this is at least 1 (owner ruling 2026-10-13); the category
       * sitemap applies the same rule.
       */
      indexableTotal: number;
      seed: CategoryEventsSeed;
    }
  /** The category does not exist or is inactive. */
  | { status: "not-found" }
  /** The API read failed: render the client-fetching page, claim nothing. */
  | { status: "unavailable" };

/**
 * Server read for the plain category page, so its first page of events is in
 * the initial HTML. Asks the same two procedures `useCategoryEvents` does, with
 * the same inputs, and returns both answers as the hook's seed.
 *
 * De-identified client: neither procedure depends on the viewer, and an
 * anonymous read can never put one viewer's answer into a shared document.
 *
 * Swallows, each reported: search failing degrades to the DB list (as the hook
 * does); the category list failing only costs the display name; the DB read
 * failing degrades to today's client-only render.
 */
export const loadCategoryPageEvents = cache(
  async (categorySlug: string): Promise<CategoryPageLoad> => {
    const client = getPublicTrpcClient();
    const fetchedAt = new Date().toISOString();

    const [db, search, list] = await Promise.all([
      client.categories.eventsByCategory
        .query({ categorySlug, limit: CATEGORY_PAGE_SIZE, offset: 0 })
        .catch((err: unknown) => {
          if (isCategoryPageNotFoundError(err)) return "not-found" as const;
          traceIgnoredError("server.events.loadCategoryPageEvents.db")(err);
          return null;
        }),
      client.search.discoverEventsByCategory
        .query({ categorySlug, limit: CATEGORY_PAGE_SIZE })
        .catch((err: unknown) => {
          traceIgnoredError(
            "server.events.loadCategoryPageEvents.search",
            isExpectedCategorySearchError,
          )(err);
          return null;
        }),
      client.categories.list.query().catch((err: unknown) => {
        traceIgnoredError("server.events.loadCategoryPageEvents.list")(err);
        return null;
      }),
    ]);

    if (db === "not-found") return { status: "not-found" };
    if (!db) return { status: "unavailable" };

    const listed = list?.categories.find((c) => c.slug === categorySlug);
    const categoryName = listed?.name ?? categorySlug;

    return {
      status: "found",
      categoryName,
      ...(listed?.names ? { categoryNames: listed.names } : {}),
      total: db.total,
      indexableTotal: db.indexableTotal,
      seed: { search, db, fetchedAt },
    };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Edit URL resolution
//
// Attempts to resolve the admin-edit URL for an event.  Returns `null` when
// the viewer is anonymous, lacks permission, or any network call fails.
// Used on the public event page to conditionally show an "Edit Event" button.
// ─────────────────────────────────────────────────────────────────────────────

export const resolveEditUrl = cache(
  async (eventId: string): Promise<string | null> => {
    const client = getServerTrpcClient();

    try {
      // 1. Check that the current viewer can actually edit this event.
      //    `getEventForEdit` is an authed procedure that throws when the
      //    viewer has no edit-capable role.
      const editData = await client.events.getEventForEdit.query({ eventId });

      // 2. Fetch the viewer's owner entities so we can derive the admin slug
      //    (orgSlug or @username).
      const { owners } = await client.events.listEventOwnerEntities.query({});
      if (!owners?.length) return null;

      // Prefer the first org — mirrors the logic in useEventOwnerEntities.
      const firstOrg = owners.find((o: { kind: string }) => o.kind === "org");
      const adminSlug = firstOrg
        ? (firstOrg as any).orgSlug || (firstOrg as any).orgId
        : (() => {
            const human = owners.find(
              (o: { kind: string }) => o.kind === "human",
            ) as any;
            if (!human) return null;
            return human.humanUsername
              ? `@${human.humanUsername}`
              : human.humanProfileSlug
                ? `@${human.humanProfileSlug}`
                : `@${human.humanId}`;
          })();

      if (!adminSlug) return null;

      return `/admin/${adminSlug}/events/${eventId}`;
    } catch (err) {
      // Viewer is anonymous / unauthorized — common, low-signal, but still
      // report so unexpected upstream failures are visible.
      traceIgnoredError("server.events.adminLinkResolve")(err);
      return null;
    }
  },
);
