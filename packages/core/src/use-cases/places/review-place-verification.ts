import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import type { PlaceOwnershipRecord } from "@th/types/repos/place-verification";

import { parseInput } from "../../lib/io";
import { incrementResourceUsage } from "../quotas/enforce-quota";
import {
  notifyClaimantOfDecision,
  notifyDisputantOfDecision,
  notifyOwnerOfOwnershipTransfer,
} from "./_shared/claim-notifications";
import { z } from "zod";
import { fail } from "@th/errors";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { listCommunityListingsToReindex } from "./_shared/community-listings-to-reindex";

const STAFF_REVIEWER_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];

export const reviewPlaceVerificationInputSchemaBase = z
  .object({
    actorHumanId: z.string().uuid(),
    requestId: z.string().uuid(),
    decision: z.enum(["APPROVED", "REJECTED"]),
    reviewerNotes: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const REVIEWER_NOTES_REFINEMENT = {
  predicate: (v: {
    decision: "APPROVED" | "REJECTED";
    reviewerNotes?: string | null;
  }) =>
    v.decision !== "REJECTED" ||
    (typeof v.reviewerNotes === "string" &&
      v.reviewerNotes.trim().length >= 10),
  options: {
    message: "reviewer_notes_required_for_rejection",
    path: ["reviewerNotes"] as PropertyKey[],
  },
};

export const reviewPlaceVerificationInputSchema =
  reviewPlaceVerificationInputSchemaBase.refine(
    REVIEWER_NOTES_REFINEMENT.predicate,
    REVIEWER_NOTES_REFINEMENT.options,
  );

export const reviewPlaceVerificationOutputSchema = z
  .object({
    requestId: z.string().uuid(),
    decision: z.enum(["APPROVED", "REJECTED"]),
    placeId: z.string().uuid(),
  })
  .strict();

/**
 * What transport puts on the wire. The output owed the unparked notice until
 * parking was removed (amendment 2026-09-25); the wire name stays so
 * transport keeps one name for it.
 */
export const reviewPlaceVerificationWireOutputSchema =
  reviewPlaceVerificationOutputSchema;

export type ReviewPlaceVerificationInput = z.infer<
  typeof reviewPlaceVerificationInputSchema
>;
export type ReviewPlaceVerificationOutput = z.infer<
  typeof reviewPlaceVerificationOutputSchema
>;
export type ReviewPlaceVerificationWireOutput = z.infer<
  typeof reviewPlaceVerificationWireOutputSchema
>;

export type ReviewPlaceVerificationDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "places"
    | "placeVerificationRequests"
    | "placeVerificationDocuments"
    | "audit"
    | "resourceQuotas"
    | "notifications"
  >;
  authz: Pick<AuthZPort, "hasStaffRole">;
  storage: FileStoragePort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports the post-commit swallows: the notices' failures (and a notice
   * whose translation payload could not be stored, claim-notifications.ts),
   * an R2 document delete, and the storage-quota decrement.
   */
  reportError?: ReporterPort;
};

/**
 * Reviews a place verification request (approve or reject).
 *
 * On either decision:
 * 1. Updates the request status + reviewer info.
 * 2. Transitions Place.verification to VERIFIED or REJECTED.
 * 3. Deletes uploaded documents from R2 (best-effort, post-commit).
 * 4. Marks PlaceVerificationDocument.deletedAt.
 * 5. Logs an audit entry.
 *
 * APPROVING an OWNERSHIP_DISPUTE additionally TRANSFERS ownership: every
 * active PlaceOwnership row is soft-revoked and a fresh VERIFIED ownership is
 * installed for the dispute's target identity (place → VERIFIED + listed).
 * REJECTING a dispute records the decision only (no place/ownership mutation).
 *
 * Gated by hasStaffRole(["ADMIN", "REVIEWER"]).
 */
export async function reviewPlaceVerification(
  deps: ReviewPlaceVerificationDeps,
  rawInput: unknown,
): Promise<ReviewPlaceVerificationOutput> {
  const logger = deps.logger?.child({ useCase: "reviewPlaceVerification" });

  const execute = async () => {
    const input = parseInput(reviewPlaceVerificationInputSchema, rawInput);

    // Staff gate
    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...STAFF_REVIEWER_ROLES],
    });
    if (!staff.allowed) {
      throw fail("STAFF_ONLY");
    }

    // Fetch the request
    const request = await deps.repos.placeVerificationRequests.getById(
      input.requestId,
    );
    if (!request) {
      throw fail("VERIFICATION_REQUEST_NOT_FOUND");
    }
    // Reviewable from PENDING (auto-acknowledge) or IN_REVIEW (already claimed).
    if (request.status !== "PENDING" && request.status !== "IN_REVIEW") {
      throw fail("VERIFICATION_REQUEST_ALREADY_DECIDED");
    }
    // If another admin is currently reviewing it, refuse the decision.
    if (
      request.status === "IN_REVIEW" &&
      request.acknowledgedBy &&
      request.acknowledgedBy !== input.actorHumanId
    ) {
      throw fail("VERIFICATION_LOCKED_TO_OTHER_REVIEWER");
    }

    // Fetch the place
    const place = await deps.repos.places.getById(request.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }

    const now = deps.clock.now();
    const isClaim = request.source === "OWNERSHIP_CLAIM";
    const isDispute = request.source === "OWNERSHIP_DISPUTE";
    const isDisputeApproval = isDispute && input.decision === "APPROVED";
    // Every decision that writes the place (all but a dispute REJECT, which
    // never touches it) takes the claim lock and decides from a read taken
    // under it.
    const mutatesPlace = !isDispute || isDisputeApproval;

    // Degenerate legacy dispute rows (null claim target) cannot be approved —
    // there is no identity to transfer ownership TO. Fail BEFORE any mutation.
    if (
      isDisputeApproval &&
      (!request.claimOwnerType || !request.claimOwnerId)
    ) {
      throw fail("DISPUTE_TARGET_OWNER_MISSING", {
        meta: { requestId: input.requestId },
      });
    }

    // Place verification target differs by request source:
    //  - ORG_SUBMISSION: APPROVE → VERIFIED, REJECT → REJECTED (legacy, unchanged).
    //  - OWNERSHIP_CLAIM: APPROVE → VERIFIED, REJECT → UNVERIFIED (revert the
    //    provisional PENDING so the venue is claimable again, not dead-ended).
    //    The revert is ONLY from PENDING (withdraw's rule): a place staff
    //    verified, or rejected, while the claim waited keeps that status;
    //    rejecting someone's claim must not demote it.
    //  - OWNERSHIP_DISPUTE: APPROVE transfers ownership to the disputant and
    //    sets the place VERIFIED (there is now a verified owner); REJECT never
    //    mutates the place.
    const newPlaceStatus =
      input.decision === "APPROVED"
        ? "VERIFIED"
        : isClaim
          ? "UNVERIFIED"
          : "REJECTED";

    // Audit action names distinguish the source so the ownership trail
    // (NFR-002) is greppable.
    const auditAction =
      input.decision === "APPROVED"
        ? isClaim
          ? "place.ownership_claim_approved"
          : isDispute
            ? "place.ownership_dispute_resolved_approved"
            : "verification_approved"
        : isClaim
          ? "place.ownership_claim_rejected"
          : isDispute
            ? "place.ownership_dispute_resolved_rejected"
            : "verification_rejected";

    // All state transitions commit atomically: request decision + ownership
    // stamp/revoke + place verification + doc soft-delete + audit. Without the
    // tx a mid-way throw (e.g. verifyOwnership succeeds, the place write throws)
    // left request=APPROVED + ownership=verified but Place stuck PENDING, with
    // re-review blocked by VERIFICATION_REQUEST_ALREADY_DECIDED — an
    // inconsistent state needing manual repair. R2 delete + quota decrement stay
    // post-commit (external, best-effort).
    const { documents, disputeTransfer } =
      await deps.repos.tx(async (tx) => {
      // Serialize place-writing decisions against concurrent claim writers
      // of the SAME place (e.g. an FR-010 fast-track auto-verify, a claim
      // submit or a dispute transfer racing this review). Must be the FIRST
      // statement in the tx; released on commit/rollback.
      //
      // Taken for EVERY decision that writes the place — legacy
      // ORG_SUBMISSION and rejections included — so no two of them on one
      // place interleave, and the place read just below (the CAS `from`, the
      // consent the FR-006 reset clears) cannot move before the writes.
      if (mutatesPlace) {
        await tx.places.lockPlaceForClaim(request.placeId);
      }
      // The place as it is NOW. `place` above was read before the
      // transaction and only answers "does it exist" and names it in
      // notices; every write below decides from this one.
      const lockedPlace = mutatesPlace
        ? await tx.places.getById(request.placeId)
        : place;
      if (!lockedPlace) {
        throw fail("PLACE_NOT_FOUND");
      }

      // Update request decision
      await tx.placeVerificationRequests.updateDecision({
        requestId: input.requestId,
        status: input.decision,
        reviewerHumanId: input.actorHumanId,
        reviewerNotes: input.reviewerNotes ?? null,
        reviewedAt: now,
      });

      // ── Ownership transitions for claim requests (FR-007) ──────────────────
      if (isClaim && request.ownershipId) {
        if (input.decision === "APPROVED") {
          // A stale claim whose provisional row was revoked (e.g. by an
          // approved dispute transfer) must NOT be resurrectable as a
          // verified co-owner. Surface a clear conflict for the admin; the
          // adapter's conditional verifyOwnership is the racing backstop.
          const ownership = await tx.places.getOwnershipById(
            request.ownershipId,
          );
          if (!ownership || ownership.revokedAt !== null) {
            throw fail("PLACE_ALREADY_CLAIMED", {
              meta: {
                requestId: input.requestId,
                ownershipId: request.ownershipId,
              },
            });
          }
          // Reviewer stamp: flip the provisional ownership to verified.
          await tx.places.verifyOwnership({
            ownershipId: request.ownershipId,
            reviewerHumanId: input.actorHumanId,
            reviewedAt: now,
          });
        } else {
          // Soft-revoke the provisional ownership — fully undoes provisional
          // access (NFR-003), leaving no dangling owner and no listed side effect.
          await tx.places.revokeOwnership({
            ownershipId: request.ownershipId,
            revokedAt: now,
          });
        }
      }

      // ── Ownership transfer for APPROVED disputes ────────────────────────────
      // The dispute approval declares the disputant the rightful owner:
      // soft-revoke EVERY active ownership row (verified + provisional — a
      // deliberate admin transfer, co-ownership notwithstanding), then install
      // a fresh VERIFIED ownership for the dispute's target identity.
      let transfer: {
        revokedOwnerships: PlaceOwnershipRecord[];
        newOwnership: PlaceOwnershipRecord;
      } | null = null;
      if (isDisputeApproval && request.claimOwnerType && request.claimOwnerId) {
        const active = await tx.places.listActiveOwnershipsForPlace(lockedPlace.id);
        for (const ownership of active) {
          await tx.places.revokeOwnership({
            ownershipId: ownership.id,
            revokedAt: now,
          });
        }
        const newOwnership = await tx.places.createVerifiedOwnership({
          placeId: lockedPlace.id,
          ownerType: request.claimOwnerType,
          ownerId: request.claimOwnerId,
          reviewerHumanId: input.actorHumanId,
          reviewedAt: now,
          proof: { kind: "ownership_dispute", requestId: input.requestId },
        });
        transfer = {
          // If the disputant already held a row, createVerifiedOwnership
          // re-verified that SAME row — exclude it from the "revoked" set so
          // the audit trail + owner notifications reflect reality.
          revokedOwnerships: active.filter((o) => o.id !== newOwnership.id),
          newOwnership,
        };
      }

      // ── FR-006: revocation resets community-listing consent ───────────────
      // `Place.acceptsCommunityListings` is a STANDING consent read live by
      // `isVenueConfirmed`, so while it is true every community listing at the
      // place renders as venue-confirmed AND occupies its slot for booking
      // availability. Unowned — or newly re-owned — consent is exactly the
      // state the model exists to prevent (spec ruling
      // `revocation_reverts_to_address_only`), so it must not outlive the
      // owner who gave it. Computed HERE from the under-lock read and applied
      // just below, so the reset commits in the SAME transaction as the
      // revocation.
      //
      // Two revoking paths, and they differ:
      //   · DISPUTE TRANSFER — every active ownership is revoked and a fresh
      //     verified ownership is installed for a DIFFERENT identity. The
      //     place still has an owner, but it is not the one who consented, and
      //     an owner inheriting a venue must opt in themselves. Always reset.
      //   · CLAIM REJECTION — a PROVISIONAL row is revoked. A provisional
      //     owner could never have set the flag (the toggle requires a
      //     verified owner on a VERIFIED place), so a blanket reset here would
      //     clear a legitimate CO-OWNER's consent because an unrelated claim
      //     was turned down. Reset only when the revocation leaves the place
      //     with no verified owner at all.
      //
      // Listings are NOT deleted, unlinked, or orphaned by this — they revert
      // to rendering address-only and stay in the community.
      let resetCommunityListingConsent = false;
      if (lockedPlace.acceptsCommunityListings) {
        if (transfer !== null) {
          resetCommunityListingConsent = true;
        } else if (
          isClaim &&
          input.decision !== "APPROVED" &&
          request.ownershipId
        ) {
          const stillActive = await tx.places.listActiveOwnershipsForPlace(
            lockedPlace.id,
          );
          resetCommunityListingConsent = !stillActive.some((o) => o.verified);
        }
      }

      // Update place verification status — approved disputes now mutate the
      // place like claim approvals do (there is a verified owner); dispute
      // REJECTS still never touch the place. Approve also lists the place in
      // the directory so verified venues appear without a separate step.
      //
      // NOTE both revoking paths reach this block: a claim rejection is not a
      // dispute (`!isDispute`), and a dispute transfer is `isDisputeApproval`.
      // A dispute REJECTION revokes nothing, so skipping the block there
      // cannot strand a reset.
      //
      // Each column moves on its own compare-and-set. This used to rebuild
      // the whole row through `places.upsert` from the read taken before the
      // transaction, which undid a moderator's concurrent name/address edit
      // and wrote a NULL street line or country back as "".
      let placeWrites: PlaceWrites = {
        verificationChanged: false,
        listed: false,
        consentReset: false,
      };
      if (mutatesPlace) {
        placeWrites = await writeReviewedPlace(tx, {
          lockedPlace,
          to: newPlaceStatus,
          // A claim rejection reverts the provisional PENDING and nothing
          // else; every other decision writes its target from any status.
          onlyFromPending: isClaim && input.decision !== "APPROVED",
          list: input.decision === "APPROVED",
          resetCommunityListingConsent,
          requestId: input.requestId,
          actorHumanId: input.actorHumanId,
          now,
        });
      }

      // Soft-delete documents (return them for post-commit R2 cleanup).
      const docs = await tx.placeVerificationDocuments.listByRequestId(
        input.requestId,
      );
      await tx.placeVerificationDocuments.markDeleted({
        requestId: input.requestId,
        deletedAt: now,
      });

      await tx.audit.log({
        entity: "place_verification_request",
        entityId: input.requestId,
        action: auditAction,
        data: {
          placeId: lockedPlace.id,
          source: request.source,
          ownershipId: request.ownershipId,
          claimantHumanId: request.claimantHumanId,
          reviewerHumanId: input.actorHumanId,
          reviewerNotes: input.reviewerNotes ?? null,
          decision: input.decision,
          ...(placeWrites.verificationChanged
            ? {
                placeVerification: {
                  from: lockedPlace.verificationStatus,
                  to: newPlaceStatus,
                },
              }
            : {}),
          ...(placeWrites.consentReset
            ? { communityListingConsentReset: true }
            : {}),
          ...(transfer
            ? {
                revokedOwnershipIds: transfer.revokedOwnerships.map(
                  (o) => o.id,
                ),
                newOwnershipId: transfer.newOwnership.id,
                newOwnerType: transfer.newOwnership.ownerType,
                newOwnerId: transfer.newOwnership.ownerId,
              }
            : {}),
        },
        at: now,
      });

      // verification and listed_in_directory are on the place's search
      // document; nothing else this decision writes is.
      if (placeWrites.verificationChanged || placeWrites.listed) {
        await markForSearchReindex(tx, [{ kind: "place", id: lockedPlace.id }], now);
      }
      // The consent reset moves the venue confirmation stamped into each
      // COMMUNITY listing's event document: mark those listings in this
      // transaction, like the owner switch does (the drain reindexes them).
      if (placeWrites.consentReset) {
        const listingIds = await listCommunityListingsToReindex(
          tx.events,
          lockedPlace.id,
          now,
        );
        await markForSearchReindex(
          tx,
          listingIds.map((id) => ({ kind: "event" as const, id })),
          now,
        );
      }

      return {
        documents: docs,
        disputeTransfer: transfer,
      };
    });

    // Best-effort: delete documents from R2 (post-commit, non-fatal)
    let reclaimedBytes = 0n;
    for (const doc of documents) {
      if (doc.deletedAt) continue; // already cleaned up
      try {
        await deps.storage.deleteObject({ key: doc.storageKey });
        reclaimedBytes += BigInt(doc.sizeBytes);
      } catch (err) {
        logger?.warn("r2_delete_failed", {
          requestId: input.requestId,
          storageKey: doc.storageKey,
          error: String(err),
        });
        // `warn` never reaches Sentry; an orphaned document must.
        reportSwallowed(deps, err, "r2_delete", {
          requestId: input.requestId,
          storageKey: doc.storageKey,
        });
      }
    }

    // Reclaim org storage quota for successfully deleted documents.
    if (reclaimedBytes > 0n && request.orgId) {
      try {
        await incrementResourceUsage(deps.repos as any, {
          subjectType: "ORG",
          subjectId: request.orgId,
          kind: "STORAGE_BYTES_ORG",
          delta: -reclaimedBytes,
        });
      } catch (err) {
        logger?.warn("storage_quota_decrement_failed", {
          requestId: input.requestId,
          orgId: request.orgId,
          reclaimedBytes: reclaimedBytes.toString(),
          error: String(err),
        });
        reportSwallowed(deps, err, "storage_quota_decrement", {
          requestId: input.requestId,
          orgId: request.orgId,
          reclaimedBytes: reclaimedBytes.toString(),
        });
      }
    }

    // Best-effort, post-commit: tell the claimant the outcome (FR-007).
    if (isClaim && request.claimantHumanId) {
      await notifyClaimantOfDecision(
        {
          repos: { notifications: deps.repos.notifications },
          logger,
          reportError: deps.reportError,
        },
        {
          claimantHumanId: request.claimantHumanId,
          placeId: place.id,
          placeName: place.name,
          decision: input.decision,
          reviewerNotes: input.reviewerNotes ?? null,
        },
      );
    }

    // Best-effort, post-commit: dispute outcome → disputant (both decisions),
    // and — on an approved transfer — each previous HUMAN owner whose
    // ownership was revoked. Org-owner member fan-out is deferred, mirroring
    // notifyOwnerOfDispute (admins already have the audit trail).
    if (isDispute && request.claimantHumanId) {
      await notifyDisputantOfDecision(
        {
          repos: { notifications: deps.repos.notifications },
          logger,
          reportError: deps.reportError,
        },
        {
          disputantHumanId: request.claimantHumanId,
          placeId: place.id,
          placeName: place.name,
          decision: input.decision,
          reviewerNotes: input.reviewerNotes ?? null,
        },
      );
    }
    if (disputeTransfer) {
      for (const revoked of disputeTransfer.revokedOwnerships) {
        if (revoked.ownerType !== "HUMAN") continue; // org fan-out deferred
        if (revoked.ownerId === request.claimantHumanId) continue; // self
        await notifyOwnerOfOwnershipTransfer(
          {
            repos: { notifications: deps.repos.notifications },
            logger,
            reportError: deps.reportError,
          },
          {
            ownerHumanId: revoked.ownerId,
            placeId: place.id,
            placeName: place.name,
            requestId: input.requestId,
          },
        );
      }
    }

    return reviewPlaceVerificationOutputSchema.parse({
      requestId: input.requestId,
      decision: input.decision,
      placeId: place.id,
    });
  };

  if (logger) {
    return logger.withTime("reviewPlaceVerification", execute);
  }

  return execute();
}

type PlaceWrites = {
  /** `verification` moved to the decision's target. */
  verificationChanged: boolean;
  /** `listedInDirectory` moved false → true. */
  listed: boolean;
  /** `acceptsCommunityListings` moved true → false (FR-006). */
  consentReset: boolean;
};

type ReviewTx = Parameters<Parameters<Repos["tx"]>[0]>[0];

/**
 * The decision's place writes, each a compare-and-set of one column, all
 * deciding from `lockedPlace` (read under `lockPlaceForClaim`):
 *
 *  - `verification` → `to`, from the under-lock value. Already at `to` is
 *    no write; with `onlyFromPending`, anything but PENDING is no write. A lost CAS means a writer that skips the claim lock (the
 *    place editor) moved the row after the read: already at `to` is the
 *    outcome asked for, a vanished row is PLACE_NOT_FOUND, anything else is
 *    CONFLICT and the whole decision rolls back.
 *  - on approve, `listedInDirectory` → true, audited as
 *    `place.directory_listed` (the shape `setPlaceDirectoryListing` writes)
 *    when it moved; `changed: false` means it already was listed.
 *  - the FR-006 consent reset, `acceptsCommunityListings` → false, when
 *    the caller decided one is owed.
 */
async function writeReviewedPlace(
  tx: ReviewTx,
  args: {
    lockedPlace: NonNullable<Awaited<ReturnType<Repos["places"]["getById"]>>>;
    to: "VERIFIED" | "UNVERIFIED" | "REJECTED";
    /** Write `to` only when the under-lock status is PENDING. */
    onlyFromPending: boolean;
    list: boolean;
    resetCommunityListingConsent: boolean;
    requestId: string;
    actorHumanId: string;
    now: Date;
  },
): Promise<PlaceWrites> {
  const { lockedPlace, to } = args;
  const placeId = lockedPlace.id;

  let verificationChanged = false;
  const writesVerification = args.onlyFromPending
    ? lockedPlace.verificationStatus === "PENDING"
    : lockedPlace.verificationStatus !== to;
  if (writesVerification) {
    const { changed } = await tx.places.setVerificationStatus({
      placeId,
      from: lockedPlace.verificationStatus,
      to,
    });
    if (!changed) {
      const current = await tx.places.getById(placeId);
      if (!current) throw fail("PLACE_NOT_FOUND");
      // With `onlyFromPending`, a row a lock-skipping writer moved off
      // PENDING is left where it is, by the same rule; one still PENDING
      // moved and came back, so refuse.
      const settled = args.onlyFromPending
        ? current.verificationStatus !== "PENDING"
        : current.verificationStatus === to;
      if (!settled) {
        throw fail("CONFLICT", {
          meta: {
            reason: "place_verification_changed",
            placeId,
            expected: lockedPlace.verificationStatus,
          },
        });
      }
    }
    verificationChanged = changed;
  }

  let listed = false;
  if (args.list) {
    ({ changed: listed } = await tx.places.setDirectoryListing({
      placeId,
      listedInDirectory: true,
    }));
    if (listed) {
      await tx.audit.log({
        entity: "place",
        entityId: placeId,
        action: "place.directory_listed",
        data: {
          previous: false,
          next: true,
          reason: "verification_review_approved",
          requestId: args.requestId,
          actorHumanId: args.actorHumanId,
        },
        at: args.now,
      });
    }
  }

  let consentReset = false;
  if (args.resetCommunityListingConsent) {
    ({ changed: consentReset } =
      await tx.places.setCommunityListingAcceptance({
        placeId,
        accepts: false,
      }));
  }

  return { verificationChanged, listed, consentReset };
}

/**
 * Report a post-commit swallow. Guarded: a throwing reporter must never turn
 * a best-effort cleanup into a failed review.
 */
function reportSwallowed(
  deps: Pick<ReviewPlaceVerificationDeps, "reportError">,
  err: unknown,
  op: "r2_delete" | "storage_quota_decrement",
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(err, {
      tags: { useCase: "reviewPlaceVerification", op },
      extra,
    });
  } catch {
    // Reporting is best-effort.
  }
}
