import { DateTime } from "luxon";
import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  BookingHoldRecord,
  BookingHoldStatus,
} from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";

import { resolveBookingTimezone } from "../../booking-agreements/_shared/pitch-seed";
import {
  lookupPerformerDisplayName,
  resolvePerformerDisplayNames,
} from "../../booking-requests/_shared/performer-display-names";
import { isHoldLapsed } from "../../booking-holds/_shared/booking-hold-lapse";
import {
  bookingHoldStatusSchema,
  isoCalendarDateSchema,
} from "../../booking-holds/_shared/hold-context";

// ─────────────────────────────────────────────────────────────────────────────
// Admin calendar hold overlay (booking-holds FR-014).
//
// ADMIN SURFACES ONLY: the two callers are the owner-gated branches of
// get-venue-calendar (place day view) and get-calendar-events (one named
// calendar). The public branches never import this — the public output
// shapes are `.strict()` without a `holds` key, so a leak is a parse
// failure, not a silent addition (NFR-001 guard test greps the port too).
//
// Holds never enter `detectConflicts`: a hold blocks nothing.
//
// STATUSES: LIVE (ACTIVE | CHALLENGED) *plus* CONFIRMED. A confirmed hold is
// exactly the state `placeHoldOnLine` refuses with
// HOLD_LINE_ALREADY_CONFIRMED, so leaving it out rendered a night that
// cannot be held as open — staff would pick it and eat the refusal, on the
// happy path, for every confirmed future night until its draft event was
// published. The client cannot infer it: confirming mints a DRAFT event, but
// treating DRAFT as taken would over-block the unrelated drafts staff create
// freely, and making a bookable night unreachable is worse than the
// under-marking it replaces. So the signal comes from the server, and
// `status` (already on the schema) is what the client discriminates on.
// RELEASED stays out — a released hold is not a claim on the night.
//
// READ ONLY: lapses are projected (`lapsed`), never settled here.
// ─────────────────────────────────────────────────────────────────────────────

export const calendarHoldOverlaySchema = z
  .object({
    id: z.uuid(),
    /** holds-without-a-request FR-001: whose hold. Lines hold every kind. */
    ownerKind: z.enum(["REQUEST", "BOOKER", "PLACE"]),
    /**
     * Null for a request-less (BOOKER / PLACE) hold. Its label (the holder,
     * or "Place hold") is FR-011's, plan step 8; until then both names
     * below are null for it.
     */
    bookingRequestId: z.uuid().nullable(),
    calendarId: z.uuid(),
    spaceId: z.uuid().nullable(),
    date: isoCalendarDateSchema,
    position: z.number().int().min(1),
    status: bookingHoldStatusSchema,
    respondBy: z.date().nullable(),
    /** Lazy-expiry projection — render as released. */
    lapsed: z.boolean(),
    /** The request's pitched act name; null when the pitch carried none. */
    actName: z.string().nullable(),
    /**
     * The sending performer's PLATFORM display name (human name or org name,
     * resolved from the request's polymorphic owner pair — the same batched
     * resolver the inbox uses). The calendar's fallback when `actName` is
     * blank. Null for anonymous senders, owners that no longer resolve, and
     * whenever the lookup degraded (reported, never thrown).
     */
    performerDisplayName: z.string().nullable(),
  })
  .strict();

export type CalendarHoldOverlay = z.infer<typeof calendarHoldOverlaySchema>;

export type CalendarHoldOverlayDeps = {
  repos: Pick<
    Repos,
    "bookingHolds" | "bookingRequests" | "humans" | "organizations"
  >;
  logger?: LoggerPort;
  /** Best-effort: a failed display-name lookup degrades to null names. */
  reportError?: ReporterPort;
  clock?: { now(): Date };
};

/**
 * What the admin overlay reads: the live line PLUS the confirmed winner. See
 * the header — without CONFIRMED a settled night renders as open.
 */
const OVERLAY_HOLD_STATUSES = [
  ...LIVE_BOOKING_HOLD_STATUSES,
  "CONFIRMED",
] as const satisfies readonly BookingHoldStatus[];

export type CalendarHoldOverlayScope =
  | { kind: "place"; placeId: string }
  | { kind: "calendar"; calendarId: string };

/**
 * Holds in `[from, to]` for a place or one calendar — live (ACTIVE |
 * CHALLENGED) plus CONFIRMED (see the header) — projected for the overlay.
 * The instant window is converted to inclusive place-local calendar days (holds are date-level, place zone). `actName` comes from each hold's
 * request (one read per DISTINCT request in the window — holds are sparse,
 * and there is no batch request read on the port). `performerDisplayName`
 * is ONE batched humans/organizations read for every request in the window;
 * if that read fails every name degrades to null and the failure is reported
 * — the calendar still renders.
 */
export async function resolveBookingHoldOverlay(
  deps: CalendarHoldOverlayDeps,
  args: {
    scope: CalendarHoldOverlayScope;
    place: Pick<PlaceRecord, "timezone"> | null;
    from: Date;
    to: Date;
  },
): Promise<CalendarHoldOverlay[]> {
  const now = deps.clock?.now() ?? new Date();
  const zone = resolveBookingTimezone(args.place?.timezone ?? null);
  const fromDay = DateTime.fromJSDate(args.from, { zone }).toISODate();
  const toDay = DateTime.fromJSDate(args.to, { zone }).toISODate();
  if (!fromDay || !toDay) return [];

  const holds: BookingHoldRecord[] =
    args.scope.kind === "place"
      ? await deps.repos.bookingHolds.listLiveForPlaceRange({
          placeId: args.scope.placeId,
          from: fromDay,
          to: toDay,
          statuses: OVERLAY_HOLD_STATUSES,
        })
      : await deps.repos.bookingHolds.listLiveForCalendarRange({
          calendarId: args.scope.calendarId,
          from: fromDay,
          to: toDay,
          statuses: OVERLAY_HOLD_STATUSES,
        });
  if (holds.length === 0) return [];

  const requestIds = [
    ...new Set(
      holds.flatMap((h) =>
        h.ownerKind === "REQUEST" ? [h.bookingRequestId] : [],
      ),
    ),
  ];
  const requests = await Promise.all(
    requestIds.map((id) => deps.repos.bookingRequests.getById(id)),
  );
  const found = requests.filter((r): r is BookingRequestRecord => r !== null);
  const actNameByRequest = new Map(found.map((r) => [r.id, r.actName] as const));
  const performerNameByRequest = await resolvePerformerNamesDegrading(deps, found);

  return holds.map((hold) => {
    const bookingRequestId =
      hold.ownerKind === "REQUEST" ? hold.bookingRequestId : null;
    return calendarHoldOverlaySchema.parse({
      id: hold.id,
      ownerKind: hold.ownerKind,
      bookingRequestId,
      calendarId: hold.calendarId,
      spaceId: hold.spaceId,
      date: hold.date,
      position: hold.position,
      status: hold.status,
      respondBy: hold.respondBy,
      lapsed: isHoldLapsed(hold, now, zone) !== null,
      actName:
        bookingRequestId !== null
          ? (actNameByRequest.get(bookingRequestId) ?? null)
          : null,
      performerDisplayName:
        bookingRequestId !== null
          ? (performerNameByRequest.get(bookingRequestId) ?? null)
          : null,
    });
  });
}

/**
 * Request id → resolved platform display name. DEGRADES: a failing batch
 * read yields an empty map (every hold falls back to null) and is reported
 * through `reportError` — a name lookup must never take the calendar down.
 */
async function resolvePerformerNamesDegrading(
  deps: Pick<CalendarHoldOverlayDeps, "repos" | "logger" | "reportError">,
  requests: readonly BookingRequestRecord[],
): Promise<Map<string, string>> {
  if (requests.length === 0) return new Map();
  try {
    const names = await resolvePerformerDisplayNames(deps.repos, requests);
    return new Map(
      requests.flatMap((r) => {
        const name = lookupPerformerDisplayName(r, names);
        return name === null ? [] : [[r.id, name] as const];
      }),
    );
  } catch (error) {
    deps.logger?.error("events.booking_hold_overlay.performer_names_failed", {
      err: error,
      requestCount: requests.length,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "booking-hold-overlay", stage: "performer-names" },
        extra: { requestCount: requests.length },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return new Map();
  }
}
