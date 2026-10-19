import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { communityModeratorApplicationRecordSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

/**
 * FR-010 (community-managed-event-listings spec): the PENDING queue behind
 * /moderate/applications. Platform ADMIN only, the same gate the review use
 * case enforces.
 *
 * Each row carries the applicant's display name so the admin deciding who
 * becomes a moderator sees a person, not a raw UUID. Names come from one
 * batched `humans.getByIds` read for the page (the shape the reports and
 * edit-suggestion queues use). The application stores the applicant id as a
 * plain string with no FK, so the human can be gone: `applicantMissing` is
 * true then, and the queue can offer REJECT only (APPROVE would fail with
 * HUMAN_NOT_FOUND). `applicantName` is null when the human is missing or has
 * no name set.
 */

export const listModeratorApplicationsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const moderatorApplicationQueueItemSchema =
  communityModeratorApplicationRecordSchema
    .extend({
      applicantName: z.string().nullable(),
      applicantMissing: z.boolean(),
    })
    .strict();

export const listModeratorApplicationsOutputSchema = z
  .object({
    items: z.array(moderatorApplicationQueueItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ListModeratorApplicationsInput = z.infer<
  typeof listModeratorApplicationsInputSchema
>;
export type ListModeratorApplicationsOutput = z.infer<
  typeof listModeratorApplicationsOutputSchema
>;

export type ListModeratorApplicationsDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

export async function listModeratorApplications(
  deps: ListModeratorApplicationsDeps,
  rawInput: unknown,
): Promise<ListModeratorApplicationsOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "listModeratorApplications",
  });

  const execute = async (): Promise<ListModeratorApplicationsOutput> => {
    const input = parseInput(listModeratorApplicationsInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN"],
    });

    const page = await deps.repos.communityModeratorApplications.listPending({
      cursor: input.cursor ?? null,
      limit: input.limit,
    });

    const applicantIds = [
      ...new Set(page.items.map((item) => item.applicantHumanId)),
    ];
    const applicants =
      applicantIds.length > 0
        ? await deps.repos.humans.getByIds(applicantIds)
        : [];
    const nameByHumanId = new Map(
      applicants.map((human) => [human.id, human.name?.trim() || null]),
    );

    const items = page.items.map((application) => ({
      ...application,
      applicantName: nameByHumanId.get(application.applicantHumanId) ?? null,
      applicantMissing: !nameByHumanId.has(application.applicantHumanId),
    }));

    return listModeratorApplicationsOutputSchema.parse({
      items,
      nextCursor: page.nextCursor,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listModeratorApplications", execute);
  }

  return execute();
}
