import { z } from "zod";

import type { PlaceBookingGrantRecord } from "@th/ports/repos/place-booking-grants";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";
import {
  grantStatusAt,
  granteeGrantOutputSchema,
  toGranteeGrantOutput,
  type PlaceBookingGrantDeps,
} from "./_shared/grant-context";
import {
  placeBookingGrantNotificationIntentSchema,
  type PlaceBookingGrantNotificationIntent,
} from "./_shared/grant-intents";

// ─────────────────────────────────────────────────────────────────────────────
// respondToPlaceBookingGrant (holds-without-a-request FR-003, H4).
//
// WHO ANSWERS (H4): for a person grant, the person; for an org grant, an
// OWNER or ADMIN of the grantee org. "The same rule d6d492261 set for org
// members and delegates": nobody is signed up for something without saying
// yes themselves. So a person's DELEGATE does not answer for them. A
// delegate acts under the grant once the person has accepted it (H2), but
// the yes is the person's. An org EDITOR / VIEWER does not answer either;
// editors act under an accepted org grant (H2) without deciding to take it.
//
// GRANTEE-SCOPED READS AND WRITES: the grant is read with `getForGrantee`
// over exactly the parties above, so another party's grant (another place's,
// another org's, a person's grant to someone else) reads
// PLACE_BOOKING_GRANT_NOT_FOUND, the same as a missing id, and the repo's
// accept / decline carry the same sets into their CAS.
//
// REFUSED: a revoked grant, or a pending grant past its expiry
// (PLACE_BOOKING_GRANT_ENDED, `meta.reason`). An expired pending grant can
// never become active, so accepting it would say yes to nothing.
//
// IDEMPOTENT: accepting an accepted grant or declining a declined one
// returns it (`alreadyAnswered: true`), nothing written or sent; the other
// answer after one was given is PLACE_BOOKING_GRANT_NOT_PENDING. A lost CAS
// race is re-read and answered the same way.
//
// NOTICE (FR-013): grant accepted / declined → the staff member who gave it,
// in-app.
// ─────────────────────────────────────────────────────────────────────────────

export const respondToPlaceBookingGrantInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    grantId: z.uuid(),
    answer: z.enum(["accept", "decline"]),
  })
  .strict();

export const respondToPlaceBookingGrantOutputSchema = z
  .object({
    grant: granteeGrantOutputSchema,
    /** True = this answer was already on the grant; nothing written or sent. */
    alreadyAnswered: z.boolean(),
    notificationIntents: z.array(placeBookingGrantNotificationIntentSchema),
  })
  .strict();

/** What transport puts on the wire: the intents stay server-side. */
export const respondToPlaceBookingGrantWireOutputSchema = z.object(
  respondToPlaceBookingGrantOutputSchema.omit({ notificationIntents: true })
    .shape,
);

export type RespondToPlaceBookingGrantInput = z.infer<
  typeof respondToPlaceBookingGrantInputSchema
>;
export type RespondToPlaceBookingGrantOutput = z.infer<
  typeof respondToPlaceBookingGrantOutputSchema
>;
export type RespondToPlaceBookingGrantDeps = PlaceBookingGrantDeps;

function isRepoShape(error: unknown, code: string, message: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code &&
    (error as { message?: unknown }).message === message
  );
}

export async function respondToPlaceBookingGrant(
  deps: RespondToPlaceBookingGrantDeps,
  rawInput: unknown,
): Promise<RespondToPlaceBookingGrantOutput> {
  const input = parseInput(respondToPlaceBookingGrantInputSchema, rawInput);
  const now = deps.clock.now();
  const { repos } = deps;

  // Who may answer for the actor: the actor as a person, and every org where
  // the actor is OWNER / ADMIN. Never a principal through a delegation.
  const adminMemberships = await repos.authz.listOrgMembershipsByHumanId({
    humanId: input.actorHumanId,
    roles: [...ORG_ADMIN_ROLES],
  });
  const parties = {
    humanIds: [input.actorHumanId],
    orgIds: [
      ...new Set(
        adminMemberships
          .filter((m) => ORG_ADMIN_ROLES.includes(m.role))
          .map((m) => m.orgId),
      ),
    ],
  };

  const grant = await repos.placeBookingGrants.getForGrantee({
    id: input.grantId,
    ...parties,
  });
  if (!grant) throw fail("PLACE_BOOKING_GRANT_NOT_FOUND");

  const wanted = input.answer === "accept" ? "acceptedAt" : "declinedAt";
  const settled = (row: PlaceBookingGrantRecord) =>
    answerOutcome(row, wanted, now);

  const before = settled(grant);
  if (before !== "pending") {
    if (before === "same") return already(grant, now);
    throw refusal(before, grant.id);
  }

  let answered: PlaceBookingGrantRecord;
  try {
    answered = await repos.tx(async (tx) => {
      const row =
        input.answer === "accept"
          ? await tx.placeBookingGrants.accept({ id: grant.id, ...parties, now })
          : await tx.placeBookingGrants.decline({ id: grant.id, ...parties, now });
      await tx.audit.log({
        entity: "place_booking_grant",
        entityId: row.id,
        action:
          input.answer === "accept"
            ? "place_booking_grant.accepted"
            : "place_booking_grant.declined",
        data: {
          actorHumanId: input.actorHumanId,
          placeId: row.placeId,
          grantee: row.grantee,
        },
        at: now,
      });
      return row;
    });
  } catch (error) {
    if (isRepoShape(error, "not_found", "place_booking_grant_not_found")) {
      throw fail("PLACE_BOOKING_GRANT_NOT_FOUND");
    }
    if (isRepoShape(error, "conflict", "place_booking_grant_not_pending")) {
      // Lost the CAS: someone answered (or revoked) in between. Re-read and
      // answer as if that had happened first.
      const fresh = await repos.placeBookingGrants.getForGrantee({
        id: grant.id,
        ...parties,
      });
      if (!fresh) throw fail("PLACE_BOOKING_GRANT_NOT_FOUND");
      const outcome = settled(fresh);
      if (outcome === "same") return already(fresh, now);
      throw refusal(outcome === "pending" ? "other" : outcome, fresh.id);
    }
    throw error;
  }

  const intents: PlaceBookingGrantNotificationIntent[] = [
    {
      kind: input.answer === "accept" ? "grant.accepted" : "grant.declined",
      grantId: answered.id,
      placeId: answered.placeId,
      calendarId: answered.calendarId,
      audience: "granter",
      granterHumanId: answered.grantedByHumanId,
    },
  ];

  deps.logger?.info("place_booking_grants.answered", {
    grantId: answered.id,
    placeId: answered.placeId,
    actorHumanId: input.actorHumanId,
    answer: input.answer,
  });

  return respondToPlaceBookingGrantOutputSchema.parse({
    grant: toGranteeGrantOutput(answered, now),
    alreadyAnswered: false,
    notificationIntents: intents,
  });
}

type AnswerOutcome = "pending" | "same" | "other" | "revoked" | "expired";

/**
 * Where a grant stands against the wanted answer: still pending (and not
 * expired), already carrying this answer (`same`), carrying the other one,
 * revoked, or a pending grant past its expiry.
 */
function answerOutcome(
  grant: PlaceBookingGrantRecord,
  wanted: "acceptedAt" | "declinedAt",
  now: Date,
): AnswerOutcome {
  if (grant.revokedAt !== null) return "revoked";
  if (grant[wanted] !== null) return "same";
  if (grant.acceptedAt !== null || grant.declinedAt !== null) return "other";
  return grantStatusAt(grant, now) === "expired" ? "expired" : "pending";
}

function already(
  grant: PlaceBookingGrantRecord,
  now: Date,
): RespondToPlaceBookingGrantOutput {
  return respondToPlaceBookingGrantOutputSchema.parse({
    grant: toGranteeGrantOutput(grant, now),
    alreadyAnswered: true,
    notificationIntents: [],
  });
}

function refusal(
  outcome: Exclude<AnswerOutcome, "pending" | "same">,
  grantId: string,
): unknown {
  if (outcome === "other") {
    return fail("PLACE_BOOKING_GRANT_NOT_PENDING", { meta: { grantId } });
  }
  return fail("PLACE_BOOKING_GRANT_ENDED", {
    meta: { grantId, reason: outcome },
  });
}
