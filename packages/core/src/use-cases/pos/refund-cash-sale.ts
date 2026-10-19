import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES, requireOrgMembership } from "../../lib/rbac";
import { refundCashOrderInTx } from "./_shared/refund-cash-order-core";

// ── Schema ───────────────────────────────────────────────────────────────────

export const refundCashSaleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export type RefundCashSaleInput = z.infer<typeof refundCashSaleInputSchema>;

export const refundCashSaleOutputSchema = z.object({
  orderId: z.string().uuid(),
  refundedTicketCount: z.number().int().nonnegative(),
  /**
   * Cash to hand back: what the buyer paid, as recorded (spec 2026-10-07
   * FR-008) — ticket net of discount + tax; plus the platform fee on a sale
   * recorded before the owner ruling of 2026-10-08 (cash = no platform
   * fee). 0 for a comp.
   */
  amountReturnedCents: z.number().int().nonnegative(),
});

export type RefundCashSaleOutput = z.infer<typeof refundCashSaleOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type RefundCashSaleDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /**
   * The per-item tax allocation reports (never throws) when an order's tax
   * lines don't add up to its tax — the same report the card refund makes.
   */
  reportError?: ReporterPort;
};

// ── Constants ────────────────────────────────────────────────────────────────

/** Spec FR-008 — gate-refund window is 15 min from order completion. */
const GATE_REFUND_WINDOW_MS = 15 * 60 * 1000;

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Refund a cash sale at the gate (FR-008 + FR-015): the till's Last sale
 * refund. The refund itself is `refundCashOrderInTx` (one implementation for
 * every cash refund path — see there for what it writes, ledger included);
 * this use case adds the gate's two rules.
 *
 * Auth: ORG_EDIT_ROLES (not SCANNER) on the event's org. Refund authority
 * deliberately exceeds sale authority.
 *
 * Window: the order must have completed within the last 15 minutes. After
 * that, an Owner, Admin, Editor or Finance member refunds it with
 * `orgRefundCashSale` (`ORG_CASH_REFUND_ROLES`), until 7 days after the event
 * ends (owner ruling 2026-10-07).
 *
 * Idempotent: re-refunding a CASH order that's already REFUNDED is a no-op
 * that returns the same shape, at any age.
 */
export async function refundCashSale(
  deps: RefundCashSaleDeps,
  rawInput: unknown,
): Promise<RefundCashSaleOutput> {
  const input = parseInput(refundCashSaleInputSchema, rawInput);

  return await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const result = await refundCashOrderInTx(tx, {
      orderId: input.orderId,
      actorHumanId: input.actorHumanId,
      via: "gate",
      now,
      authorize: async ({ event }) => {
        if (!event.orgId) {
          throw fail("EVENT_NOT_ORG_OWNED");
        }
        await requireOrgMembership({
          repos: tx,
          orgId: event.orgId,
          actorHumanId: input.actorHumanId,
          roles: ORG_EDIT_ROLES,
          errorCode: "INSUFFICIENT_ROLE",
        });
      },
      checkRefundable: ({ order }) => {
        const completedAt = order.occurredAt;
        if (now.getTime() - completedAt.getTime() > GATE_REFUND_WINDOW_MS) {
          throw {
            code: "forbidden",
            message: "gate_refund_window_expired",
            completedAt: completedAt.toISOString(),
          } as const;
        }
      },
      logger: deps.logger,
      metrics: deps.metrics,
      reportError: deps.reportError,
    });

    return {
      orderId: result.orderId,
      refundedTicketCount: result.refundedTicketCount,
      amountReturnedCents: result.amountReturnedCents,
    };
  });
}
