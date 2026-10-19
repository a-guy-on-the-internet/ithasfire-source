import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  buildOffsetPaginatedResult,
  offsetPaginatedResultSchema,
  offsetPaginationInputSchema,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import { supportThreadStatusSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { SUPPORT_STAFF_ROLES } from "./roles";
import {
  supportThreadStaffSchema,
  type SupportThreadStaffDto,
} from "./schemas";

// ── Goal ─────────────────────────────────────────────────────────────────────
// Paginated thread list for the operator inbox, ordered AWAITING_HUMAN first
// then by lastMessageAt desc. Platform support staff only.

export const listSupportThreadsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    status: supportThreadStatusSchema.optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

export const listSupportThreadsOutputSchema = offsetPaginatedResultSchema(
  supportThreadStaffSchema,
);

export type ListSupportThreadsInput = z.infer<
  typeof listSupportThreadsInputSchema
>;
export type ListSupportThreadsOutput = z.infer<
  typeof listSupportThreadsOutputSchema
>;

export type ListSupportThreadsDeps = {
  repos: Pick<Repos, "supportThreads">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

export async function listSupportThreads(
  deps: ListSupportThreadsDeps,
  rawInput: unknown,
): Promise<ListSupportThreadsOutput> {
  const input = parseInput(listSupportThreadsInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: SUPPORT_STAFF_ROLES,
    errorCode: "STAFF_ONLY",
  });

  const { limit, offset } = sanitizeOffsetPagination(input);

  const result = await deps.repos.supportThreads.listThreads({
    status: input.status,
    limit,
    offset,
  });

  const output = buildOffsetPaginatedResult<SupportThreadStaffDto>({
    items: result.items,
    total: result.total,
    limit,
    offset,
  });

  return listSupportThreadsOutputSchema.parse(output);
}
