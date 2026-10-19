import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { markForSearchReindex } from "../search/search-reindex-marks";

export const withdrawPlaceVerificationInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();

export const withdrawPlaceVerificationOutputSchema = z
  .object({
    requestId: z.string().uuid(),
    placeId: z.string().uuid(),
  })
  .strict();

export type WithdrawPlaceVerificationInput = z.infer<
  typeof withdrawPlaceVerificationInputSchema
>;
export type WithdrawPlaceVerificationOutput = z.infer<
  typeof withdrawPlaceVerificationOutputSchema
>;

export type WithdrawPlaceVerificationDeps = {
  repos: Pick<Repos, "placeVerificationRequests" | "places" | "audit" | "tx">;
  authz: Pick<AuthZPort, "canManagePlace">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Organizer cancels their own PENDING verification request before any
 * platform admin has acknowledged it. Sets status = WITHDRAWN; documents
 * are preserved (orphan cleanup is handled by the cleanup-stale-verification
 * docs job).
 *
 * ── The place's own status must come back with it ────────────────────────────
 * `submitPlaceVerification` flips `Place.verification` to PENDING alongside
 * creating the request. Withdrawing used to update only the request row, which
 * left the place stuck on PENDING forever with no request behind it — and
 * EVERY request affordance in the product gates on
 * `verification === "UNVERIFIED" || "REJECTED"` (the place editor's header
 * button, VerificationSection's trigger, the places-table row action). So a
 * withdraw produced a permanent, self-inflicted lockout: a venue reading
 * "Pending" with no way to ask again, and nothing in the platform queue for a
 * reviewer to act on — while the server would happily have accepted a
 * resubmit. Observed in dev as `history: ["WITHDRAWN","WITHDRAWN"]` with the
 * place still PENDING.
 *
 * The reset is CONDITIONAL on the place currently being PENDING: a VERIFIED
 * place with an open request (legacy rows, or one staff verified while the
 * request was open; submit now refuses a VERIFIED place) must not be demoted
 * by cancelling that request, and a REJECTED one keeps its rejection.
 *
 * Every write commits in one `repos.tx()` under `lockPlaceForClaim` — a
 * half-applied withdraw is exactly the inconsistent state this fixes. The
 * place reset is a compare-and-set of `verification` alone (see
 * {@link resetPendingVerification}), and withdrawing an OWNERSHIP_CLAIM also
 * soft-revokes its provisional ownership (see
 * {@link revokeProvisionalOwnership}).
 */
export async function withdrawPlaceVerification(
  deps: WithdrawPlaceVerificationDeps,
  rawInput: unknown,
): Promise<WithdrawPlaceVerificationOutput> {
  const logger = deps.logger?.child({ useCase: "withdrawPlaceVerification" });

  const execute = async () => {
    const input = parseInput(withdrawPlaceVerificationInputSchema, rawInput);

    const request = await deps.repos.placeVerificationRequests.getById(
      input.requestId,
    );
    if (!request) {
      throw fail("VERIFICATION_REQUEST_NOT_FOUND");
    }

    // Auth: original submitter OR a co-admin of the org that owns the place
    // (any human with manage permission on the place).
    if (request.submittedById !== input.actorHumanId) {
      const access = await deps.authz.canManagePlace({
        actorHumanId: input.actorHumanId,
        placeId: request.placeId,
      });
      if (!access.allowed) {
        throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "request" } });
      }
    }

    if (request.status !== "PENDING") {
      // Already acknowledged, decided, or withdrawn — withdrawal not allowed.
      throw fail("VERIFICATION_NOT_PENDING");
    }

    const now = deps.clock.now();

    await deps.repos.tx(async (tx) => {
      // The claim lock first: the place's verification and the claim's
      // provisional ownership are what claim writers (submit, fast-track,
      // review, dispute transfer) move under it, so the reads below cannot
      // go stale before the writes they decide.
      await tx.places.lockPlaceForClaim(request.placeId);

      const updated = await tx.placeVerificationRequests.withdraw({
        requestId: input.requestId,
      });
      if (!updated) {
        // Race: someone moved it out of PENDING between read and write.
        // Throwing inside the tx rolls back — nothing half-applies.
        throw fail("VERIFICATION_NOT_PENDING");
      }

      const verificationReset = await resetPendingVerification(
        tx,
        request.placeId,
      );
      if (verificationReset) {
        // verification is on the place's search document.
        await markForSearchReindex(
          tx,
          [{ kind: "place", id: request.placeId }],
          now,
        );
      }

      const revokedOwnershipId =
        request.source === "OWNERSHIP_CLAIM" && request.ownershipId
          ? await revokeProvisionalOwnership(tx, request.ownershipId, now)
          : null;

      await tx.audit.log({
        entity: "place_verification_request",
        entityId: input.requestId,
        action: "verification_withdrawn",
        data: {
          withdrawnBy: input.actorHumanId,
          placeId: request.placeId,
          source: request.source,
          ...(verificationReset
            ? { placeVerification: { from: "PENDING", to: "UNVERIFIED" } }
            : {}),
          ...(revokedOwnershipId ? { revokedOwnershipId } : {}),
        },
        at: now,
      });
    });

    return withdrawPlaceVerificationOutputSchema.parse({
      requestId: input.requestId,
      placeId: request.placeId,
    });
  };

  if (logger) {
    return logger.withTime("withdrawPlaceVerification", execute);
  }

  return execute();
}

type WithdrawTx = Pick<Repos, "places">;

/**
 * Hand the place back its request affordance: PENDING → UNVERIFIED, written
 * as a compare-and-set of `verification` alone, from a read taken under the
 * claim lock. Only from PENDING: a VERIFIED place with an open request (a
 * legacy row, or staff verified it while the request waited; submit refuses
 * VERIFIED now) must not be demoted by cancelling it, and REJECTED keeps its
 * rejection. It used to rebuild the whole row from a read taken before the
 * transaction, which undid a moderator's concurrent name/address edit and
 * wrote a NULL street line or country back as "".
 *
 * Returns whether the status moved. A lost CAS means a writer that skips the
 * claim lock (the place editor) moved the row after the read: one now off
 * PENDING is left where it is, the same rule as above; a vanished row is
 * PLACE_NOT_FOUND. A place missing at the read has nothing to reset (the
 * request cascades with its place, so the withdraw CAS above already failed
 * in that case).
 */
async function resetPendingVerification(
  tx: WithdrawTx,
  placeId: string,
): Promise<boolean> {
  const locked = await tx.places.getById(placeId);
  if (!locked || locked.verificationStatus !== "PENDING") return false;

  const { changed } = await tx.places.setVerificationStatus({
    placeId,
    from: "PENDING",
    to: "UNVERIFIED",
  });
  if (changed) return true;

  const current = await tx.places.getById(placeId);
  if (!current) throw fail("PLACE_NOT_FOUND");
  if (current.verificationStatus === "PENDING") {
    // Still PENDING yet the CAS found it elsewhere: it moved and came back
    // between the two statements. Refuse rather than guess.
    throw fail("CONFLICT", {
      meta: { reason: "place_verification_changed", placeId },
    });
  }
  return false;
}

/**
 * A withdrawn claim takes its provisional ownership with it, the same
 * soft-revoke a rejected claim gets in `reviewPlaceVerification`. Without it
 * each withdrawn claim left an unrevoked provisional row behind. Only a row
 * that is still provisional and active is revoked: a VERIFIED one belongs to
 * an owner (never undone by cancelling a request), and a revoked one (a
 * dispute transfer took it) is already gone. Returns the revoked row's id.
 */
async function revokeProvisionalOwnership(
  tx: WithdrawTx,
  ownershipId: string,
  now: Date,
): Promise<string | null> {
  const ownership = await tx.places.getOwnershipById(ownershipId);
  if (!ownership || ownership.revokedAt !== null || ownership.verified) {
    return null;
  }
  await tx.places.revokeOwnership({ ownershipId, revokedAt: now });
  return ownershipId;
}
