import { z } from "zod";

import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const STAFF_REVIEWER_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];

export const acknowledgePlaceVerificationInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();

export const acknowledgePlaceVerificationOutputSchema = z
  .object({
    requestId: z.string().uuid(),
    acknowledgedBy: z.string().uuid(),
    acknowledgedAt: z.date(),
    /** True when the actor was the one who acquired the lock just now. */
    claimed: z.boolean(),
    /** When `claimed` is false, the human currently holding the lock. */
    lockedBy: z
      .object({ humanId: z.string().uuid(), name: z.string().nullable() })
      .nullable(),
  })
  .strict();

export type AcknowledgePlaceVerificationInput = z.infer<
  typeof acknowledgePlaceVerificationInputSchema
>;
export type AcknowledgePlaceVerificationOutput = z.infer<
  typeof acknowledgePlaceVerificationOutputSchema
>;

export type AcknowledgePlaceVerificationDeps = {
  repos: Pick<Repos, "placeVerificationRequests" | "audit" | "humans">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Platform admin claims a PENDING verification request and starts review.
 * Atomic: only PENDING → IN_REVIEW transitions succeed. If the request is
 * already IN_REVIEW (held by anyone, including this admin), returns the
 * current lock holder with `claimed: false` so the UI can show "X is reviewing".
 */
export async function acknowledgePlaceVerification(
  deps: AcknowledgePlaceVerificationDeps,
  rawInput: unknown,
): Promise<AcknowledgePlaceVerificationOutput> {
  const logger = deps.logger?.child({
    useCase: "acknowledgePlaceVerification",
  });

  const execute = async () => {
    const input = parseInput(acknowledgePlaceVerificationInputSchema, rawInput);

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

    // Already-decided / withdrawn requests can't be acknowledged.
    if (
      request.status === "APPROVED" ||
      request.status === "REJECTED" ||
      request.status === "WITHDRAWN"
    ) {
      throw fail("VERIFICATION_REQUEST_ALREADY_DECIDED");
    }

    // Already locked. Idempotent for the same actor; surface the holder otherwise.
    if (request.status === "IN_REVIEW") {
      const sameActor = request.acknowledgedBy === input.actorHumanId;
      const holder = request.acknowledgedBy
        ? await deps.repos.humans.getById(request.acknowledgedBy)
        : null;
      return acknowledgePlaceVerificationOutputSchema.parse({
        requestId: request.id,
        acknowledgedBy: request.acknowledgedBy ?? input.actorHumanId,
        acknowledgedAt: request.acknowledgedAt ?? deps.clock.now(),
        claimed: sameActor,
        lockedBy: holder
          ? { humanId: holder.id, name: holder.name ?? null }
          : null,
      });
    }

    // PENDING → IN_REVIEW (atomic guard inside repo handles concurrent claims).
    const now = deps.clock.now();
    const claimed = await deps.repos.placeVerificationRequests.acknowledge({
      requestId: input.requestId,
      acknowledgedBy: input.actorHumanId,
      acknowledgedAt: now,
    });

    if (!claimed) {
      // Someone else won the race in between findById + acknowledge.
      const fresh = await deps.repos.placeVerificationRequests.getById(
        input.requestId,
      );
      const holder = fresh?.acknowledgedBy
        ? await deps.repos.humans.getById(fresh.acknowledgedBy)
        : null;
      return acknowledgePlaceVerificationOutputSchema.parse({
        requestId: input.requestId,
        acknowledgedBy: fresh?.acknowledgedBy ?? input.actorHumanId,
        acknowledgedAt: fresh?.acknowledgedAt ?? now,
        claimed: false,
        lockedBy: holder
          ? { humanId: holder.id, name: holder.name ?? null }
          : null,
      });
    }

    await deps.repos.audit.log({
      entity: "place_verification_request",
      entityId: input.requestId,
      action: "verification_acknowledged",
      data: { acknowledgedBy: input.actorHumanId },
      at: now,
    });

    return acknowledgePlaceVerificationOutputSchema.parse({
      requestId: input.requestId,
      acknowledgedBy: input.actorHumanId,
      acknowledgedAt: now,
      claimed: true,
      lockedBy: null,
    });
  };

  if (logger) {
    return logger.withTime("acknowledgePlaceVerification", execute);
  }

  return execute();
}
