import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { ContentFilterPort } from "@th/ports/content-filter";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { communityModeratorApplicationRecordSchema } from "@th/schema";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";

import { parseInput } from "../../lib/io";

/**
 * FR-010 (community-managed-event-listings spec): a signed-in user applies to
 * become a COMMUNITY_MODERATOR (≈ Wikipedia RfA). Lands PENDING; platform
 * ADMIN reviews via review-moderator-application.
 *
 * Guards:
 *  - already holds COMMUNITY_MODERATOR → CONFLICT (meta.reason
 *    "already_moderator"). MODERATOR_APPLICATION_ALREADY_PENDING would be a
 *    lie (there is no pending application), so we use the generic
 *    user-facing 409 code with a machine-readable reason instead of minting
 *    a new AppErrorCode for a state the UI should simply not offer.
 *  - an open PENDING application exists → MODERATOR_APPLICATION_ALREADY_PENDING
 *    (one open application at a time).
 */

export const applyToBeModeratorInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    statement: plainTextMultilineOptional(2000).optional(),
  })
  .strict();

export const applyToBeModeratorOutputSchema = z
  .object({
    application: communityModeratorApplicationRecordSchema,
  })
  .strict();

export type ApplyToBeModeratorInput = z.infer<
  typeof applyToBeModeratorInputSchema
>;
export type ApplyToBeModeratorOutput = z.infer<
  typeof applyToBeModeratorOutputSchema
>;

export type ApplyToBeModeratorDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  contentFilter: ContentFilterPort;
  logger?: LoggerPort;
};

export async function applyToBeModerator(
  deps: ApplyToBeModeratorDeps,
  rawInput: unknown,
): Promise<ApplyToBeModeratorOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "applyToBeModerator" });

  const execute = async (): Promise<ApplyToBeModeratorOutput> => {
    const input = parseInput(applyToBeModeratorInputSchema, rawInput);
    const statement = normalizeOptionalStatement(input.statement);

    // Already a moderator — nothing to apply for.
    const alreadyModerator = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["COMMUNITY_MODERATOR"],
      // Asks whether the role is held, to refuse a second application; a
      // moderator with no second factor enrolled is still a moderator.
      allowWithoutSecondFactor: true,
    });
    if (alreadyModerator.allowed) {
      throw fail("CONFLICT", { meta: { reason: "already_moderator" } });
    }

    if (statement) {
      if (await deps.contentFilter.hasBlockedContent({ text: statement })) {
        throw fail("INVALID_INPUT", {
          meta: { field: "statement", reason: "blocked_content" },
        });
      }
    }

    const application = await deps.repos.tx(async (tx) => {
      const pending =
        await tx.communityModeratorApplications.findPendingByApplicant(
          input.actorHumanId,
        );
      if (pending) {
        throw fail("MODERATOR_APPLICATION_ALREADY_PENDING");
      }

      const created = await tx.communityModeratorApplications.create({
        applicantHumanId: input.actorHumanId,
        statement,
      });

      await tx.audit.log({
        entity: "community_moderator_application",
        entityId: created.id,
        action: "moderator_application.created",
        data: {
          actorHumanId: input.actorHumanId,
          hasStatement: statement !== null,
        },
        at: deps.clock.now(),
      });

      return created;
    });

    return applyToBeModeratorOutputSchema.parse({ application });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("applyToBeModerator", execute);
  }

  return execute();
}

function normalizeOptionalStatement(
  statement: string | undefined,
): string | null {
  if (!statement) return null;
  const normalized = statement.normalize("NFKC").trim();
  return normalized.length > 0 ? normalized : null;
}
