import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";

import { formatOrderCode } from "@th/types/order-identifier";

import { asKnownError } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import { abandonClaim } from "../../lib/idempotency-claim";
import { applyAvailabilityFloor } from "../../lib/payout-scheduling";
import { computeOrderSplits } from "../../lib/pricing/compute-order-splits";
import { attributeCreditToItems } from "../settlements/create-credits-from-order";
import { startOfUtcMonth } from "../settlements/connect-account-fee";

/**
 * Materialise a paid Stripe Billing invoice as an Order.
 *
 * This is the whole point of the membership money design: rather than build a
 * second payout pipeline for subscriptions, a membership invoice becomes an
 * ordinary Order (`kind = MEMBERSHIP`, `eventId = null`) with one OrderItem and
 * its OrderSplits — so settlement, refunds, the payee ledger and the dispute
 * holds all keep working with no membership-specific branches.
 *
 * Three things about the money are load-bearing and must not drift:
 *
 *  1. **The platform fee is 0.** Memberships are customer acquisition for
 *     ticketing, not a revenue line. The field stays wired so a future non-zero
 *     rate is a config change rather than a schema change.
 *  2. **The split basis is what Stripe COLLECTED, net of tax:**
 *     `amountGross = amount_paid − tax`. Sales tax is collected by us as
 *     merchant of record and remitted by us; paying it out to the owner would
 *     hand them money we owe a state. The basis is deliberately NOT the
 *     invoice subtotal: coupons (`total_discount_amounts`), customer credit
 *     balance and proration all legitimately make `amount_paid` differ from
 *     `subtotal + tax`, and crediting the owner the full subtotal out of a
 *     smaller collection would pay out money that never arrived.
 *  3. **Only the inexplicable refuses.** `amount_paid < tax` (collected less
 *     than the tax we owe) or `amount_paid > subtotal + tax` (collected MORE
 *     than was invoiced — unmodeled) refuse with `AMOUNT_MISMATCH` and land in
 *     the webhook DLQ for a human. Anything in between is a discount/credit,
 *     recorded auditable via `invoiceSubtotalCents` / `impliedDiscountCents`
 *     on the item meta.
 *  4. **A zero-gross invoice (trial, 100%-off) still records the Order** — the
 *     audit trail and dispute anchor — but mints NO splits and NO ledger
 *     credit: there is nothing to pay (and the payee ledger rejects
 *     zero-amount credits by design).
 *
 * IDEMPOTENCY IS THREE-DEEP, deliberately. Stripe redelivers webhooks freely and
 * a duplicate here is a duplicate *payout*:
 *
 *  1. `IdempotencyPort` keyed on the Stripe event id — cheapest, catches the
 *     ordinary redelivery.
 *  2. A read of `orders.findByStripeInvoiceId` INSIDE the transaction — catches
 *     a redelivery under a *different* event id (Stripe does emit more than one
 *     event for an invoice), and works even if the idempotency store is empty
 *     or was purged.
 *  3. The UNIQUE index on `Order.stripeInvoiceId` — catches two deliveries that
 *     race past (2) concurrently. The loser's transaction aborts and the event
 *     goes to the DLQ, which is the correct outcome: no second order exists.
 */

const IDEMPOTENCY_KEY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400; // 24h retention

export const recordMembershipInvoicePaidInputSchema = z
  .object({
    stripeInvoiceId: z.string().trim().min(3).max(255),
    stripeSubscriptionId: z.string().trim().min(3).max(255),
    stripeCustomerId: z.string().trim().min(3).max(255),
    /**
     * Stripe does not always hand us a PaymentIntent — a $0 invoice, or one
     * settled from customer balance, has none. Null is a real state, not a
     * missing field, so the order simply carries no PI link.
     */
    stripePaymentIntentId: z
      .string()
      .trim()
      .min(3)
      .max(255)
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    /** `invoice.amount_paid` — what Stripe actually collected. */
    amountPaidCents: z.number().int().nonnegative(),
    /** `invoice.subtotal` — post-discount, PRE-tax. The split basis. */
    subtotalCents: z.number().int().nonnegative(),
    /** `invoice.tax` — collected by us as merchant of record, never paid out. */
    taxAmountCents: z.number().int().nonnegative(),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((value) => value.toLowerCase()),
    invoiceCreatedAt: z.coerce.date(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    stripeEventId: z.string().trim().min(3).max(255),
  })
  .strict();

export const recordMembershipInvoicePaidOutputSchema = z
  .object({
    ok: z.literal(true),
    orderId: z.string().uuid(),
    membershipId: z.string().uuid(),
    /** True when this delivery found an order already minted for the invoice. */
    alreadyRecorded: z.boolean(),
    /**
     * True when THIS delivery wrote the payee-ledger SETTLEMENT_CREDIT. False
     * on EVERY replay — the in-transaction invoice-id replay AND the
     * idempotency-cache replays, whose stored response is overridden before
     * returning (the cache holds the ORIGINAL delivery's true) — and for a
     * zero-gross invoice (nothing to pay — see header note 4).
     */
    settlementMinted: z.boolean(),
  })
  .strict();

export type RecordMembershipInvoicePaidInput = z.infer<
  typeof recordMembershipInvoicePaidInputSchema
>;
export type RecordMembershipInvoicePaidOutput = z.infer<
  typeof recordMembershipInvoicePaidOutputSchema
>;

export type RecordMembershipInvoicePaidDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Sentry hook for the claim-cleanup swallows (lib/idempotency-claim). */
  reportError?: ReporterPort | null;
  /**
   * When true, ledger credits mature immediately (dev/test only). Mirrors
   * `createCreditsFromOrder`'s affordance so the dev/e2e seams can exercise
   * the payout batch without waiting for a month boundary.
   */
  instantPayouts?: boolean;
};

interface StoredInvoiceRecord {
  response: RecordMembershipInvoicePaidOutput;
  stripeInvoiceId: string;
}

export async function recordMembershipInvoicePaid(
  deps: RecordMembershipInvoicePaidDeps,
  rawInput: unknown,
): Promise<RecordMembershipInvoicePaidOutput> {
  const input = parseInput(recordMembershipInvoicePaidInputSchema, rawInput);
  const logger = deps.logger;

  const idempotencyKey = `membership_invoice_paid:${input.stripeEventId}`;

  const cached = await deps.idempotency.get<StoredInvoiceRecord>(idempotencyKey);
  if (cached) {
    if (cached.stripeInvoiceId !== input.stripeInvoiceId) {
      throw fail("STRIPE_EVENT_CONFLICT");
    }
    logger?.info("recordMembershipInvoicePaid.replay_cached", {
      orderId: cached.response.orderId,
      stripeInvoiceId: cached.stripeInvoiceId,
    });
    // The cached response records what the ORIGINAL delivery did; THIS
    // delivery minted nothing, and `settlementMinted` is documented as
    // per-delivery — so it is overridden, matching the in-transaction
    // invoice-id replay branch.
    return { ...cached.response, settlementMinted: false };
  }

  // Owner token for `abandonClaim` (lib/idempotency-claim.ts explains why).
  const claimOwnerToken = randomUUID();
  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_KEY_TTL_SECONDS,
    claimOwnerToken,
  );
  if (!claimed) {
    const replay =
      await deps.idempotency.get<StoredInvoiceRecord>(idempotencyKey);
    if (replay) {
      if (replay.stripeInvoiceId !== input.stripeInvoiceId) {
        throw fail("STRIPE_EVENT_CONFLICT");
      }
      // Same per-delivery override as the cached-return path above.
      return { ...replay.response, settlementMinted: false };
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const result = await recordInvoiceInternal(deps, logger, input);

    await deps.idempotency.commit<StoredInvoiceRecord>(
      idempotencyKey,
      { response: result, stripeInvoiceId: input.stripeInvoiceId },
      IDEMPOTENCY_KEEP_SECONDS,
    );

    return result;
  } catch (error) {
    await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
      useCase: "recordMembershipInvoicePaid",
      logger: deps.logger ?? null,
      reportError: deps.reportError ?? null,
    });
    throw asKnownError("record_membership_invoice_paid", error);
  }
}

async function recordInvoiceInternal(
  deps: RecordMembershipInvoicePaidDeps,
  logger: LoggerPort | undefined,
  input: RecordMembershipInvoicePaidInput,
): Promise<RecordMembershipInvoicePaidOutput> {
  return deps.repos.tx(async (tx) => {
    // ── Idempotency, layer 2 ────────────────────────────────────────────────
    // Read before anything else. It needs nothing but the invoice id, and a
    // redelivery must be a pure no-op returning the SAME order.
    const existing = await tx.orders.findByStripeInvoiceId(
      input.stripeInvoiceId,
    );
    if (existing) {
      logger?.info("recordMembershipInvoicePaid.replay_order", {
        orderId: existing.id,
        stripeInvoiceId: input.stripeInvoiceId,
      });
      return recordMembershipInvoicePaidOutputSchema.parse({
        ok: true,
        orderId: existing.id,
        // Re-resolved from the subscription rather than read off the order item,
        // because `OrderItemRecord` does not expose `membershipId` today. This
        // keeps the replay response identical in shape to the first-write one.
        membershipId: await resolveMembershipIdForReplay(
          tx,
          input.stripeSubscriptionId,
          existing.id,
        ),
        alreadyRecorded: true,
        // Nothing was minted by THIS delivery — the first one owns it.
        settlementMinted: false,
      });
    }

    const membership = await tx.memberships.findByStripeSubscriptionId(
      input.stripeSubscriptionId,
    );
    if (!membership) {
      throw fail("MEMBERSHIP_NOT_FOUND", {
        meta: { stripeSubscriptionId: input.stripeSubscriptionId },
      });
    }

    const tier = await tx.membershipTiers.findById(membership.tierId);
    if (!tier) {
      throw fail("MEMBERSHIP_TIER_NOT_FOUND", {
        meta: { membershipId: membership.id, tierId: membership.tierId },
      });
    }

    // ── Money invariant (header notes 2–3) ──────────────────────────────────
    // The split basis is what Stripe actually collected, net of tax:
    // `amount_paid − tax`. Coupons, customer credit balance and proration all
    // legitimately make `amount_paid < subtotal + tax`, and refusing those
    // would permanently DLQ that member's real revenue. Only the inexplicable
    // refuses: collecting less than the tax we owe, or MORE than was invoiced.
    const maxExplainedPaidCents = input.subtotalCents + input.taxAmountCents;
    if (
      input.amountPaidCents < input.taxAmountCents ||
      input.amountPaidCents > maxExplainedPaidCents
    ) {
      throw fail("AMOUNT_MISMATCH", {
        meta: {
          stripeInvoiceId: input.stripeInvoiceId,
          amountPaidCents: input.amountPaidCents,
          taxAmountCents: input.taxAmountCents,
          maxExplainedPaidCents,
        },
      });
    }

    /** The order gross and split/settlement basis. May be 0 (trial, 100% off). */
    const amountGrossCents = input.amountPaidCents - input.taxAmountCents;
    /** ≥ 0 by the guard above. Auditable on the item meta. */
    const impliedDiscountCents = input.subtotalCents - amountGrossCents;

    const payeeId = await resolveOwnerPayeeId(tx, tier);

    const now = deps.clock.now();

    const created = await tx.orders.createPending({
      kind: "MEMBERSHIP",
      // A membership has no event. Every ticketing read narrows on
      // `kind = TICKETING`, so this null is inert to them.
      eventId: null,
      buyerHumanId: membership.memberHumanId,
      // Gross is what Stripe collected NET of tax (header note 2); tax rides
      // its own column exactly as the ticketing path stores it.
      amountGrossCents,
      taxAmountCents: input.taxAmountCents,
      // 0% platform fee. Not a placeholder — see the header note.
      feesPlatformCents: 0,
      currency: input.currency,
      source: "PRIMARY",
      stripeInvoiceId: input.stripeInvoiceId,
      ...(input.stripePaymentIntentId
        ? { stripePaymentIntentId: input.stripePaymentIntentId }
        : {}),
      feePolicySnapshot: {
        kind: "membership",
        platformFeePct: 0,
        platformFixedCents: 0,
        note: "Memberships settle at 0% platform fee (recurring-memberships spec).",
      },
      items: [
        {
          kind: "membership",
          membershipId: membership.id,
          // Never a ticket type: nothing was admitted, a period was funded.
          ticketTypeId: null,
          qty: 1,
          unitPriceCents: amountGrossCents,
          amountCents: amountGrossCents,
          meta: {
            tierId: tier.id,
            tierName: tier.name,
            membershipId: membership.id,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeSubscriptionId: input.stripeSubscriptionId,
            stripeCustomerId: input.stripeCustomerId,
            periodStart: input.periodStart.toISOString(),
            periodEnd: input.periodEnd.toISOString(),
            invoiceCreatedAt: input.invoiceCreatedAt.toISOString(),
            // Auditability for discounted / credit-covered invoices: the
            // invoiced subtotal and how much of it Stripe did NOT collect
            // (coupon, credit balance, proration). gross + implied = subtotal.
            invoiceSubtotalCents: input.subtotalCents,
            impliedDiscountCents,
          },
        },
      ],
    });

    await tx.orders.markSucceeded(created.id);

    // ── Zero-gross short-circuit (header note 4) ────────────────────────────
    // A trial or 100%-off invoice collected nothing. The Order above is the
    // audit trail and dispute anchor and MUST exist; splits and the ledger
    // credit must NOT — there is nothing to pay, and the payee ledger rejects
    // zero-amount credits by design. This sits BEFORE the NO_SPLITS_FOUND
    // guard by construction: zero splits for zero money is the correct
    // outcome, not a failure.
    if (amountGrossCents === 0) {
      await writeAuditAndLog(tx, logger, {
        input,
        orderId: created.id,
        membershipId: membership.id,
        tierId: tier.id,
        payeeId,
        amountGrossCents,
        impliedDiscountCents,
        splitsTotalCents: 0,
        ledgerEntryIds: [],
        availableAt: null,
        settlementMinted: false,
        at: now,
      });
      return recordMembershipInvoicePaidOutputSchema.parse({
        ok: true,
        orderId: created.id,
        membershipId: membership.id,
        alreadyRecorded: false,
        settlementMinted: false,
      });
    }

    // ── Splits ──────────────────────────────────────────────────────────────
    // Routed through `computeOrderSplits` with a single 100% line rather than
    // written directly. There is exactly one splits implementation in this
    // codebase and it owns the rounding and remainder-distribution rules; a
    // hand-written row here would be a second one that agrees today and drifts
    // the first time a reserve or a platform cut is introduced. With one line at
    // 100% it is a no-op that returns the basis unchanged, which is precisely
    // the property worth asserting rather than assuming.
    const splitsResult = computeOrderSplits({
      amountCents: amountGrossCents,
      lines: [
        {
          id: `membership:${membership.id}`,
          payeeId,
          percent: 100,
        },
      ],
    });

    await tx.splits.upsertForOrder(created.id, splitsResult.splits);

    // ── Ledger credit ───────────────────────────────────────────────────────
    // The payee ledger is the source of truth for what a payee is owed
    // (ledger-authoritative-settlement spec §2/§3). The ticketing path writes
    // these in `createCreditsFromOrder`, but that use case is event-shaped —
    // it derives the maturity date from the EVENT's end time and the event's
    // payout terms, and a membership has neither. So the credit is written
    // here, in the SAME transaction as the order. That placement is also the
    // idempotency story: the invoice-id replay read above (layer 2) returns
    // before reaching this point on a redelivery, a delivery that loses the
    // race on the unique `Order.stripeInvoiceId` index (layer 3) aborts the
    // whole transaction, rolling the credit back with the order — and the
    // repo's `settlement-credit:${orderId}:${payeeId}` unique key makes any
    // straggler replay a pure no-op.
    //
    // availableAt buckets to the first day of the NEXT UTC month, midnight
    // UTC, relative to when Stripe created the invoice — the SAME monthly rule
    // the settlement mint used (then floored; see below). The spec fixes
    // membership payouts as MONTHLY; every invoice in a calendar month matures
    // at the same instant, so one batch cycle pays a payee's whole month in
    // one transfer. One payout event per month is the unit Stripe bills the
    // $2 active-account fee on, and the unit the venue-facing break-even table
    // in the spec assumes. (There is no longer a shared settlement row to fold
    // into — credits are per order, per payee — so the old cross-currency fold
    // hazard is structurally gone: each credit carries its own currency.)
    //
    // Re-read the splits: `upsertForOrder` returns void, and the credit
    // amounts come from the persisted rows.
    const splitRows = await tx.splits.getForOrder(created.id);
    if (!splitRows.length) throw fail("NO_SPLITS_FOUND");

    // Maturity = the monthly bucket above, CLAMPED by the Stripe
    // balance-availability floor, exactly as the ticketing writer is
    // (`createCreditsFromOrder`). `run-batch` transfers without
    // `source_transaction`, so it spends the platform's AVAILABLE balance; the
    // monthly rule alone can mature a credit before the money can possibly be
    // there. An invoice created Mon 2026-08-31 buckets to Tue 2026-09-01, but
    // a card charged that Monday is not available until the Wednesday. A MAX,
    // so it is a no-op for every invoice created before roughly the 28th —
    // only the last days of a month move.
    //
    // Basis is `clock.now()`: this runs inside the `invoice.payment_succeeded`
    // handler, so "now" is when the charge settled. `invoiceCreatedAt` is the
    // BUCKETING input (which month the payee is paid for) and stays that.
    const availableAt = deps.instantPayouts
      ? now // Dev/test: immediately eligible for the batch runner
      : applyAvailabilityFloor(firstOfNextUtcMonth(input.invoiceCreatedAt), now);

    // Item-level attribution for the credit metadata (partial refunds read
    // per-item contributions from here). A membership order has exactly one
    // item today, but the helper handles any shape.
    const orderItems = await tx.orderItems.listByOrderId(created.id);

    // Grouped by payee to mirror `createCreditsFromOrder`. Today there is
    // exactly one 100% line, but a future reserve or platform cut must not
    // silently break this path.
    const byPayee = new Map<string, typeof splitRows>();
    for (const row of splitRows) {
      const arr = byPayee.get(row.payeeId) ?? [];
      arr.push(row);
      byPayee.set(row.payeeId, arr);
    }

    const ledgerEntryIds: string[] = [];

    for (const [creditPayeeId, rows] of byPayee.entries()) {
      const amount = rows.reduce((acc, r) => acc + r.amountCents, 0);
      // amountGrossCents > 0 here (the zero-gross short-circuit returned
      // above) and the single line is 100%, but a future zero-amount payee
      // must be skipped: the ledger rejects amountCents <= 0 by design.
      if (amount <= 0) continue;

      const entry = await tx.payeeLedger.settlementCredit({
        idempotencyKey: `settlement-credit:${created.id}:${creditPayeeId}`,
        payeeId: creditPayeeId,
        amountCents: amount,
        currency: input.currency,
        orderId: created.id,
        availableAt,
        description: `Membership revenue — order ${formatOrderCode(created.id)}`,
        metadata: { items: attributeCreditToItems(orderItems, amount) },
        sourceKind: "order_split",
        sourceId: created.id,
      });
      ledgerEntryIds.push(entry.id);
    }

    await writeAuditAndLog(tx, logger, {
      input,
      orderId: created.id,
      membershipId: membership.id,
      tierId: tier.id,
      payeeId,
      amountGrossCents,
      impliedDiscountCents,
      splitsTotalCents: splitsResult.totalCents,
      ledgerEntryIds,
      availableAt,
      settlementMinted: true,
      at: now,
    });

    return recordMembershipInvoicePaidOutputSchema.parse({
      ok: true,
      orderId: created.id,
      membershipId: membership.id,
      alreadyRecorded: false,
      settlementMinted: true,
    });
  });
}

/**
 * One audit + info-log implementation for both exits (zero-gross short-circuit
 * and the normal ledger-credit path), so the two records cannot drift apart.
 */
async function writeAuditAndLog(
  tx: TxRepos,
  logger: LoggerPort | undefined,
  data: {
    input: RecordMembershipInvoicePaidInput;
    orderId: string;
    membershipId: string;
    tierId: string;
    payeeId: string;
    amountGrossCents: number;
    impliedDiscountCents: number;
    splitsTotalCents: number;
    ledgerEntryIds: string[];
    availableAt: Date | null;
    settlementMinted: boolean;
    at: Date;
  },
): Promise<void> {
  const { input } = data;
  await tx.audit.log({
    entity: "order",
    entityId: data.orderId,
    action: "membership_invoice_paid",
    data: {
      stripeEventId: input.stripeEventId,
      stripeInvoiceId: input.stripeInvoiceId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripePaymentIntentId: input.stripePaymentIntentId,
      membershipId: data.membershipId,
      tierId: data.tierId,
      payeeId: data.payeeId,
      amountPaidCents: input.amountPaidCents,
      amountGrossCents: data.amountGrossCents,
      invoiceSubtotalCents: input.subtotalCents,
      impliedDiscountCents: data.impliedDiscountCents,
      taxAmountCents: input.taxAmountCents,
      feesPlatformCents: 0,
      splitsTotalCents: data.splitsTotalCents,
      currency: input.currency,
      ledgerEntryIds: data.ledgerEntryIds,
      availableAt: data.availableAt?.toISOString() ?? null,
      settlementMinted: data.settlementMinted,
    },
    at: data.at,
  });

  logger?.info("recordMembershipInvoicePaid.recorded", {
    orderId: data.orderId,
    membershipId: data.membershipId,
    stripeInvoiceId: input.stripeInvoiceId,
    amountGrossCents: data.amountGrossCents,
    taxAmountCents: input.taxAmountCents,
    settlementMinted: data.settlementMinted,
  });
}

/**
 * First day of the NEXT UTC calendar month, at midnight UTC.
 *
 * Built on `startOfUtcMonth` so membership payout months and the $2
 * Connect account-fee month share ONE boundary definition — the fee logic in
 * `connect-account-fee.ts` asks "did this account already pay out this UTC
 * month?", and drifting the two boundaries apart could double- or zero-count
 * a month. `Date.UTC` normalises the month overflow, so a December invoice
 * rolls into January of the NEXT year. Explicit UTC methods throughout; local
 * time never touches a payout date.
 */
function firstOfNextUtcMonth(at: Date): Date {
  const monthStart = startOfUtcMonth(at);
  return new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
}

/**
 * Resolve the Payee that receives 100% of a tier's membership revenue.
 *
 * `MembershipTier` carries ownerOrgId XOR ownerHumanId. A tier with neither is a
 * broken row, and both failure shapes land on `PAYEE_NOT_READY` for the same
 * operational reason: there is nowhere to send the money, so the invoice must
 * not become a payable order.
 */
async function resolveOwnerPayeeId(
  tx: TxRepos,
  tier: { id: string; ownerOrgId: string | null; ownerHumanId: string | null },
): Promise<string> {
  const subject = tier.ownerOrgId
    ? ({ type: "ORGANIZATION", id: tier.ownerOrgId } as const)
    : tier.ownerHumanId
      ? ({ type: "HUMAN", id: tier.ownerHumanId } as const)
      : null;

  if (!subject) {
    throw fail("PAYEE_NOT_READY", {
      meta: { tierId: tier.id, reason: "tier_has_no_owner" },
    });
  }

  const payee = await tx.payees.getBySubject(subject);
  if (!payee) {
    throw fail("PAYEE_NOT_READY", {
      meta: {
        tierId: tier.id,
        subjectType: subject.type,
        subjectId: subject.id,
        reason: "no_payee_for_owner",
      },
    });
  }
  return payee.id;
}

/**
 * Membership id for the replay branch.
 *
 * Only ever called when an order for this invoice already exists, so the
 * subscription is by construction one we track; a missing row would mean the
 * membership was deleted out from under a settled order, which is a real
 * inconsistency and is surfaced rather than papered over.
 */
async function resolveMembershipIdForReplay(
  tx: TxRepos,
  stripeSubscriptionId: string,
  orderId: string,
): Promise<string> {
  const membership =
    await tx.memberships.findByStripeSubscriptionId(stripeSubscriptionId);
  if (!membership) {
    throw fail("MEMBERSHIP_NOT_FOUND", {
      meta: { stripeSubscriptionId, orderId },
    });
  }
  return membership.id;
}
