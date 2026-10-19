import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import { CURSOR_DEFAULT_LIMIT } from "@th/ports/pagination";

import { parseInput } from "../../../lib/io";
import {
  disputeDeskListLimitSchema,
  disputeDeskRowSchema,
  disputeDeskStatusFilterSchema,
} from "./schemas";
import { requireDisputeDeskStaff, type DisputeDeskAuthzDeps } from "./staff";

// ─────────────────────────────────────────────────────────────────────────────
// listDisputesForDesk — the staff queue. Open tab sorted by evidence
// deadline (soonest first, never-due last); closed tab newest close first.
// Staff-only, enforced here.
// ─────────────────────────────────────────────────────────────────────────────

export const listDisputesForDeskInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    status: disputeDeskStatusFilterSchema.optional().default("open"),
    cursor: z.string().min(1).nullable().optional(),
    limit: disputeDeskListLimitSchema.optional(),
  })
  .strict();

export const listDisputesForDeskOutputSchema = z
  .object({
    items: z.array(disputeDeskRowSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export type ListDisputesForDeskInput = z.infer<
  typeof listDisputesForDeskInputSchema
>;
export type ListDisputesForDeskOutput = z.infer<
  typeof listDisputesForDeskOutputSchema
>;

export type ListDisputesForDeskDeps = DisputeDeskAuthzDeps & {
  repos: Pick<Repos, "disputes">;
};

export async function listDisputesForDesk(
  deps: ListDisputesForDeskDeps,
  rawInput: unknown,
): Promise<ListDisputesForDeskOutput> {
  const input = parseInput(listDisputesForDeskInputSchema, rawInput);
  await requireDisputeDeskStaff(deps, input.actorHumanId, "read");

  const page = await deps.repos.disputes.listForDesk({
    status: input.status,
    cursor: input.cursor ?? null,
    limit: input.limit ?? CURSOR_DEFAULT_LIMIT,
  });

  return listDisputesForDeskOutputSchema.parse(page);
}
