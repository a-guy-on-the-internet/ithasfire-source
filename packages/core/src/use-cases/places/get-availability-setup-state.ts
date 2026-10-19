import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Availability-onboarding detector (spec docs/specs/2026-08-31/
// availability-onboarding.spec.yaml, `detector:`).
//
// UNCONFIGURED = the place has ZERO CalendarAvailability rows, counting both
// place-wide rows (`calendarId: null`) and every named calendar's rows. With
// zero rows every day computes `closed` (availability-intervals `dayStatus`),
// the public booking form has no attainable "preferred dates" value, and the
// venue is silently uncontactable while believing it takes requests.
//
// ONE read, exposed once (`places.getAvailabilitySetupState`) and consumed by
// every admin surface (FR-001 warning, FR-004 banner, FR-006 picker empty
// state) — surfaces must NOT re-derive it.
// ─────────────────────────────────────────────────────────────────────────────

// ── Schemas ──────────────────────────────────────────────────────────────────

export const getAvailabilitySetupStateInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
  })
  .strict();

/**
 * WIRE CONTRACT — fixed (UI agents build against it verbatim):
 * `{ configured, calendarCount, defaultCalendarId, acceptsBookingRequests }`.
 * `defaultCalendarId` tells the FR-002 hours modal which scope to open on
 * (the default calendar when one exists, else the place-wide null scope).
 * `acceptsBookingRequests` is the RAW toggle (not the public projection —
 * FR-005 folds `configured` into that separately): the FR-004 banner
 * triggers on "unconfigured AND accepting", and this read already holds the
 * Place row, so carrying it here kills a per-venue getPlaceForEdit fan-out.
 */
export const getAvailabilitySetupStateOutputSchema = z
  .object({
    configured: z.boolean(),
    calendarCount: z.number().int().min(0),
    defaultCalendarId: z.string().nullable(),
    acceptsBookingRequests: z.boolean(),
  })
  .strict();

export type GetAvailabilitySetupStateInput = z.infer<
  typeof getAvailabilitySetupStateInputSchema
>;
export type GetAvailabilitySetupStateOutput = z.infer<
  typeof getAvailabilitySetupStateOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type GetAvailabilitySetupStateDeps = {
  repos: Pick<Repos, "places" | "authz" | "calendars">;
  logger?: LoggerPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Owner-gated setup-state read for a place's availability.
 *
 * Ownership mirrors `setPlaceBookingAcceptance` (the toggle this detector
 * annotates): the actor must be a direct human owner or a member of an owning
 * org — ANY role, not just edit roles, because this is a read that only
 * reveals "has this venue set hours yet", the same thing the owner's admin
 * shell already shows.
 */
export async function getAvailabilitySetupState(
  deps: GetAvailabilitySetupStateDeps,
  rawInput: unknown,
): Promise<GetAvailabilitySetupStateOutput> {
  const input = parseInput(getAvailabilitySetupStateInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Ownership check — mirrors set-place-booking-acceptance verbatim.
  const isDirectHumanOwner = place.humanIdsWithAccess.includes(
    input.actorHumanId,
  );

  let isOrgOwner = false;
  if (!isDirectHumanOwner && place.orgIdsWithAccess.length > 0) {
    const memberships = await deps.repos.authz.getOrgMemberships({
      orgIds: place.orgIdsWithAccess,
      humanId: input.actorHumanId,
    });
    isOrgOwner = memberships.length > 0;
  }

  if (!isDirectHumanOwner && !isOrgOwner) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }

  const [availabilityRowCount, calendarCount, defaultCalendar] =
    await Promise.all([
      deps.repos.calendars.countAvailabilityForPlace(place.id),
      deps.repos.calendars.countForPlace(place.id),
      deps.repos.calendars.findDefaultForPlace(place.id),
    ]);

  return getAvailabilitySetupStateOutputSchema.parse({
    configured: availabilityRowCount > 0,
    calendarCount,
    defaultCalendarId: defaultCalendar?.id ?? null,
    acceptsBookingRequests: place.acceptsBookingRequests === true,
  });
}
