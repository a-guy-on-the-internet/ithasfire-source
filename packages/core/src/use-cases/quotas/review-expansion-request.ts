import { z } from "zod";
import { expansionRequestStatusSchema } from "@th/schema";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";

const reviewStatusSchema = expansionRequestStatusSchema.exclude(["PENDING"]);

export const reviewExpansionRequestInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    expansionRequestId: z.uuid(),
    decision: reviewStatusSchema,
    reviewNote: plainTextMultilineOptional(1000).optional(),
  })
  .strict();

export const reviewExpansionRequestOutputSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    /** Only present when decision is APPROVED and override was created. */
    newLimitValue: z.string().optional(),
  })
  .strict();

export type ReviewExpansionRequestInput = z.infer<
  typeof reviewExpansionRequestInputSchema
>;
export type ReviewExpansionRequestOutput = z.infer<
  typeof reviewExpansionRequestOutputSchema
>;

export type ReviewExpansionRequestDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function reviewExpansionRequest(
  deps: ReviewExpansionRequestDeps,
  rawInput: unknown,
): Promise<ReviewExpansionRequestOutput> {
  const input = parseInput(reviewExpansionRequestInputSchema, rawInput);

  // Platform staff check
  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN"],
    errorCode: "STAFF_ONLY",
  });

  const result = await deps.repos.tx(async (tx) => {
    const request = await tx.resourceQuotas.getExpansionRequestById(
      input.expansionRequestId,
    );
    if (!request) {
      throw fail("EXPANSION_REQUEST_NOT_FOUND");
    }

    if (request.status !== "PENDING") {
      throw fail("EXPANSION_REQUEST_ALREADY_REVIEWED");
    }

    // Update the request
    const reviewed = await tx.resourceQuotas.reviewExpansionRequest({
      id: input.expansionRequestId,
      status: input.decision,
      reviewedByHumanId: input.actorHumanId,
      reviewNote: input.reviewNote ?? null,
    });

    let newLimitValue: string | undefined;

    // If approved, create the quota override
    if (input.decision === "APPROVED") {
      await tx.resourceQuotas.upsertOverride({
        subjectType: request.subjectType,
        subjectId: request.subjectId,
        kind: request.kind,
        limitValue: request.requestedLimitValue,
        note: `Approved expansion request ${request.id}`,
        grantedByHumanId: input.actorHumanId,
      });
      newLimitValue = request.requestedLimitValue.toString();
    }

    await tx.audit.log({
      entity: "expansion_request",
      entityId: request.id,
      action: `expansion_request.${input.decision.toLowerCase()}`,
      data: {
        reviewedByHumanId: input.actorHumanId,
        decision: input.decision,
        reviewNote: input.reviewNote ?? null,
        subjectType: request.subjectType,
        subjectId: request.subjectId,
        kind: request.kind,
      },
      at: new Date(),
    });

    return { reviewed, newLimitValue };
  });

  return reviewExpansionRequestOutputSchema.parse({
    id: result.reviewed.id,
    status: result.reviewed.status,
    newLimitValue: result.newLimitValue,
  });
}
