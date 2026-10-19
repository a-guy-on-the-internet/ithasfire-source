import { z } from "zod";

import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const STAFF_REVIEWER_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];

export const releasePlaceVerificationInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();

export const releasePlaceVerificationOutputSchema = z
  .object({
    requestId: z.string().uuid(),
  })
  .strict();

export type ReleasePlaceVerificationInput = z.infer<
  typeof releasePlaceVerificationInputSchema
>;
export type ReleasePlaceVerificationOutput = z.infer<
  typeof releasePlaceVerificationOutputSchema
>;

export type ReleasePlaceVerificationDeps = {
  repos: Pick<Repos, "placeVerificationRequests" | "audit">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Drops an IN_REVIEW lock back to PENDING so another platform admin can pick
 * up the request. Only the acknowledger (or any ADMIN) can release.
 */
export async function releasePlaceVerification(
  deps: ReleasePlaceVerificationDeps,
  rawInput: unknown,
): Promise<ReleasePlaceVerificationOutput> {
  const logger = deps.logger?.child({ useCase: "releasePlaceVerification" });

  const execute = async () => {
    const input = parseInput(releasePlaceVerificationInputSchema, rawInput);

    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...STAFF_REVIEWER_ROLES],
    });
    if (!staff.allowed) {
      throw fail("STAFF_ONLY");
    }

    const request = await deps.repos.placeVerificationRequests.getById(
      input.requestId,
    );
    if (!request) {
      throw fail("VERIFICATION_REQUEST_NOT_FOUND");
    }

    if (request.status !== "IN_REVIEW") {
      throw fail("VERIFICATION_NOT_IN_REVIEW");
    }

    // Only the acknowledger (or an ADMIN) can release the lock. REVIEWER
    // role cannot steal another reviewer's claim.
    const isAcknowledger = request.acknowledgedBy === input.actorHumanId;
    if (!isAcknowledger) {
      const adminCheck = await deps.authz.hasStaffRole({
        actorHumanId: input.actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (!adminCheck.allowed) {
        throw fail("NOT_LOCK_HOLDER");
      }
    }

    const released = await deps.repos.placeVerificationRequests.release({
      requestId: input.requestId,
    });
    if (!released) {
      throw fail("VERIFICATION_NOT_IN_REVIEW");
    }

    const now = deps.clock.now();
    await deps.repos.audit.log({
      entity: "place_verification_request",
      entityId: input.requestId,
      action: "verification_released",
      data: {
        releasedBy: input.actorHumanId,
        previousAcknowledger: request.acknowledgedBy,
      },
      at: now,
    });

    return releasePlaceVerificationOutputSchema.parse({
      requestId: input.requestId,
    });
  };

  if (logger) {
    return logger.withTime("releasePlaceVerification", execute);
  }

  return execute();
}
