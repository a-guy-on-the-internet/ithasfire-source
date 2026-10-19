import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { communityModeratorApplicationRecordSchema } from "@th/schema";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

/**
 * FR-010 (community-managed-event-listings spec): platform ADMIN reviews a
 * CommunityModeratorApplication. APPROVE grants the COMMUNITY_MODERATOR
 * HumanRole + audits it. Mirrors reviewCategoryRequest (claim guard →
 * markReviewed → audit, one repos.tx).
 *
 * grantHumanRole returns `{granted:false}` AMBIGUOUSLY for both "role already
 * held" and "human does not exist" — so the applicant human is verified to
 * exist FIRST (the documented calling pattern). After that check,
 * `granted:false` can only mean already-held, which is a benign idempotent
 * outcome (e.g. role granted out-of-band between apply and review).
 */

export const reviewModeratorApplicationInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    applicationId: z.uuid(),
    decision: z.enum(["APPROVE", "REJECT"]),
    reviewNote: plainTextMultilineOptional(1000).optional(),
  })
  .strict();

export const reviewModeratorApplicationOutputSchema = z
  .object({
    application: communityModeratorApplicationRecordSchema,
  })
  .strict();

export type ReviewModeratorApplicationInput = z.infer<
  typeof reviewModeratorApplicationInputSchema
>;
export type ReviewModeratorApplicationOutput = z.infer<
  typeof reviewModeratorApplicationOutputSchema
>;

export type ReviewModeratorApplicationDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function reviewModeratorApplication(
  deps: ReviewModeratorApplicationDeps,
  rawInput: unknown,
): Promise<ReviewModeratorApplicationOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "reviewModeratorApplication",
  });

  const execute = async (): Promise<ReviewModeratorApplicationOutput> => {
    const input = parseInput(reviewModeratorApplicationInputSchema, rawInput);
    const reviewNote = input.reviewNote ?? null;

    // Moderator applications are reviewed by platform ADMIN only (spec
    // decision: single-tier moderation, admin-gated RfA review page).
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN"],
    });

    const application = await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();

      const existing = await tx.communityModeratorApplications.getById(
        input.applicationId,
      );
      if (!existing) {
        throw fail("MODERATOR_APPLICATION_NOT_FOUND");
      }
      if (existing.status !== "PENDING") {
        throw fail("MODERATOR_APPLICATION_ALREADY_REVIEWED");
      }

      // APPROVE only: verify the applicant exists BEFORE claiming/granting —
      // see module doc comment on grantHumanRole's ambiguous `granted:false`.
      // REJECT deliberately skips this guard: a dangling applicant (deleted
      // human) must still be REJECTable, otherwise the row is stuck PENDING
      // forever.
      if (input.decision === "APPROVE") {
        const applicant = await tx.humans.getById(existing.applicantHumanId);
        if (!applicant) {
          throw fail("HUMAN_NOT_FOUND", {
            meta: { humanId: existing.applicantHumanId },
          });
        }
      }

      const claimed = await tx.communityModeratorApplications.claimPendingForReview(
        {
          id: existing.id,
          reviewedByHumanId: input.actorHumanId,
          reviewedAt: now,
        },
      );
      if (!claimed) {
        throw fail("MODERATOR_APPLICATION_ALREADY_REVIEWED");
      }

      let granted = false;
      if (input.decision === "APPROVE") {
        // Applicant existence asserted above, so granted:false here can only
        // mean the role was already held — an acceptable idempotent outcome.
        const grantResult = await tx.authz.grantHumanRole({
          humanId: existing.applicantHumanId,
          role: "COMMUNITY_MODERATOR",
        });
        granted = grantResult.granted;
      }

      const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
      const reviewed = await tx.communityModeratorApplications.markReviewed({
        id: existing.id,
        status,
        reviewedByHumanId: input.actorHumanId,
        reviewedAt: now,
        reviewNote,
      });

      await tx.audit.log({
        entity: "community_moderator_application",
        entityId: existing.id,
        action: "moderator_application.reviewed",
        data: {
          actorHumanId: input.actorHumanId,
          applicantHumanId: existing.applicantHumanId,
          decision: input.decision,
          status,
          reviewNote,
          granted,
        },
        at: now,
      });

      return reviewed;
    });

    return reviewModeratorApplicationOutputSchema.parse({ application });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("reviewModeratorApplication", execute);
  }

  return execute();
}
