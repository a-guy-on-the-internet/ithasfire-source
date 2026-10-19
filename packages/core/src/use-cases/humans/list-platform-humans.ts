import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import {
  buildOffsetPaginatedResult,
  OFFSET_MAX_LIMIT,
  offsetPaginatedResultSchema,
  offsetPaginationInputSchema,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import { humanStatusSchema, orgRoleSchema } from "@th/schema";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const PLATFORM_STAFF_ROLES = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

const humanSortSchema = z.enum([
  "createdAt_asc",
  "createdAt_desc",
  "name_asc",
  "name_desc",
]);

export const listPlatformHumansInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    searchQuery: z.string().max(200).optional(),
    status: humanStatusSchema.optional(),
    emailVerified: z.boolean().optional(),
    /**
     * Restrict to these humans. The page's "Flagged sign-ups" filter passes
     * the ids `platform.listFlaggedSignups` returned, so flagged rows render
     * with the same columns and actions as every other row.
     */
    humanIds: z.array(z.string().uuid()).max(OFFSET_MAX_LIMIT).optional(),
    sort: humanSortSchema.optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

const orgMembershipSummarySchema = z
  .object({
    orgId: z.string().uuid(),
    orgName: z.string(),
    orgSlug: z.string(),
    role: orgRoleSchema,
  })
  .strict();

const identitySchema = z
  .object({
    authUserId: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    phone: z.string().nullable(),
    phoneVerified: z.boolean(),
    username: z.string().nullable(),
    displayUsername: z.string().nullable(),
    image: z.string().nullable(),
  })
  .strict();

const platformHumanItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    status: humanStatusSchema,
    roles: z.array(z.string()),
    trustTier: z.string(),
    createdAt: z.coerce.date(),
    identity: identitySchema.nullable(),
    memberships: z.array(orgMembershipSummarySchema),
    /**
     * Whether force-verify would be refused with
     * FORCE_VERIFY_HOLDS_EMAIL_ATTACHED (`humans.holdsEmailAttachedRows`,
     * batched as `listHumanIdsHoldingEmailAttachedRows`).
     * A hint for the /platform/humans menu; the refusal in
     * `adminForceVerifyEmail` stays the guard. `null` when not computed: the
     * email is verified or absent, the actor is not ADMIN (only ADMIN can
     * force-verify), or the lookup failed.
     */
    holdsEmailAttachedRows: z.boolean().nullable(),
  })
  .strict();

export const listPlatformHumansOutputSchema = offsetPaginatedResultSchema(
  platformHumanItemSchema,
);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ListPlatformHumansInput = z.infer<
  typeof listPlatformHumansInputSchema
>;
export type ListPlatformHumansOutput = z.infer<
  typeof listPlatformHumansOutputSchema
>;

export type ListPlatformHumansDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function listPlatformHumans(
  deps: ListPlatformHumansDeps,
  rawInput: unknown,
): Promise<ListPlatformHumansOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listPlatformHumans" });

  const execute = async () => {
    const input = parseInput(listPlatformHumansInputSchema, rawInput);

    // RBAC: require platform staff role
    const staffCheck = await callOrDependencyFailed(
      () =>
        deps.authz.hasStaffRole({
          actorHumanId: input.actorHumanId,
          requiredRoles: [...PLATFORM_STAFF_ROLES],
        }),
      scopedLogger,
      { action: "authz.hasStaffRole", actorHumanId: input.actorHumanId },
    );

    if (!staffCheck.allowed) {
      throw fail("FORBIDDEN");
    }

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    const result = await callOrDependencyFailed(
      () =>
        deps.repos.humans.listAllWithMemberships({
          searchQuery: input.searchQuery,
          status: input.status,
          emailVerified: input.emailVerified,
          humanIds: input.humanIds,
          sort: input.sort,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      {
        action: "repos.humans.listAllWithMemberships",
        actorHumanId: input.actorHumanId,
      },
    );

    const holdsByHumanId = await lookUpHoldsForUnverified(
      deps,
      input.actorHumanId,
      result.items
        .filter((item) => item.identity && !item.identity.emailVerified)
        .map((item) => item.human.id),
      scopedLogger,
    );

    // Map repo result to output shape
    const items = result.items.map((item) => ({
      id: item.human.id,
      name: item.human.name,
      status: item.human.status,
      roles: item.human.roles,
      trustTier: item.human.trustTier,
      createdAt: item.human.createdAt,
      identity: item.identity,
      memberships: item.memberships,
      holdsEmailAttachedRows: holdsByHumanId.get(item.human.id) ?? null,
    }));

    const output = buildOffsetPaginatedResult({
      items,
      total: result.pageInfo.total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return listPlatformHumansOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listPlatformHumans", execute);
  }

  return execute();
}

/**
 * The force-verify pre-flight for the unverified rows on this page. ADMIN
 * actors only: no other staff role sees the action, so nobody else pays the
 * queries. A failure here only loses the hint (every row reads `null` and the
 * button stays live for the server to refuse), so it is reported and
 * swallowed rather than failing the roster.
 */
async function lookUpHoldsForUnverified(
  deps: ListPlatformHumansDeps,
  actorHumanId: string,
  humanIds: string[],
  logger: LoggerPort | undefined,
): Promise<Map<string, boolean>> {
  const holds = new Map<string, boolean>();
  if (humanIds.length === 0) return holds;
  try {
    const admin = await deps.authz.hasStaffRole({
      actorHumanId,
      requiredRoles: ["ADMIN"],
    });
    if (!admin.allowed) return holds;
    const holding = new Set(
      await deps.repos.humans.listHumanIdsHoldingEmailAttachedRows(humanIds),
    );
    for (const id of humanIds) holds.set(id, holding.has(id));
    return holds;
  } catch (err) {
    logger?.error("listPlatformHumans: force-verify pre-flight failed", {
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "listPlatformHumans", step: "listHumanIdsHoldingEmailAttachedRows" },
        extra: { actorHumanId, rows: humanIds.length },
      });
    } catch {
      // A throwing reporter must not change the result.
    }
    return new Map();
  }
}
