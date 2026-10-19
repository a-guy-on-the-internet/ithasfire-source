import { z } from "zod";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  grantStatusAt,
  isGrantLive,
  placeBookingGrantOutputSchema,
  requireGrantAtPlace,
  requireGrantManager,
  sameGrantee,
  toPlaceBookingGrantOutput,
  type PlaceBookingGrantDeps,
} from "./_shared/grant-context";

// ─────────────────────────────────────────────────────────────────────────────
// updatePlaceBookingGrant (holds-without-a-request FR-003, H4).
//
// The grant's managers (direct owner, owning-org OWNER / ADMIN) edit its
// scope (whole place ↔ one calendar) and its expiry. `undefined` leaves a
// field as is; `null` clears it (whole place / no expiry). Moving the expiry
// clears the 7-day warning stamp (the repo does it), so a new date earns a
// new warning (FR-004).
//
// ONLY A LIVE GRANT (pending or active) is edited. A revoked, declined or
// expired grant is PLACE_BOOKING_GRANT_ENDED: give a new one. Reviving an
// expired grant by moving its date would hand back authority whose holds
// FR-004 already released, without the grantee saying yes again.
//
// NARROWING TO ONE CALENDAR while the booker holds live dates on another
// calendar is refused (PLACE_BOOKING_GRANT_SCOPE_HAS_HOLDS, `meta.holdCount`).
// Those holds would ride a grant that no longer covers them, and deciding
// their fate is the revoke dialog's job (H15: each one released or kept, by
// choice). Staff release them (or revoke) first. Narrowing the EXPIRY needs
// no such check: at the new date FR-004 releases the holds as it would have
// at the old one.
//
// SCOPE OVERLAP: widening to the whole place (or moving to a calendar) while
// the same grantee holds another live grant covering that scope →
// PLACE_BOOKING_GRANT_EXISTS, as on give.
//
// IDEMPOTENT: an edit that changes nothing returns the grant unchanged
// (`changed: false`), no write, no audit row.
//
// NO NOTICE: FR-013 does not list a grant edit.
// ─────────────────────────────────────────────────────────────────────────────

export const updatePlaceBookingGrantInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    placeId: z.uuid(),
    grantId: z.uuid(),
    /** Omitted = unchanged; null = the whole place. */
    calendarId: z.uuid().nullable().optional(),
    /** Omitted = unchanged; null = no expiry. Must be in the future. */
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict();

export const updatePlaceBookingGrantOutputSchema = z
  .object({
    grant: placeBookingGrantOutputSchema,
    /** False = the edit matched the grant as it stood; nothing written. */
    changed: z.boolean(),
  })
  .strict();

export type UpdatePlaceBookingGrantInput = z.infer<
  typeof updatePlaceBookingGrantInputSchema
>;
export type UpdatePlaceBookingGrantOutput = z.infer<
  typeof updatePlaceBookingGrantOutputSchema
>;
export type UpdatePlaceBookingGrantDeps = PlaceBookingGrantDeps;

export async function updatePlaceBookingGrant(
  deps: UpdatePlaceBookingGrantDeps,
  rawInput: unknown,
): Promise<UpdatePlaceBookingGrantOutput> {
  const input = parseInput(updatePlaceBookingGrantInputSchema, rawInput);
  const now = deps.clock.now();
  const { repos } = deps;

  const { place } = await requireGrantManager(
    repos,
    input.placeId,
    input.actorHumanId,
  );
  const grant = await requireGrantAtPlace(repos, place.id, input.grantId);
  const status = grantStatusAt(grant, now);
  if (status !== "pending" && status !== "active") {
    throw fail("PLACE_BOOKING_GRANT_ENDED", {
      meta: { grantId: grant.id, reason: status },
    });
  }

  const nextCalendarId =
    input.calendarId === undefined ? grant.calendarId : input.calendarId;
  const nextExpiresAt =
    input.expiresAt === undefined ? grant.expiresAt : input.expiresAt;
  const calendarChanges = nextCalendarId !== grant.calendarId;
  const expiryChanges =
    (nextExpiresAt?.getTime() ?? null) !== (grant.expiresAt?.getTime() ?? null);

  if (!calendarChanges && !expiryChanges) {
    return updatePlaceBookingGrantOutputSchema.parse({
      grant: toPlaceBookingGrantOutput(grant, now),
      changed: false,
    });
  }

  if (
    expiryChanges &&
    nextExpiresAt !== null &&
    nextExpiresAt.getTime() <= now.getTime()
  ) {
    throw fail("EXPIRES_AT_IN_PAST", { meta: { field: "expiresAt" } });
  }

  if (calendarChanges && nextCalendarId !== null) {
    const calendar = await repos.calendars.findById(nextCalendarId);
    if (!calendar || calendar.placeId !== place.id) {
      throw fail("CALENDAR_NOT_FOUND", {
        meta: {
          reason: "grant_calendar_place_mismatch",
          calendarId: nextCalendarId,
        },
      });
    }
  }

  const updated = await repos.tx(async (tx) => {
    // LOCK ORDER (hold-line.ts): the place's grant-set lock, then the grant
    // row, then (never here) line locks.
    if (calendarChanges) {
      // Under the grant-set lock, as give checks it: another live grant for
      // the same grantee already covering the new scope. A give racing this
      // edit waits on the lock and then sees the new scope.
      await tx.placeBookingGrants.lockPlace(place.id);
      const others = (
        await tx.placeBookingGrants.listForPlace({ placeId: place.id })
      ).filter(
        (g) =>
          g.id !== grant.id &&
          sameGrantee(g.grantee, grant.grantee) &&
          isGrantLive(g, now),
      );
      const overlapping = others.find(
        (g) =>
          g.calendarId === null ||
          nextCalendarId === null ||
          g.calendarId === nextCalendarId,
      );
      if (overlapping) {
        throw fail("PLACE_BOOKING_GRANT_EXISTS", {
          meta: { grantId: overlapping.id },
        });
      }
    }
    let row;
    try {
      row = await tx.placeBookingGrants.update({
        id: grant.id,
        placeId: place.id,
        now,
        ...(calendarChanges ? { calendarId: nextCalendarId } : {}),
        ...(expiryChanges ? { expiresAt: nextExpiresAt } : {}),
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "grant_calendar_place_mismatch") {
        throw fail("CALENDAR_NOT_FOUND", {
          meta: {
            reason: "grant_calendar_place_mismatch",
            calendarId: nextCalendarId,
          },
        });
      }
      throw error;
    }
    // Ended in between (revoked, declined or expired): the repo scopes the
    // write to live grants, so no row and no audit. Throwing rolls back.
    if (!row) {
      throw fail("PLACE_BOOKING_GRANT_ENDED", {
        meta: { grantId: grant.id, reason: "ended" },
      });
    }
    if (calendarChanges && nextCalendarId !== null) {
      // AFTER the write: the UPDATE holds the grant row's lock, so a booker
      // placing a hold under this grant (which locks the grant row before
      // its line, step 6) waits for this commit and then sees the narrower
      // scope. Read before the write (READ COMMITTED), a hold committed in
      // between would be missed and stranded on a calendar the grant no
      // longer covers. Throwing here rolls the write back.
      const stranded = (await tx.bookingHolds.listLiveForGrant(grant.id)).filter(
        (hold) => hold.calendarId !== nextCalendarId,
      );
      if (stranded.length > 0) {
        throw fail("PLACE_BOOKING_GRANT_SCOPE_HAS_HOLDS", {
          meta: { grantId: grant.id, holdCount: stranded.length },
        });
      }
    }
    await tx.audit.log({
      entity: "place_booking_grant",
      entityId: row.id,
      action: "place_booking_grant.updated",
      data: {
        actorHumanId: input.actorHumanId,
        placeId: place.id,
        before: {
          calendarId: grant.calendarId,
          expiresAt: grant.expiresAt?.toISOString() ?? null,
        },
        after: {
          calendarId: row.calendarId,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
      },
      at: now,
    });
    return row;
  });

  deps.logger?.info("place_booking_grants.updated", {
    grantId: updated.id,
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    calendarChanged: calendarChanges,
    expiryChanged: expiryChanges,
  });

  return updatePlaceBookingGrantOutputSchema.parse({
    grant: toPlaceBookingGrantOutput(updated, now),
    changed: true,
  });
}
