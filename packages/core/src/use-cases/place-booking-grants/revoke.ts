import { z } from "zod";

import type { ReporterPort } from "@th/ports/reporter";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import type { PlaceBookingGrantRecord } from "@th/ports/repos/place-booking-grants";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldNotificationIntent,
  type BookingHoldStaffRecipientHint,
} from "../booking-holds/_shared/booking-hold-intents";
import {
  bookingHoldOutputSchema,
  toBookingHoldOutput,
} from "../booking-holds/_shared/hold-context";
import {
  assertLineSetCovered,
  lineKeysOf,
  lockLines,
  recordMovers,
  releaseHoldCas,
  renumberLine,
} from "../booking-holds/_shared/hold-line";
import { settleLine } from "../booking-holds/_shared/settle-lapsed-holds";
import {
  WITHDRAW_REASON_MAX,
  withdrawVenueConfirmation,
} from "../events/withdraw-venue-confirmation";
import {
  venueConfirmationNotificationIntentSchema,
  type VenueConfirmationNotificationIntent,
} from "../events/_shared/venue-confirmation-intents";
import {
  listEventsConfirmedUnderGrant,
  placeBookingGrantOutputSchema,
  requireGrantAtPlace,
  requireGrantManager,
  toPlaceBookingGrantOutput,
  type PlaceBookingGrantDeps,
} from "./_shared/grant-context";
import {
  placeBookingGrantNotificationIntentSchema,
  type PlaceBookingGrantNotificationIntent,
} from "./_shared/grant-intents";

// ─────────────────────────────────────────────────────────────────────────────
// revokePlaceBookingGrant (holds-without-a-request FR-003, H15; the R1
// dialog's confirm).
//
// The grant's managers (H4) end a grant, choosing for each of the booker's
// live holds and upcoming events (previewGrantRevoke lists them):
//   - holds default to RELEASE (reason GRANT_ENDED); a hold in `keepHoldIds`
//     becomes a PLACE hold naming the booker (same position, same status and
//     challenge, same note; the grant link goes, FR-001's CHECK);
//   - events default to STAY; an event in `withdrawEventIds` has the place's
//     confirmation taken back through `withdrawVenueConfirmation` (the
//     existing path, with `withdrawReason`). Never cancel (H15).
//
// ONE TRANSACTION (FR-003): stamp `revokedAt` (CAS: the second of two racing
// revokes waits on the grant row and then finds it revoked), then lock every
// line the booker's holds sit on in the global order (hold-line.ts), re-read
// under the locks, settle each line (lapses first, as every hold mutation
// does), release / convert the booker's holds, renumber each line that lost
// one, and record the movers: a REQUEST hold that moved up gets the usual
// `hold.position_changed` (its act is told); a request-less one, an audit
// row (H20). Audit rows for every hold and for the grant.
//
// AFTER COMMIT, per event: `withdrawVenueConfirmation`. It runs its own staff
// gate and its own transaction; a failure there is a DELIBERATE SWALLOW (the
// grant is revoked and its holds are settled either way): logged at error,
// reported through `reportError` (CLAUDE.md), and returned as
// `outcome: "failed"` so the dialog can say which ones to retry. Retrying
// the revoke runs the withdrawals again (they are idempotent on the reason).
// An event id that is not one of the grant's confirmed events (or no longer
// is: already withdrawn) is `not_listed` and left alone. The revoke's audit
// row records the ids REQUESTED; a second row,
// `place_booking_grant.revoke_withdrawals`, records each one's outcome once
// they have run (its own write failing is swallowed and reported the same
// way).
//
// IDEMPOTENT: an already revoked grant is not revoked again and no hold is
// touched (`alreadyRevoked: true`, no grant notice); only the requested
// withdrawals run.
//
// NOTICES (FR-013): `grant.revoked` → the grantee, with the dates released
// and kept (one digest, not one notice per hold); move-ups → the acts behind
// (REQUEST holds) via the booking-hold intents; withdrawals → each event's
// owner via the venue-confirmation intents `withdrawVenueConfirmation`
// returns. All returned, none sent here.
//
// A RACING PLACEMENT cannot ride the revoked grant (plan step 6, trap m): a
// BOOKER placement takes FOR SHARE on the grant row before its line lock and
// re-checks the grant on that row. Stamping `revokedAt` waits for a placement
// already holding it (and then sees its hold in `listLiveForGrant`); a
// placement after the stamp reads the revoked row and is refused. The lazy
// GRANT_ENDED branch of `isHoldLapsed` is the backstop for anything else.
//
// THE LAZY BRANCH vs THIS REVOKE (trap l): once `revokedAt` is stamped, every
// hold on this grant reads as GRANT_ENDED, so a plain `settleLine` here would
// release the holds the revoker chose to KEEP before they are converted.
// The settle below passes `exemptGrantId: grant.id`: this grant's holds are
// released or kept by the loop, one by one; every other lapse on the line
// (an expired challenge, another revoked grant) settles as usual.
// ─────────────────────────────────────────────────────────────────────────────

/** Bounds on the per-row choices: a booker's live holds and events are few. */
export const REVOKE_CHOICES_MAX = 500;

export const revokePlaceBookingGrantInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    placeId: z.uuid(),
    grantId: z.uuid(),
    /** The booker's holds to keep as place holds; every other one releases. */
    keepHoldIds: z.array(z.uuid()).max(REVOKE_CHOICES_MAX).default([]),
    /** The events whose venue confirmation to withdraw; every other one stays. */
    withdrawEventIds: z.array(z.uuid()).max(REVOKE_CHOICES_MAX).default([]),
    /** The place's words to the event owners; required with any withdrawal. */
    withdrawReason: plainTextMultilineRequired(WITHDRAW_REASON_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.withdrawEventIds.length > 0 && value.withdrawReason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["withdrawReason"],
        message: "withdraw_reason_required",
      });
    }
  });

export const GRANT_REVOKE_WITHDRAWAL_OUTCOMES = [
  "withdrawn",
  "already_withdrawn",
  "not_listed",
  "failed",
] as const;

export const revokePlaceBookingGrantOutputSchema = z
  .object({
    grant: placeBookingGrantOutputSchema,
    /** True = the grant was already revoked; no hold was touched. */
    alreadyRevoked: z.boolean(),
    /** Released GRANT_ENDED by this call. */
    released: z.array(bookingHoldOutputSchema),
    /** Kept by this call: now PLACE holds naming the booker. */
    kept: z.array(bookingHoldOutputSchema),
    withdrawals: z.array(
      z
        .object({
          eventId: z.uuid(),
          outcome: z.enum(GRANT_REVOKE_WITHDRAWAL_OUTCOMES),
        })
        .strict(),
    ),
    // ── server-side only (stripped by the wire schema) ──
    notificationIntents: z.array(placeBookingGrantNotificationIntentSchema),
    holdNotificationIntents: z.array(bookingHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
    venueConfirmationIntents: z.array(venueConfirmationNotificationIntentSchema),
  })
  .strict();

/** What transport puts on the wire: intents and routing stay server-side. */
export const revokePlaceBookingGrantWireOutputSchema = z.object(
  revokePlaceBookingGrantOutputSchema.omit({
    notificationIntents: true,
    holdNotificationIntents: true,
    staffRecipientHint: true,
    venueConfirmationIntents: true,
  }).shape,
);

export type RevokePlaceBookingGrantInput = z.input<
  typeof revokePlaceBookingGrantInputSchema
>;
export type RevokePlaceBookingGrantOutput = z.infer<
  typeof revokePlaceBookingGrantOutputSchema
>;
export type RevokePlaceBookingGrantDeps = PlaceBookingGrantDeps & {
  /** The post-commit withdrawal swallow reports here (CLAUDE.md). */
  reportError?: ReporterPort;
};

type WithdrawalOutcome = (typeof GRANT_REVOKE_WITHDRAWAL_OUTCOMES)[number];

export async function revokePlaceBookingGrant(
  deps: RevokePlaceBookingGrantDeps,
  rawInput: unknown,
): Promise<RevokePlaceBookingGrantOutput> {
  const input = parseInput(revokePlaceBookingGrantInputSchema, rawInput);
  const now = deps.clock.now();
  const { repos } = deps;
  const logger = deps.logger?.child({ useCase: "revokePlaceBookingGrant" });

  const { place, ownership } = await requireGrantManager(
    repos,
    input.placeId,
    input.actorHumanId,
  );
  const grant = await requireGrantAtPlace(repos, place.id, input.grantId);
  const placeTz = resolveBookingTimezone(place.timezone);
  const keep = new Set(input.keepHoldIds);

  const staffRecipientHint: BookingHoldStaffRecipientHint = {
    assigneeHumanId: null,
    placedByHumanId: input.actorHumanId,
    orgId:
      (ownership.via === "org" ? ownership.orgId : null) ??
      place.orgIdsWithAccess[0] ??
      null,
    placeId: place.id,
  };

  type TxOutcome = {
    grant: PlaceBookingGrantRecord;
    already: boolean;
    released: BookingHoldRecord[];
    kept: BookingHoldRecord[];
    holdIntents: BookingHoldNotificationIntent[];
  };

  // Revoke does NOT take the place's grant-set lock: it only stamps one row
  // (CAS on revokedAt IS NULL) and never reads the set. A give racing a
  // revoke that returns alreadyGiven for a grant revoked right after is
  // benign: the giver's request matched a live grant when it ran, and the
  // revoke's own releases/notices run regardless.
  const outcome: TxOutcome =
    grant.revokedAt !== null
      ? { grant, already: true, released: [], kept: [], holdIntents: [] }
      : await repos.tx(async (tx): Promise<TxOutcome> => {
          const revoked = await tx.placeBookingGrants.revoke({
            id: grant.id,
            placeId: place.id,
            now,
          });
          if (!revoked) {
            // Lost the CAS: revoked in between (or gone).
            const fresh = await tx.placeBookingGrants.getForPlace({
              id: grant.id,
              placeId: place.id,
            });
            if (!fresh) throw fail("PLACE_BOOKING_GRANT_NOT_FOUND");
            return { grant: fresh, already: true, released: [], kept: [], holdIntents: [] };
          }

          const lockedKeys = lineKeysOf(
            await tx.bookingHolds.listLiveForGrant(grant.id),
          );
          await lockLines(tx, lockedKeys);
          assertLineSetCovered(
            lockedKeys,
            await tx.bookingHolds.listLiveForGrant(grant.id),
          );

          const released: BookingHoldRecord[] = [];
          const kept: BookingHoldRecord[] = [];
          const holdIntents: BookingHoldNotificationIntent[] = [];

          for (const key of lockedKeys) {
            // Lapses first, as every line mutation does; the intents they
            // owe (an expired challenge's act + staff) ride along.
            const settled = await settleLine(tx, {
              ...key,
              now,
              placeTz,
              exemptGrantId: grant.id,
            });
            holdIntents.push(...settled.intents);
            const mine = settled.line.filter(
              (hold) => hold.ownerKind === "BOOKER" && hold.grantId === grant.id,
            );
            let lineLost = false;
            for (const hold of mine) {
              if (keep.has(hold.id)) {
                const converted = await tx.bookingHolds.convertBookerHoldToPlace({
                  id: hold.id,
                  grantId: grant.id,
                });
                if (!converted) continue;
                kept.push(converted);
                await tx.audit.log({
                  entity: "booking_hold",
                  entityId: converted.id,
                  action: "booking_hold.kept_as_place_hold",
                  data: {
                    actorHumanId: input.actorHumanId,
                    grantId: grant.id,
                    holder: converted.holder,
                    reason: "GRANT_ENDED",
                  },
                  at: now,
                });
                continue;
              }
              const row = await releaseHoldCas(tx, hold, {
                reason: "GRANT_ENDED",
                now,
              });
              if (!row) continue;
              released.push(row);
              lineLost = true;
              await tx.audit.log({
                entity: "booking_hold",
                entityId: row.id,
                action: "booking_hold.released",
                data: {
                  actorHumanId: input.actorHumanId,
                  ownerKind: "BOOKER",
                  grantId: grant.id,
                  reason: "GRANT_ENDED",
                  by: "staff",
                },
                at: now,
              });
            }
            if (lineLost) {
              const { moved } = await renumberLine(tx, key);
              holdIntents.push(
                ...(await recordMovers(
                  tx,
                  moved,
                  { humanId: input.actorHumanId, kind: "staff" },
                  now,
                )),
              );
            }
          }

          await tx.audit.log({
            entity: "place_booking_grant",
            entityId: grant.id,
            action: "place_booking_grant.revoked",
            data: {
              actorHumanId: input.actorHumanId,
              placeId: place.id,
              grantee: grant.grantee,
              releasedHoldIds: released.map((h) => h.id),
              keptHoldIds: kept.map((h) => h.id),
              // REQUESTED only: the withdrawals run after commit, each in its
              // own transaction (its own audit row); what each one did is the
              // `place_booking_grant.revoke_withdrawals` row below.
              withdrawEventIdsRequested: input.withdrawEventIds,
            },
            at: now,
          });

          return { grant: revoked, already: false, released, kept, holdIntents };
        });

  // ── After commit: the place's confirmation, per event ────────────────────
  const withdrawals: Array<{ eventId: string; outcome: WithdrawalOutcome }> = [];
  const venueConfirmationIntents: VenueConfirmationNotificationIntent[] = [];
  if (input.withdrawEventIds.length > 0) {
    const listed = new Set(
      (await listEventsConfirmedUnderGrant(repos, { grant: outcome.grant, now })).map(
        (event) => event.id,
      ),
    );
    for (const eventId of [...new Set(input.withdrawEventIds)]) {
      if (!listed.has(eventId)) {
        withdrawals.push({ eventId, outcome: "not_listed" });
        continue;
      }
      try {
        const result = await withdrawVenueConfirmation(
          { repos, clock: deps.clock, logger: deps.logger },
          {
            actorHumanId: input.actorHumanId,
            eventId,
            reason: input.withdrawReason,
          },
        );
        withdrawals.push({
          eventId,
          outcome: result.alreadyWithdrawn ? "already_withdrawn" : "withdrawn",
        });
        venueConfirmationIntents.push(...result.notificationIntents);
      } catch (error) {
        // Deliberate swallow: the grant is revoked and its holds settled;
        // one event's withdrawal failing must not undo or hide that. Visible
        // at error AND reported; retried by revoking again.
        withdrawals.push({ eventId, outcome: "failed" });
        logger?.error("place_booking_grants.revoke.withdraw_failed", {
          grantId: grant.id,
          placeId: place.id,
          eventId,
          err: error,
          error: describeError(error),
        });
        try {
          deps.reportError?.(error, {
            tags: {
              useCase: "revokePlaceBookingGrant",
              step: "withdraw_venue_confirmation",
            },
            extra: { grantId: grant.id, placeId: place.id, eventId },
          });
        } catch {
          // Reporting is best-effort: never change the outcome.
        }
      }
    }
  }

  // What each requested withdrawal DID (applied vs requested, above). Post
  // commit, so a failure to write it is a deliberate swallow: the revoke and
  // the withdrawals stand either way; logged at error and reported.
  if (withdrawals.length > 0) {
    try {
      await repos.audit.log({
        entity: "place_booking_grant",
        entityId: grant.id,
        action: "place_booking_grant.revoke_withdrawals",
        data: {
          actorHumanId: input.actorHumanId,
          placeId: place.id,
          withdrawals,
        },
        at: now,
      });
    } catch (error) {
      logger?.error("place_booking_grants.revoke.withdrawals_audit_failed", {
        grantId: grant.id,
        placeId: place.id,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "revokePlaceBookingGrant",
            step: "withdrawals_audit",
          },
          extra: { grantId: grant.id, placeId: place.id },
        });
      } catch {
        // Reporting is best-effort: never change the outcome.
      }
    }
  }

  const notificationIntents: PlaceBookingGrantNotificationIntent[] = outcome.already
    ? []
    : [
        {
          kind: "grant.revoked",
          grantId: outcome.grant.id,
          placeId: place.id,
          calendarId: outcome.grant.calendarId,
          audience: "grantee",
          grantee: outcome.grant.grantee,
          releasedHolds: outcome.released.map((h) => ({ holdId: h.id, date: h.date })),
          keptHolds: outcome.kept.map((h) => ({ holdId: h.id, date: h.date })),
        },
      ];

  logger?.info("place_booking_grants.revoked", {
    grantId: grant.id,
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    alreadyRevoked: outcome.already,
    released: outcome.released.length,
    kept: outcome.kept.length,
    withdrawals: withdrawals.length,
  });

  return revokePlaceBookingGrantOutputSchema.parse({
    grant: toPlaceBookingGrantOutput(outcome.grant, now),
    alreadyRevoked: outcome.already,
    released: outcome.released.map((h) => toBookingHoldOutput(h, now, placeTz)),
    kept: outcome.kept.map((h) => toBookingHoldOutput(h, now, placeTz)),
    withdrawals,
    notificationIntents,
    holdNotificationIntents: outcome.holdIntents,
    staffRecipientHint,
    venueConfirmationIntents,
  });
}
