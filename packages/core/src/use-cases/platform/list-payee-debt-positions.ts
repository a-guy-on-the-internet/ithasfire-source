import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import { CURSOR_MAX_LIMIT } from "@th/ports/pagination";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// listPayeeDebtPositions — the staff "Payees in debt" read model.
//
// A payee is "in debt" when its ledger payable is negative: a lost dispute or
// a post-payout refund clawed back more than the matured, unblocked credits
// cover. The payout batch pays such a cell nothing and carries it forward
// (settlements/run-batch.ts, "debt position"); nothing else surfaces it. This
// read model lists those cells, largest debt first, and answers the three
// questions ops has about each: who, since when, and can the platform ever
// recover it — i.e. does the owner have upcoming sales to net against.
//
// Roles: ADMIN | SUPPORT (the dispute desk's READ set — support fields the
// "why was my payout zero" thread). Enforced HERE, mirroring
// `platform/fee-waivers.ts`: the transport checks only that an actor exists.
// ─────────────────────────────────────────────────────────────────────────────

export const PAYEE_DEBT_READ_ROLES: HumanRole[] = ["ADMIN", "SUPPORT"];

/**
 * Budget for the ledger aggregate behind this view. The settlements page
 * must never hang on a diagnostic: past this the adapter surfaces
 * SERVICE_UNAVAILABLE (`payee_ledger_debt_positions_timeout`) and the UI
 * renders an inline "timed out — try again". 8s is well above the measured
 * plan at 20k entries (see the adapter's integration suite) and well below
 * anything a human would wait for.
 */
export const PAYEE_DEBT_STATEMENT_TIMEOUT_MS = 8_000;

export type ListPayeeDebtPositionsDeps = {
  repos: Pick<
    Repos,
    "payeeLedger" | "organizations" | "humans" | "events" | "disputes"
  >;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Reports the best-effort owner-label lookup failure. */
  reportError?: ReporterPort;
};

async function requireStaff(
  deps: ListPayeeDebtPositionsDeps,
  actorHumanId: string,
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: PAYEE_DEBT_READ_ROLES,
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}

export const listPayeeDebtPositionsInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(CURSOR_MAX_LIMIT).optional(),
  })
  .strict();

export type ListPayeeDebtPositionsInput = z.infer<
  typeof listPayeeDebtPositionsInputSchema
>;

const subjectTypeSchema = z.enum(["ORGANIZATION", "HUMAN"]);

export const payeeDebtPositionSchema = z
  .object({
    payeeId: z.string(),
    subjectType: subjectTypeSchema,
    subjectId: z.string(),
    /** Best-effort display name; null when the human/org lookup misses. */
    ownerLabel: z.string().nullable(),
    /** Organisation slug for the `/admin/<slug>` link; null for humans. */
    ownerSlug: z.string().nullable(),
    currency: z.string(),
    /** NEGATIVE — the payable as the payout batch sees it. */
    payableCents: z.number().int().negative(),
    /**
     * When the running balance last crossed below zero and stayed there
     * (see the repo type). Null when the deficit is a pending hold alone.
     */
    debtSinceAt: z.date().nullable(),
    lastDebitType: z
      .enum(["DISPUTE_DEBIT", "REFUND_DEBIT", "CASH_SALE_DEBIT"])
      .nullable(),
    lastDebitAt: z.date().nullable(),
    /** Σ principal DISPUTE_DEBIT (the fee twin excluded). */
    disputeDebitCents: z.number().int().nonnegative(),
    /** Σ REFUND_DEBIT. */
    refundDebitCents: z.number().int().nonnegative(),
    /** Disputes still OPEN / UNDER_REVIEW for this owner — more may come. */
    openDisputeCount: z.number().int().nonnegative(),
    /**
     * PUBLISHED, TICKETED events starting after now — the recovery signal.
     * RSVP listings (no orders) and membership income (not events) are NOT
     * counted; the UI copy says so.
     */
    upcomingEventCount: z.number().int().nonnegative(),
    nextEventAt: z.date().nullable(),
  })
  .strict();

export type PayeeDebtPosition = z.infer<typeof payeeDebtPositionSchema>;

export const listPayeeDebtPositionsOutputSchema = z
  .object({
    items: z.array(payeeDebtPositionSchema),
    nextCursor: z.string().min(1).nullable(),
    /** Debt cells at or after the cursor — the grand total on page one. */
    total: z.number().int().nonnegative(),
  })
  .strict();

export type ListPayeeDebtPositionsOutput = z.infer<
  typeof listPayeeDebtPositionsOutputSchema
>;

type OwnerKey = `${"ORGANIZATION" | "HUMAN"}:${string}`;
const keyOf = (t: "ORGANIZATION" | "HUMAN", id: string): OwnerKey =>
  `${t}:${id}`;

export async function listPayeeDebtPositions(
  deps: ListPayeeDebtPositionsDeps,
  rawInput: unknown,
): Promise<ListPayeeDebtPositionsOutput> {
  const input = parseInput(listPayeeDebtPositionsInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  const page = await deps.repos.payeeLedger.listDebtPositions({
    now: deps.clock.now(),
    cursor: input.cursor ?? null,
    limit: input.limit,
    statementTimeoutMs: PAYEE_DEBT_STATEMENT_TIMEOUT_MS,
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

  // The recovery signal and the open-dispute count are LOAD-BEARING — an
  // ops decision ("this payee has no way to recover, act now") hangs on
  // them — so a failure here fails the read rather than rendering a false
  // "None". Only the display-name lookup below is best-effort.
  const [upcoming, openDisputes] = await Promise.all([
    page.items.length > 0
      ? deps.repos.events.getUpcomingStatsForOwners({
          owners: [
            ...orgIds.map((id) => ({
              ownerType: "ORGANIZATION" as const,
              ownerId: id,
            })),
            ...humanIds.map((id) => ({
              ownerType: "HUMAN" as const,
              ownerId: id,
            })),
          ],
          now: deps.clock.now(),
        })
      : [],
    page.items.length > 0
      ? deps.repos.disputes.countOpenByOwners({ orgIds, humanIds })
      : [],
  ]);

  const upcomingByOwner = new Map<
    OwnerKey,
    { upcomingCount: number; nextEventAt: Date }
  >();
  for (const row of upcoming) {
    upcomingByOwner.set(keyOf(row.ownerType, row.ownerId), {
      upcomingCount: row.upcomingCount,
      nextEventAt: row.nextEventAt,
    });
  }
  const openByOwner = new Map<OwnerKey, number>();
  for (const row of openDisputes) {
    const key = row.ownerOrgId
      ? keyOf("ORGANIZATION", row.ownerOrgId)
      : row.ownerHumanId
        ? keyOf("HUMAN", row.ownerHumanId)
        : null;
    if (key) openByOwner.set(key, row.openDisputeCount);
  }

  // Best-effort labels: a naming miss must never hide a debt row — the
  // amount and the recovery signal are what ops acts on, and the id is
  // still there. Swallow + report (ReporterPort convention, CLAUDE.md).
  const labels = new Map<OwnerKey, { label: string | null; slug: string | null }>();
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
    deps.logger?.error("payee_debt_owner_label_lookup_failed", { err });
    deps.reportError?.(err, {
      tags: { useCase: "listPayeeDebtPositions", step: "attachOwnerLabels" },
    });
  }

  const items: PayeeDebtPosition[] = page.items.map((r) => {
    const key = keyOf(r.subjectType, r.subjectId);
    const naming = labels.get(key);
    const up = upcomingByOwner.get(key);
    return {
      payeeId: r.payeeId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      ownerLabel: naming?.label ?? null,
      ownerSlug: naming?.slug ?? null,
      currency: r.currency,
      payableCents: r.payableCents,
      debtSinceAt: r.debtSinceAt,
      lastDebitType: r.lastDebitType,
      lastDebitAt: r.lastDebitAt,
      disputeDebitCents: r.disputeDebitCents,
      refundDebitCents: r.refundDebitCents,
      openDisputeCount: openByOwner.get(key) ?? 0,
      upcomingEventCount: up?.upcomingCount ?? 0,
      nextEventAt: up?.nextEventAt ?? null,
    };
  });

  return {
    items,
    nextCursor: page.pageInfo.nextCursor,
    total: page.total,
  };
}
