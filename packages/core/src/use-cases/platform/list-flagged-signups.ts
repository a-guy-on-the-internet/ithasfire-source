import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  buildOffsetPaginatedResult,
  offsetPaginatedResultSchema,
  offsetPaginationInputSchema,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import { humanStatusSchema } from "@th/schema";
import { fail } from "@th/errors";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { NETWORK_SIGHTING_RETENTION_MS } from "../../lib/security/network-identity";

/**
 * Staff-only: new accounts that signed up, in the last 30 days, from a
 * network a BANNED or SUSPENDED human used (ban-that-sticks, 2026-09-29).
 * Keyed on the BannedIdentity rows, not on status: suspension records them
 * too (owner ruling), and reactivation removes them.
 *
 * FLAGGED, NOT BLOCKED, AND NEVER STORED. Nothing marks these accounts; the
 * list is the join of recent SIGN_UP sightings against active NETWORK ban
 * rows, computed on every read. Reactivating the human removes their rows
 * and the flags vanish with them. A shared network (a campus, a
 * café, a carrier NAT) produces false positives by design — staff decide.
 *
 * Same staff bar as `listPlatformHumans` (the page this feeds). The
 * transport's `platform.*` prefix adds the staff second-factor gate.
 */

const PLATFORM_STAFF_ROLES = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
] as const;

export const listFlaggedSignupsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const flaggedSignupItemSchema = z
  .object({
    humanId: z.string().uuid(),
    authUserId: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    status: humanStatusSchema,
    signedUpAt: z.coerce.date(),
    country: z.string().nullable(),
    matches: z.array(
      z
        .object({
          bannedHumanId: z.string().uuid(),
          bannedHumanName: z.string().nullable(),
          /** BANNED or SUSPENDED — the UI names which. */
          bannedHumanStatus: humanStatusSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const listFlaggedSignupsOutputSchema = offsetPaginatedResultSchema(
  flaggedSignupItemSchema,
);

export type ListFlaggedSignupsInput = z.infer<
  typeof listFlaggedSignupsInputSchema
>;
export type ListFlaggedSignupsOutput = z.infer<
  typeof listFlaggedSignupsOutputSchema
>;

export type ListFlaggedSignupsDeps = {
  repos: Pick<Repos, "networkSightings">;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function listFlaggedSignups(
  deps: ListFlaggedSignupsDeps,
  rawInput: unknown,
): Promise<ListFlaggedSignupsOutput> {
  const logger = deps.logger?.child({ useCase: "listFlaggedSignups" });
  const input = parseInput(listFlaggedSignupsInputSchema, rawInput);

  const staffCheck = await callOrDependencyFailed(
    () =>
      deps.authz.hasStaffRole({
        actorHumanId: input.actorHumanId,
        requiredRoles: [...PLATFORM_STAFF_ROLES],
      }),
    logger,
    { action: "authz.hasStaffRole", actorHumanId: input.actorHumanId },
  );
  if (!staffCheck.allowed) {
    throw fail("FORBIDDEN");
  }

  const pagination = sanitizeOffsetPagination({
    limit: input.limit,
    offset: input.offset,
  });
  const now = deps.clock.now();
  const result = await callOrDependencyFailed(
    () =>
      deps.repos.networkSightings.listFlaggedSignups({
        since: new Date(now.getTime() - NETWORK_SIGHTING_RETENTION_MS),
        now,
        limit: pagination.limit,
        offset: pagination.offset,
      }),
    logger,
    {
      action: "repos.networkSightings.listFlaggedSignups",
      actorHumanId: input.actorHumanId,
    },
  );

  return listFlaggedSignupsOutputSchema.parse(
    buildOffsetPaginatedResult({
      items: result.items,
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
    }),
  );
}
