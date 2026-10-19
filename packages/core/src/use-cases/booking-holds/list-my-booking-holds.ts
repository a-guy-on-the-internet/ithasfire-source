import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { BookingHoldStatus } from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_ANY_ROLE, requireOrgMembership } from "../../lib/rbac";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import { isHoldLapsed } from "./_shared/booking-hold-lapse";
import {
  bookingHoldStatusSchema,
  isoCalendarDateSchema,
} from "./_shared/hold-context";

// ─────────────────────────────────────────────────────────────────────────────
// listMyBookingHolds — the REQUESTER-side holds read (event-calendar-redesign
// FR-004; docs/specs/2026-09-02). "Every hold my booking requests have
// placed, across every venue" — the org or human dashboard's hold chips.
//
// TENANT ISOLATION (NFR-004, the spec's highest-rated risk): the owner pair is
// the SQL scope (`BookingHoldsRepo.listForRequester` joins on it in the
// WHERE), and the gate here is the SAME one `list-booking-requests` applies
// to its performer scopes — self for a human, org membership (any role) for
// an org. A human's own orgs are NOT folded in: the personal dashboard asks
// per owner, exactly as `events.listMine` does, so a caller can never widen
// one owner id into "everything I can reach".
//
// WHAT THE REQUESTER SEES (booking-holds FR-013): its own hold's date,
// position, status and deadline, plus the venue it is at — never the rest
// of the line, never who at the venue placed it.
//
// READ ONLY + LAPSE-AWARE: `isHoldLapsed` (the one shared predicate) drops
// rows that are already dead but not yet settled — a lapsed challenge or a
// past date is not a chip. Nothing is written; settlement stays with the
// mutations and `settleBookingHolds`.
// ─────────────────────────────────────────────────────────────────────────────

export const listMyBookingHoldsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    /** Mirrors `events.listMine` — the dashboard owner, not the act pair casing. */
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    ownerId: z.uuid(),
  })
  .strict();

export const requesterBookingHoldSchema = z
  .object({
    id: z.uuid(),
    bookingRequestId: z.uuid(),
    calendarId: z.uuid(),
    spaceId: z.uuid().nullable(),
    placeId: z.uuid(),
    placeName: z.string(),
    /** Place-local calendar day, `YYYY-MM-DD` (holds are date-level). */
    date: isoCalendarDateSchema,
    /** 1-based place in the line for calendarId+date. */
    position: z.number().int().min(1),
    status: bookingHoldStatusSchema,
    /** Keep-or-release deadline; non-null only while CHALLENGED. */
    respondBy: z.date().nullable(),
    /** The request's pitched act name, or null when the pitch carried none. */
    requestTitle: z.string().nullable(),
  })
  .strict();

export const listMyBookingHoldsOutputSchema = z
  .object({
    holds: z.array(requesterBookingHoldSchema),
  })
  .strict();

export type ListMyBookingHoldsInput = z.infer<
  typeof listMyBookingHoldsInputSchema
>;
export type ListMyBookingHoldsOutput = z.infer<
  typeof listMyBookingHoldsOutputSchema
>;
export type RequesterBookingHold = z.infer<typeof requesterBookingHoldSchema>;

export type ListMyBookingHoldsDeps = {
  repos: Pick<Repos, "bookingHolds" | "authz">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The live line PLUS the confirmed winner — the same set the admin calendar
 * overlay reads (`events/_shared/booking-hold-overlay.ts`): a night the act
 * has WON must render as its solid chip, not disappear. RELEASED stays out.
 */
const REQUESTER_HOLD_STATUSES = [
  ...LIVE_BOOKING_HOLD_STATUSES,
  "CONFIRMED",
] as const satisfies readonly BookingHoldStatus[];

export async function listMyBookingHolds(
  deps: ListMyBookingHoldsDeps,
  rawInput: unknown,
): Promise<ListMyBookingHoldsOutput> {
  const input = parseInput(listMyBookingHoldsInputSchema, rawInput);
  const now = deps.clock.now();

  // Same bar as `list-booking-requests` scope:"performer": self for a human
  // act; membership, any role, for an org act (viewing is not privileged
  // beyond membership — the hold ACTIONS keep their own gates).
  if (input.ownerType === "HUMAN") {
    if (input.ownerId !== input.actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER");
    }
  } else {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: input.ownerId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
    });
  }

  const rows = await deps.repos.bookingHolds.listForRequester({
    ownerType: input.ownerType === "ORGANIZATION" ? "organization" : "human",
    ownerId: input.ownerId,
    statuses: REQUESTER_HOLD_STATUSES,
  });

  // Lazy expiry: a hold the predicate already calls dead is not a chip.
  const live = rows.filter(
    (hold) =>
      isHoldLapsed(hold, now, resolveBookingTimezone(hold.placeTimezone)) ===
      null,
  );

  deps.logger?.info("booking_holds.list_my", {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    rowCount: rows.length,
    liveCount: live.length,
  });

  return listMyBookingHoldsOutputSchema.parse({
    holds: live.map((hold) => ({
      id: hold.id,
      bookingRequestId: hold.bookingRequestId,
      calendarId: hold.calendarId,
      spaceId: hold.spaceId,
      placeId: hold.placeId,
      placeName: hold.placeName,
      date: hold.date,
      position: hold.position,
      status: hold.status,
      respondBy: hold.respondBy,
      requestTitle: hold.requestActName,
    })),
  });
}
