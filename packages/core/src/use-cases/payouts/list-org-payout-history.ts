import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import { CURSOR_MAX_LIMIT } from "@th/ports/pagination";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { orgPayoutSentSchema } from "./get-org-payout-overview";

// ─────────────────────────────────────────────────────────────────────────────
// listOrgPayoutHistory — the paged "what has actually been sent to us" table
// beneath the organiser's payout spine.
//
// A THIN WRAPPER, deliberately. It is `payoutItems.listHistory` — the exact
// method `platform/list-payout-history.ts` reads — narrowed to this org's own
// payee, and it computes NOTHING. There is no payout arithmetic in this file
// and there must never be: the organiser's table and the staff table are one
// query, so a row cannot say two different things depending on who is looking.
//
// WHAT IS DROPPED relative to the staff view, and why:
//   * owner labels — the org is looking at its own payouts; naming itself
//     back to it is noise, and it costs two lookups that can fail;
//   * `subjectType` / `subjectId` — likewise: it is always this org;
//   * `processorBatchId` — that names a PLATFORM-WIDE batch other payees rode
//     in. `stripeTransferId` is the identifier this org can reconcile its own
//     bank line against, and it is kept.
// `failureReason` IS kept: the batch's own reason strings
// (`payee_missing_stripe_account`, `payee_payouts_disabled`) name something
// the organiser can actually fix, and hiding them leaves a failed payout with
// no explanation.
//
// THE ROW SHAPE IS SHARED with the overview's `recentPayouts`
// (`orgPayoutSentSchema`), so the five rows on the spine and the rows in this
// table cannot describe the same payout differently.
//
// CURSOR DISCIPLINE, from the port contract: a cursor is only meaningful
// within the filter set that produced it, and nothing detects a mismatched
// pair. A caller that changes `status` must restart from page one or it will
// page from an offset that means something else. `payeeIds` is fixed by the
// org here, so it cannot drift under a cursor.
//
// Roles: `canFinanceOrg`, enforced HERE — the same gate, in the same place,
// as `getOrgPayoutOverview`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Budget for the history query. Past this the adapter surfaces
 * SERVICE_UNAVAILABLE (`payout_items_history_timeout`) and the UI renders an
 * inline "timed out — try again". Same 8s as the staff sibling.
 */
export const ORG_PAYOUT_HISTORY_TIMEOUT_MS = 8_000;

export type ListOrgPayoutHistoryDeps = {
  repos: Pick<Repos, "payoutItems" | "payees">;
  authz: Pick<AuthZPort, "canFinanceOrg">;
};

export const orgPayoutHistoryStatusFilterSchema = z.enum([
  "all",
  "pending",
  "transferred",
  "failed",
]);

export const listOrgPayoutHistoryInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    /** Default "all". CHANGING THIS INVALIDATES `cursor` — see the header. */
    status: orgPayoutHistoryStatusFilterSchema.optional(),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(CURSOR_MAX_LIMIT).optional(),
  })
  .strict();

export type ListOrgPayoutHistoryInput = z.infer<
  typeof listOrgPayoutHistoryInputSchema
>;

export const listOrgPayoutHistoryOutputSchema = z
  .object({
    /**
     * Newest first (`occurredAt` DESC, then id DESC). A TRANSFERRED item
     * sorts on when the money left; a pending or failed one on its batch's
     * `scheduledFor` — the same value rendered in the cell, so the sort key
     * and the visible date can never disagree.
     */
    items: z.array(orgPayoutSentSchema),
    nextCursor: z.string().min(1).nullable(),
    /** Items at or after the cursor for the active filter — the badge count. */
    total: z.number().int().nonnegative(),
    /**
     * Null when the org has NO Payee row (never onboarded to Stripe). The
     * page is then empty because there is nothing to have been paid, not
     * because a read failed.
     */
    payeeId: z.string().nullable(),
  })
  .strict();

export type ListOrgPayoutHistoryOutput = z.infer<
  typeof listOrgPayoutHistoryOutputSchema
>;

export async function listOrgPayoutHistory(
  deps: ListOrgPayoutHistoryDeps,
  rawInput: unknown,
): Promise<ListOrgPayoutHistoryOutput> {
  const input = parseInput(listOrgPayoutHistoryInputSchema, rawInput);

  // RBAC FIRST, before any read. See `getOrgPayoutOverview` for the rationale.
  const permission = await deps.authz.canFinanceOrg({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
  });
  if (!permission.allowed) {
    throw fail("FORBIDDEN");
  }

  const payeeRef = await deps.repos.payees.getBySubject({
    type: "ORGANIZATION",
    id: input.orgId,
  });
  // SHORT-CIRCUIT rather than pass `[]`. Both would return no rows (the port
  // defines an explicit empty array as "no payees"), but not issuing the
  // query at all makes the "never onboarded" case free and keeps the
  // never-omit-`payeeIds` rule below unconditional: an OMITTED `payeeIds`
  // would be EVERY payee's payouts, which is the one mistake this file must
  // structurally prevent.
  if (!payeeRef) {
    return { items: [], nextCursor: null, total: 0, payeeId: null };
  }

  const page = await deps.repos.payoutItems.listHistory({
    status: input.status ?? "all",
    payeeIds: [payeeRef.id],
    cursor: input.cursor ?? null,
    limit: input.limit,
    statementTimeoutMs: ORG_PAYOUT_HISTORY_TIMEOUT_MS,
  });

  return {
    items: page.items.map((item) => ({
      id: item.id,
      payoutId: item.payoutId,
      currency: item.currency,
      amountCents: item.amountCents,
      netCents: item.netCents,
      connectAccountFeeCents: item.connectAccountFeeCents,
      recoveredDebtCents: item.recoveredDebtCents,
      reserveHeldCents: item.reserveHeldCents,
      reserveReleasedCents: item.reserveReleasedCents,
      status: item.status,
      occurredAt: item.occurredAt,
      transferredAt: item.transferredAt,
      scheduledFor: item.scheduledFor,
      failedAt: item.failedAt,
      failureReason: item.failureReason,
      stripeTransferId: item.stripeTransferId,
    })),
    nextCursor: page.pageInfo.nextCursor,
    total: page.total,
    payeeId: payeeRef.id,
  };
}
