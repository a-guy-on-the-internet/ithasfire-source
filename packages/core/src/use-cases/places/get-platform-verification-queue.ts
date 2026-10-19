import { z } from "zod";

import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  buildOffsetPaginatedResult,
  offsetPageInfoSchema,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const STAFF_REVIEWER_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];

const STATUS_VALUES = [
  "PENDING",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
] as const;

export const getPlatformVerificationQueueInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** When omitted, returns active queue (PENDING + IN_REVIEW). */
    statuses: z.array(z.enum(STATUS_VALUES)).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

const queueItemSchema = z
  .object({
    requestId: z.string().uuid(),
    placeId: z.string().uuid(),
    placeName: z.string(),
    placeAddress: z.string().nullable(),
    placeCity: z.string().nullable(),
    placeRegion: z.string().nullable(),
    placeCountryCode: z.string().nullable(),
    placeCapacity: z.number().int().nullable(),
    placeWebsite: z.string().nullable(),
    placePhone: z.string().nullable(),
    /** Count of verified ownership claims on the place — a trust signal. */
    ownerCount: z.number().int().nonnegative(),
    /**
     * What opened this request. Legacy rows + org verifications are
     * ORG_SUBMISSION; self-serve claims/disputes are tagged so the admin
     * queue can render them distinctly (FR-006).
     */
    source: z.enum(["ORG_SUBMISSION", "OWNERSHIP_CLAIM", "OWNERSHIP_DISPUTE"]),
    /** Claim provenance (null for ORG_SUBMISSION). */
    claimantHumanId: z.string().uuid().nullable(),
    claimOwnerType: z.enum(["HUMAN", "ORGANIZATION"]).nullable(),
    /** Null for HUMAN ownership claims (no org involved). */
    orgId: z.string().uuid().nullable(),
    status: z.enum(STATUS_VALUES),
    submittedAt: z.date(),
    // Null when the submitting account has been deleted (submitter detached).
    submitter: z
      .object({
        humanId: z.string().uuid(),
        name: z.string().nullable(),
      })
      .nullable(),
    acknowledgedAt: z.date().nullable(),
    acknowledger: z
      .object({ humanId: z.string().uuid(), name: z.string().nullable() })
      .nullable(),
    reviewedAt: z.date().nullable(),
    reviewer: z
      .object({ humanId: z.string().uuid(), name: z.string().nullable() })
      .nullable(),
    reviewerNotes: z.string().nullable(),
    documentCount: z.number().int().nonnegative(),
  })
  .strict();

export const getPlatformVerificationQueueOutputSchema = z
  .object({
    items: z.array(queueItemSchema),
    pageInfo: offsetPageInfoSchema,
    queueStats: z.object({
      pending: z.number().int().nonnegative(),
      inReview: z.number().int().nonnegative(),
      reviewedThisMonth: z.number().int().nonnegative(),
      oldestPendingAgeMs: z.number().int().nullable(),
    }),
  })
  .strict();

export type GetPlatformVerificationQueueInput = z.infer<
  typeof getPlatformVerificationQueueInputSchema
>;
export type GetPlatformVerificationQueueOutput = z.infer<
  typeof getPlatformVerificationQueueOutputSchema
>;

export type GetPlatformVerificationQueueDeps = {
  repos: Pick<Repos, "placeVerificationRequests">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

/**
 * Powers the platform admin verification workbench. Returns paginated queue
 * items ordered PENDING-first (oldest), then IN_REVIEW, plus aggregate stats
 * for the queue header. When called without filters, surfaces the active
 * queue only.
 */
export async function getPlatformVerificationQueue(
  deps: GetPlatformVerificationQueueDeps,
  rawInput: unknown,
): Promise<GetPlatformVerificationQueueOutput> {
  const logger = deps.logger?.child({
    useCase: "getPlatformVerificationQueue",
  });

  const execute = async () => {
    const input = parseInput(getPlatformVerificationQueueInputSchema, rawInput);

    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...STAFF_REVIEWER_ROLES],
    });
    if (!staff.allowed) {
      throw fail("STAFF_ONLY");
    }

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    const [{ items, total }, queueStats] = await Promise.all([
      deps.repos.placeVerificationRequests.listQueue({
        statuses: input.statuses,
        limit: pagination.limit,
        offset: pagination.offset,
      }),
      deps.repos.placeVerificationRequests.getQueueStats(),
    ]);

    const mapped = items.map((row) => ({
      requestId: row.request.id,
      placeId: row.place.id,
      placeName: row.place.name,
      placeAddress: row.place.formattedAddress,
      placeCity: row.place.city,
      placeRegion: row.place.region,
      placeCountryCode: row.place.countryCode,
      placeCapacity: row.place.capacity,
      placeWebsite: row.place.website,
      placePhone: row.place.phone,
      ownerCount: row.ownerCount,
      source: row.request.source,
      claimantHumanId: row.request.claimantHumanId,
      claimOwnerType: row.request.claimOwnerType,
      orgId: row.request.orgId,
      status: row.request.status,
      submittedAt: row.request.createdAt,
      // Null when the submitting account has been deleted (SetNull FK).
      submitter: row.submitter
        ? {
            humanId: row.submitter.humanId,
            name: row.submitter.displayName,
          }
        : null,
      acknowledgedAt: row.request.acknowledgedAt,
      acknowledger: row.acknowledger
        ? {
            humanId: row.acknowledger.humanId,
            name: row.acknowledger.displayName,
          }
        : null,
      reviewedAt: row.request.reviewedAt,
      reviewer: row.reviewer
        ? { humanId: row.reviewer.humanId, name: row.reviewer.displayName }
        : null,
      reviewerNotes: row.request.reviewerNotes,
      documentCount: row.documentCount,
    }));

    const { pageInfo } = buildOffsetPaginatedResult({
      items: mapped,
      total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return getPlatformVerificationQueueOutputSchema.parse({
      items: mapped,
      pageInfo,
      queueStats,
    });
  };

  if (logger) {
    return logger.withTime("getPlatformVerificationQueue", execute);
  }

  return execute();
}
