import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import { fail } from "@th/errors";

import { cashRefundWindowClosesAt } from "../../lib/cash-refund-window";
import { eventEndedAt } from "../../lib/event-ended";
import { parseInput } from "../../lib/io";
import {
  ORG_EDIT_ROLES,
  ORG_FINANCE_ROLES,
  requireScannerAccessOnOrg,
} from "../../lib/rbac";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { refundCashOrderInTx } from "./_shared/refund-cash-order-core";

// ── Who may refund ───────────────────────────────────────────────────────────

/**
 * The org roles that may refund a door cash sale after the till's 15 minutes:
 * Owner, Admin, Editor and Finance. The union of two sets, one per ruling:
 *  - ORG_EDIT_ROLES: Editors refund cash from the Sell screen's list (owner
 *    ruling 2026-10-08);
 *  - ORG_FINANCE_ROLES: Finance refunds any sale, card or cash (decision of
 *    2026-10-10), from web Orders.
 *
 * The one definition of that set. `orgRefundCashSale`'s gate reads it, and so
 * does `listEventCashSales`'s `canRefund`, so the list cannot offer a refund
 * the gate refuses.
 */
export const ORG_CASH_REFUND_ROLES: readonly OrgRole[] = [
  ...new Set<OrgRole>([...ORG_EDIT_ROLES, ...ORG_FINANCE_ROLES]),
];

// ── Schema ───────────────────────────────────────────────────────────────────

export const orgRefundCashSaleInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    /** The org the actor is acting for; the order's event must belong to it. */
    orgId: z.uuid(),
    orderId: z.uuid(),
    /** Optional reason, kept on the audit trail. */
    note: plainTextMultilineOptional(500).optional(),
  })
  .strict();

export type OrgRefundCashSaleInput = z.infer<
  typeof orgRefundCashSaleInputSchema
>;

export const orgRefundCashSaleOutputSchema = z.object({
  orderId: z.uuid(),
  refundedTicketCount: z.number().int().nonnegative(),
  /**
   * Cash for the organiser to hand back: what the buyer paid, as recorded —
   * ticket net of discount + tax; plus the platform fee on a sale recorded
   * before the owner ruling of 2026-10-08 (cash = no platform fee). 0 for a
   * comp.
   */
  amountReturnedCents: z.number().int().nonnegative(),
  /**
   * What the organiser no longer owes: the CASH_SALE_DEBIT this refund
   * reversed, at the amount the debit recorded. That is the tax for a sale
   * since the owner ruling of 2026-10-08 (cash = no platform fee), and fee +
   * tax for one before it; the name predates the ruling. 0 for a comp, a
   * tax-free sale, a cash order recorded before the door was priced, and a
   * replay of an earlier refund.
   */
  feeAndTaxNoLongerOwedCents: z.number().int().nonnegative(),
  /** True when the order had already been refunded; nothing was written. */
  alreadyRefunded: z.boolean(),
});

export type OrgRefundCashSaleOutput = z.infer<
  typeof orgRefundCashSaleOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type OrgRefundCashSaleDeps = {
  repos: Repos;
  /** The platform-admin override (`requireScannerAccessOnOrg`). */
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /**
   * The per-item tax allocation reports (never throws) when an order's tax
   * lines don't add up to its tax — the same report the card refund makes.
   */
  reportError?: ReporterPort | null;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Refund a door cash sale (or comp) after the till's 15 minutes, as an Owner,
 * Admin, Editor or Finance member of the org (`ORG_CASH_REFUND_ROLES`). Owner
 * ruling 2026-10-07: "an organiser who gives people their money back
 * shouldn't pay fee + tax for it"; since the owner ruling of 2026-10-08 a
 * cash sale carries no platform fee, so for a new sale that is the tax.
 *
 * The refund is `refundCashOrderInTx`, the same one the till and an event
 * cancellation run: the full total is recorded as handed back, tickets are
 * voided, any fee waiver an older sale spent comes back, and the sale's
 * CASH_SALE_DEBIT is reversed as recorded, so what it claimed (tax; fee +
 * tax on a sale before 2026-10-08) stops coming off the payout. No platform money
 * moves; the organiser hands the cash back themselves.
 *
 * WINDOW: until 7 days after the event ends (`eventEndedAt`: `endsAt`, or
 * `startsAt` when there is no end). After that, CASH_REFUND_WINDOW_CLOSED
 * (`meta.windowClosedAt`). A platform admin is not bound by it: the refund
 * goes through and is attributed `via: "platform"` on the audit row and the
 * ledger reversal. Cancelling the event is not bound by it either.
 *
 * AUTH: `requireScannerAccessOnOrg` with ORG_CASH_REFUND_ROLES on `orgId` —
 * org membership, or the platform-admin override every POS action already
 * has — checked before the order is read. Scanner and Viewer are refused
 * (INSUFFICIENT_ROLE). Every member role is held to the window alike; an
 * Editor reaches this from the Sell screen's cash list, a Finance member from
 * web Orders (Finance cannot open the Sell screen: not in ORG_SCAN_ROLES).
 * An order whose event is not this org's (another org's, or ownerless)
 * answers ORDER_NOT_FOUND, so the procedure is no oracle for other orgs'
 * order ids. Card orders are refused (NOT_A_CASH_ORDER); they go through
 * `orgRefundFullOrder`.
 *
 * Idempotent: refunding an already-REFUNDED cash order returns the same
 * totals with `alreadyRefunded: true` and writes nothing, whatever the date.
 * Concurrent refunds claim the order with a compare-and-set, so one wins.
 */
export async function orgRefundCashSale(
  deps: OrgRefundCashSaleDeps,
  rawInput: unknown,
): Promise<OrgRefundCashSaleOutput> {
  const input = parseInput(orgRefundCashSaleInputSchema, rawInput);

  return await deps.repos.tx(async (tx) => {
    const access = await requireScannerAccessOnOrg({
      repos: tx,
      authz: deps.authz,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_CASH_REFUND_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });

    const now = deps.clock.now();
    const result = await refundCashOrderInTx(tx, {
      orderId: input.orderId,
      actorHumanId: input.actorHumanId,
      via: access.via === "platform_admin" ? "platform" : "org",
      now,
      authorize: async ({ event }) => {
        if (event.orgId !== input.orgId) {
          throw fail("ORDER_NOT_FOUND");
        }
      },
      checkRefundable: async ({ event }) => {
        if (access.via === "platform_admin") return;
        const times = { startsAt: event.startsAt, endsAt: event.endsAt ?? null };
        const endedAt = eventEndedAt(times);
        const windowClosedAt = cashRefundWindowClosesAt(times);
        if (now.getTime() <= windowClosedAt.getTime()) return;
        // An org member who is ALSO a platform admin passed the membership
        // branch above; past the window they act as the platform.
        const staff = await deps.authz.hasStaffRole({
          actorHumanId: input.actorHumanId,
          requiredRoles: ["ADMIN"],
        });
        if (staff.allowed) return { via: "platform" };
        throw fail("CASH_REFUND_WINDOW_CLOSED", {
          message: "cash_refund_window_closed",
          meta: {
            eventEndedAt: endedAt.toISOString(),
            windowClosedAt: windowClosedAt.toISOString(),
          },
        });
      },
      logger: deps.logger,
      metrics: deps.metrics,
      reportError: deps.reportError,
    });

    if (!result.alreadyRefunded && input.note) {
      // The note rides a second row, as `orgRefundFullOrder` attaches its
      // note — the shared refund's audit row stays one shape for every path.
      await tx.audit.log({
        entity: "order",
        entityId: result.orderId,
        action: "org_cash_refund_note",
        data: {
          orgId: input.orgId,
          actorHumanId: input.actorHumanId,
          note: input.note,
        },
        at: now,
      });
    }

    return orgRefundCashSaleOutputSchema.parse({
      orderId: result.orderId,
      refundedTicketCount: result.refundedTicketCount,
      amountReturnedCents: result.amountReturnedCents,
      feeAndTaxNoLongerOwedCents: result.cashSaleDebitReversedCents,
      alreadyRefunded: result.alreadyRefunded,
    });
  });
}
