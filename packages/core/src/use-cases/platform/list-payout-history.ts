import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import { CURSOR_MAX_LIMIT } from "@th/ports/pagination";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// listPayoutHistory — the staff "what we PAID" read model.
//
// The other half of `/platform/settlements`. Where `listPayablePositions`
// answers "what do we owe", this answers "what have we actually sent, when,
// and to whom" — one row per `PayoutItem`, newest first, cursor-paged.
//
// EVERY DEDUCTION IS SHOWN. The row carries the GROSS `amountCents`, the
// frozen `netCents` (what was actually handed to Stripe) and the four
// deduction columns that explain the gap: the Connect account fee, legacy
// debt recovery, reserve withheld and reserve released. A payout view that
// showed one number would make every withheld cent look like a bug; showing
// the parts means "we owed $500 and sent $487" is legible rather than
// alarming.
//
// Roles: ADMIN | SUPPORT — the same STAFF_ONLY read set as the sibling debt
// and payable views, enforced HERE; the transport checks only that an actor
// exists.
// ─────────────────────────────────────────────────────────────────────────────

export const PAYOUT_HISTORY_READ_ROLES: HumanRole[] = ["ADMIN", "SUPPORT"];

/**
 * Budget for the history query. Past this the adapter surfaces
 * SERVICE_UNAVAILABLE (`payout_items_history_timeout`) and the UI renders an
 * inline "timed out — try again". Same 8s as the sibling views.
 */
export const PAYOUT_HISTORY_STATEMENT_TIMEOUT_MS = 8_000;

export type ListPayoutHistoryDeps = {
  repos: Pick<Repos, "payoutItems" | "organizations" | "humans">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
  /** Reports the best-effort owner-label lookup failure. */
  reportError?: ReporterPort;
};

async function requireStaff(
  deps: ListPayoutHistoryDeps,
  actorHumanId: string,
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: PAYOUT_HISTORY_READ_ROLES,
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}

export const payoutHistoryStatusFilterSchema = z.enum([
  "all",
  "pending",
  "transferred",
  "failed",
]);

export const listPayoutHistoryInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    /** Default "all". */
    status: payoutHistoryStatusFilterSchema.optional(),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(CURSOR_MAX_LIMIT).optional(),
  })
  .strict();

export type ListPayoutHistoryInput = z.infer<
  typeof listPayoutHistoryInputSchema
>;

const subjectTypeSchema = z.enum(["ORGANIZATION", "HUMAN"]);

export const payoutHistoryRowSchema = z
  .object({
    /** `PayoutItem.id`. */
    id: z.string(),
    payoutId: z.string(),
    payeeId: z.string(),
    subjectType: subjectTypeSchema,
    subjectId: z.string(),
    /** Best-effort display name; null when the human/org lookup misses. */
    ownerLabel: z.string().nullable(),
    /** Organisation slug for the `/admin/<slug>` link; null for humans. */
    ownerSlug: z.string().nullable(),
    currency: z.string(),
    /** GROSS — the payable claimed this cycle, before withholding. */
    amountCents: z.number().int(),
    /**
     * The exact cents handed to Stripe, frozen at mint time.
     *
     * NULL on pre-cutover rows, where the column was backfilled to 0 — see
     * {@link PayoutHistoryItem.netCents}. The UI renders null as "Not
     * reported"; rendering the stored zero would report money that moved as
     * money that did not.
     */
    netCents: z.number().int().nullable(),
    connectAccountFeeCents: z.number().int(),
    recoveredDebtCents: z.number().int(),
    reserveHeldCents: z.number().int(),
    reserveReleasedCents: z.number().int(),
    status: z.enum(["pending", "transferred", "failed"]),
    /**
     * WHEN: `transferredAt` for a transfer that landed, else the parent
     * batch's `scheduledFor`. Also the sort key — one value, so the visible
     * date and the ordering can never disagree.
     */
    occurredAt: z.date(),
    transferredAt: z.date().nullable(),
    scheduledFor: z.date(),
    failedAt: z.date().nullable(),
    failureReason: z.string().nullable(),
    stripeTransferId: z.string().nullable(),
    /** Parent `Payout.status` — the batch this item rode in. */
    payoutStatus: z.string(),
    processorBatchId: z.string().nullable(),
  })
  .strict();

export type PayoutHistoryRow = z.infer<typeof payoutHistoryRowSchema>;

export const listPayoutHistoryOutputSchema = z
  .object({
    items: z.array(payoutHistoryRowSchema),
    nextCursor: z.string().min(1).nullable(),
    /** Items at or after the cursor for the active filter — the badge count. */
    total: z.number().int().nonnegative(),
  })
  .strict();

export type ListPayoutHistoryOutput = z.infer<
  typeof listPayoutHistoryOutputSchema
>;

type OwnerKey = `${"ORGANIZATION" | "HUMAN"}:${string}`;
const keyOf = (t: "ORGANIZATION" | "HUMAN", id: string): OwnerKey =>
  `${t}:${id}`;

export async function listPayoutHistory(
  deps: ListPayoutHistoryDeps,
  rawInput: unknown,
): Promise<ListPayoutHistoryOutput> {
  const input = parseInput(listPayoutHistoryInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  const page = await deps.repos.payoutItems.listHistory({
    status: input.status ?? "all",
    cursor: input.cursor ?? null,
    limit: input.limit,
    statementTimeoutMs: PAYOUT_HISTORY_STATEMENT_TIMEOUT_MS,
  });

  const orgIds = [
    ...new Set(
      page.items
        .filter((r) => r.subjectType === "ORGANIZATION")
        .map((r) => r.subjectId),
    ),
  ];
  const humanIds = [
    ...new Set(
      page.items
        .filter((r) => r.subjectType === "HUMAN")
        .map((r) => r.subjectId),
    ),
  ];

  // Best-effort labels: a naming miss must never hide a payout row — the
  // amount, the date and the Stripe transfer id are what ops reconciles
  // against, and the subject id is still there. Swallow + report
  // (ReporterPort convention, CLAUDE.md).
  const labels = new Map<
    OwnerKey,
    { label: string | null; slug: string | null }
  >();
  try {
    const [orgs, humans] = await Promise.all([
      orgIds.length > 0 ? deps.repos.organizations.getByIds(orgIds) : [],
      humanIds.length > 0 ? deps.repos.humans.getByIds(humanIds) : [],
    ]);
    for (const org of orgs) {
      labels.set(keyOf("ORGANIZATION", org.id), {
        label: org.name || org.slug || null,
        slug: org.slug || null,
      });
    }
    for (const human of humans) {
      labels.set(keyOf("HUMAN", human.id), {
        label: human.name ?? null,
        slug: null,
      });
    }
  } catch (err) {
    deps.logger?.error("payout_history_owner_label_lookup_failed", { err });
    // GUARDED: a MISSING or THROWING reporter must never change behaviour
    // (ReporterPort convention, CLAUDE.md) — a broken Sentry wiring must not
    // turn a nameless payout row into a failed page.
    try {
      deps.reportError?.(err, {
        tags: { useCase: "listPayoutHistory", step: "attachOwnerLabels" },
      });
    } catch {
      // Reporting is fire-and-forget.
    }
  }

  const items: PayoutHistoryRow[] = page.items.map((r) => {
    const naming = labels.get(keyOf(r.subjectType, r.subjectId));
    return {
      id: r.id,
      payoutId: r.payoutId,
      payeeId: r.payeeId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      ownerLabel: naming?.label ?? null,
      ownerSlug: naming?.slug ?? null,
      currency: r.currency,
      amountCents: r.amountCents,
      netCents: r.netCents,
      connectAccountFeeCents: r.connectAccountFeeCents,
      recoveredDebtCents: r.recoveredDebtCents,
      reserveHeldCents: r.reserveHeldCents,
      reserveReleasedCents: r.reserveReleasedCents,
      status: r.status,
      occurredAt: r.occurredAt,
      transferredAt: r.transferredAt,
      scheduledFor: r.scheduledFor,
      failedAt: r.failedAt,
      failureReason: r.failureReason,
      stripeTransferId: r.stripeTransferId,
      payoutStatus: r.payoutStatus,
      processorBatchId: r.processorBatchId,
    };
  });

  return {
    items,
    nextCursor: page.pageInfo.nextCursor,
    total: page.total,
  };
}
