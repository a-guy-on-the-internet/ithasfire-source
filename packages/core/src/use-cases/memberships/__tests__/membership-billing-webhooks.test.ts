import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MembershipRecord } from "@th/ports/repos/memberships";
import type { MembershipTierRecord } from "@th/ports/repos/membership-tiers";
import type { CreatePendingOrderInput } from "@th/ports/repos/orders";

import { recordMembershipInvoicePaid } from "../record-membership-invoice-paid";
import { recordMembershipPaymentFailed } from "../record-membership-payment-failed";
import { syncMembershipFromStripe } from "../sync-membership-from-stripe";

const TIER_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP_ID = "66666666-6666-4666-8666-666666666666";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "77777777-7777-4777-8777-777777777777";
const PAYEE_ID = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const PERIOD_END = new Date("2026-09-10T12:00:00.000Z");

/** $10.00 tier at Nashville's 9.75% → $0.98 tax, $10.98 charged. */
const SUBTOTAL = 1000;
const TAX = 98;
const AMOUNT_PAID = SUBTOTAL + TAX;

describe("recordMembershipInvoicePaid", () => {
  it("materialises exactly one MEMBERSHIP order with one membership item", async () => {
    const ctx = makeCtx();

    const result = await ctx.run(invoiceInput());

    expect(result).toMatchObject({ ok: true, alreadyRecorded: false });
    expect(ctx.orders.createPending).toHaveBeenCalledTimes(1);

    const order = ctx.createdOrder();
    expect(order.kind).toBe("MEMBERSHIP");
    // A membership has no event. Every ticketing read narrows on kind.
    expect(order.eventId).toBeNull();
    expect(order.buyerHumanId).toBe(MEMBER_ID);
    expect(order.source).toBe("PRIMARY");
    expect(order.stripeInvoiceId).toBe("in_1");
    expect(order.stripePaymentIntentId).toBe("pi_1");

    expect(order.items).toHaveLength(1);
    const item = order.items[0]!;
    expect(item.kind).toBe("membership");
    expect(item.membershipId).toBe(MEMBERSHIP_ID);
    // Nothing was admitted — a period was funded.
    expect(item.ticketTypeId).toBeNull();
    expect(item.qty).toBe(1);
    expect(item.unitPriceCents).toBe(SUBTOTAL);
    expect(item.amountCents).toBe(SUBTOTAL);
    expect(item.meta).toMatchObject({
      tierId: TIER_ID,
      tierName: "Sustaining Member",
      membershipId: MEMBERSHIP_ID,
      periodStart: NOW.toISOString(),
      periodEnd: PERIOD_END.toISOString(),
    });

    // The order is not left PENDING — settlement reads SUCCEEDED orders.
    expect(ctx.orders.markSucceeded).toHaveBeenCalledWith(result.orderId);
  });

  it("pays the owner 100% of the SUBTOTAL — tax is ours to remit, not theirs", async () => {
    const ctx = makeCtx();

    const result = await ctx.run(invoiceInput());

    expect(ctx.splits.upsertForOrder).toHaveBeenCalledTimes(1);
    const [orderId, rows] = ctx.splits.upsertForOrder.mock.calls[0]!;
    expect(orderId).toBe(result.orderId);
    expect(rows).toEqual([{ payeeId: PAYEE_ID, amountCents: SUBTOTAL }]);

    // Zero-sum against the basis, and explicitly NOT against subtotal + tax:
    // paying out the sales tax would hand the owner money we owe a state.
    const total = rows.reduce(
      (sum: number, row: { amountCents: number }) => sum + row.amountCents,
      0,
    );
    expect(total).toBe(SUBTOTAL);
    expect(total).not.toBe(AMOUNT_PAID);
  });

  it("charges a 0% platform fee — this is the product promise, not a default", async () => {
    const ctx = makeCtx();

    await ctx.run(invoiceInput());

    expect(ctx.createdOrder().feesPlatformCents).toBe(0);
  });

  it("takes tax from the invoice rather than recomputing it", async () => {
    // Stripe applied the rate; we must persist what was actually billed, not a
    // rate we look up again at webhook time (which may since have changed).
    const ctx = makeCtx();

    await ctx.run(
      invoiceInput({
        subtotalCents: 500,
        taxAmountCents: 49,
        amountPaidCents: 549,
      }),
    );

    const order = ctx.createdOrder();
    expect(order.taxAmountCents).toBe(49);
    // Gross stays PRE-tax so the split basis and the fee basis agree.
    expect(order.amountGrossCents).toBe(500);
  });

  it("replaying the SAME event mints no second order and returns the same id", async () => {
    const ctx = makeCtx();

    const first = await ctx.run(invoiceInput());
    const second = await ctx.run(invoiceInput());

    expect(second.orderId).toBe(first.orderId);
    expect(ctx.orders.createPending).toHaveBeenCalledTimes(1);
    expect(ctx.splits.upsertForOrder).toHaveBeenCalledTimes(1);
  });

  it("a transient failure after the tx RELEASES the claim (owner token) and the replay mints exactly one settlement credit", async () => {
    // lib/idempotency-claim.ts: the DLQ replay is the only retry path, so a
    // `failed:` marker would refuse it for 15 minutes. The tx commits, then
    // the idempotency `commit` rejects once.
    const ctx = makeCtx();
    const idem = (ctx.deps as unknown as { idempotency: ReturnType<typeof makeIdempotency> })
      .idempotency;
    idem.commit.mockRejectedValueOnce(new Error("redis blip"));

    await expect(ctx.run(invoiceInput())).rejects.toMatchObject({
      code: "dependency_failed",
    });

    expect(idem.fail).not.toHaveBeenCalled();
    expect(idem.release).toHaveBeenCalledTimes(1);
    const [beginKey, , beginToken] = idem.begin.mock.calls[0] as [string, number, string];
    expect(beginToken).toEqual(expect.any(String));
    expect(idem.release).toHaveBeenCalledWith(beginKey, beginToken);
    expect(ctx.payeeLedger.settlementCredit).toHaveBeenCalledTimes(1);

    // Replay: same invoice → same order (unique invoice id) → the ledger's
    // key-dedupe returns the existing credit; nothing is minted twice.
    const replay = await ctx.run(invoiceInput());
    expect(replay).toMatchObject({ ok: true });
    expect(ctx.orders.createPending).toHaveBeenCalledTimes(1);
    expect(ctx.ledgerEntriesByKey.size).toBe(1);
    expect(idem.commit).toHaveBeenCalledTimes(2);
  });

  it("a cached (same-event) replay reports settlementMinted:false — only the delivery that minted says true", async () => {
    // `settlementMinted` is per-DELIVERY by contract. The idempotency cache
    // stores the ORIGINAL response (whose settlementMinted was true), so the
    // cached-return path must override it — matching what the in-transaction
    // invoice-id replay branch already reports.
    const ctx = makeCtx();

    const first = await ctx.run(invoiceInput());
    const second = await ctx.run(invoiceInput());

    expect(first.settlementMinted).toBe(true);
    expect(second.settlementMinted).toBe(false);
    expect(second.orderId).toBe(first.orderId);
  });

  it("replaying under a DIFFERENT event id still mints no second order", async () => {
    // The idempotency key cannot catch this one — Stripe emits more than one
    // event per invoice, and the key is per-event. The in-transaction read on
    // `stripeInvoiceId` is what holds.
    const ctx = makeCtx();

    const first = await ctx.run(invoiceInput());
    const second = await ctx.run(invoiceInput({ stripeEventId: "evt_2" }));

    expect(second.orderId).toBe(first.orderId);
    expect(second.alreadyRecorded).toBe(true);
    expect(ctx.orders.createPending).toHaveBeenCalledTimes(1);
  });

  // ── The money basis rule ────────────────────────────────────────────────
  // gross = amount_paid − tax. Coupons, credit balance and proration make
  // amount_paid legitimately smaller than subtotal + tax; only the
  // inexplicable refuses (paid < tax, or paid > subtotal + tax).
  describe("amount basis", () => {
    it("a coupon invoice pays the owner what Stripe COLLECTED, not the subtotal", async () => {
      // subtotal 1000, tax 0, paid 800 (e.g. a 200-off coupon): the owner is
      // owed 800 — crediting 1000 would pay out money that never arrived.
      const ctx = makeCtx();

      const result = await ctx.run(
        invoiceInput({
          subtotalCents: 1000,
          taxAmountCents: 0,
          amountPaidCents: 800,
        }),
      );

      const order = ctx.createdOrder();
      expect(order.amountGrossCents).toBe(800);
      const item = order.items[0]!;
      expect(item.amountCents).toBe(800);
      // Auditable: the invoiced subtotal and the uncollected delta survive.
      expect(item.meta).toMatchObject({
        invoiceSubtotalCents: 1000,
        impliedDiscountCents: 200,
      });

      const [, rows] = ctx.splits.upsertForOrder.mock.calls[0]!;
      expect(rows).toEqual([{ payeeId: PAYEE_ID, amountCents: 800 }]);
      expect(result.settlementMinted).toBe(true);
      expect(ctx.payeeLedger.settlementCredit).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 800 }),
      );
    });

    it("refuses when Stripe collected MORE than subtotal + tax (unmodeled)", async () => {
      const ctx = makeCtx();

      await expect(
        ctx.run(invoiceInput({ amountPaidCents: SUBTOTAL + TAX + 1 })),
      ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
      expect(ctx.orders.createPending).not.toHaveBeenCalled();
    });

    it("refuses when Stripe collected less than the tax we owe", async () => {
      const ctx = makeCtx();

      await expect(
        ctx.run(invoiceInput({ amountPaidCents: TAX - 1 })),
      ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
      expect(ctx.orders.createPending).not.toHaveBeenCalled();
    });
  });

  // ── Zero-gross invoices (trial / 100% off) ─────────────────────────────────
  describe("zero-gross invoice", () => {
    it("records the Order but mints NO splits and NO ledger credit", async () => {
      // The order is the audit trail and dispute anchor; the payee ledger
      // rejects zero-amount credits by design (nothing to pay).
      const ctx = makeCtx();

      const result = await ctx.run(
        invoiceInput({
          subtotalCents: 1000,
          taxAmountCents: 0,
          amountPaidCents: 0,
        }),
      );

      expect(result).toMatchObject({
        ok: true,
        alreadyRecorded: false,
        settlementMinted: false,
      });
      expect(ctx.orders.createPending).toHaveBeenCalledTimes(1);
      expect(ctx.createdOrder().amountGrossCents).toBe(0);
      expect(ctx.orders.markSucceeded).toHaveBeenCalledTimes(1);

      // NOTHING minted: no splits, no ledger credit — and no settlement rows
      // either (Step B of the ledger cutover: revenue never writes them) and
      // no NO_SPLITS_FOUND (zero splits for zero money is the outcome, not a
      // failure).
      expect(ctx.splits.upsertForOrder).not.toHaveBeenCalled();
      expect(ctx.payeeLedger.settlementCredit).not.toHaveBeenCalled();
      expect(ctx.settlements.create).not.toHaveBeenCalled();
      expect(ctx.settlements.incrementAmount).not.toHaveBeenCalled();
      expect(ctx.settlementLineRows).toHaveLength(0);

      // The audit trail still exists.
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "membership_invoice_paid",
          data: expect.objectContaining({
            amountGrossCents: 0,
            settlementMinted: false,
            ledgerEntryIds: [],
          }),
        }),
      );
    });

    it("stays idempotent on replay", async () => {
      const ctx = makeCtx();
      const input = invoiceInput({
        subtotalCents: 1000,
        taxAmountCents: 0,
        amountPaidCents: 0,
      });

      const first = await ctx.run(input);
      const second = await ctx.run({ ...input, stripeEventId: "evt_replay0" });

      expect(second.orderId).toBe(first.orderId);
      expect(second.alreadyRecorded).toBe(true);
      expect(second.settlementMinted).toBe(false);
      expect(ctx.orders.createPending).toHaveBeenCalledTimes(1);
      expect(ctx.payeeLedger.settlementCredit).not.toHaveBeenCalled();
    });
  });

  it("refuses an invoice for a subscription we do not track", async () => {
    const ctx = makeCtx({ membership: null });

    await expect(ctx.run(invoiceInput())).rejects.toMatchObject({
      code: "MEMBERSHIP_NOT_FOUND",
    });
    expect(ctx.orders.createPending).not.toHaveBeenCalled();
  });

  it("refuses when the owner has no payee — there is nowhere to send the money", async () => {
    const ctx = makeCtx({ payee: null });

    await expect(ctx.run(invoiceInput())).rejects.toMatchObject({
      code: "PAYEE_NOT_READY",
    });
    expect(ctx.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.splits.upsertForOrder).not.toHaveBeenCalled();
  });

  it("routes a human-owned tier's revenue to the HUMAN payee", async () => {
    const ctx = makeCtx({
      tier: buildTier({ ownerOrgId: null, ownerHumanId: MEMBER_ID }),
    });

    await ctx.run(invoiceInput());

    expect(ctx.payees.getBySubject).toHaveBeenCalledWith({
      type: "HUMAN",
      id: MEMBER_ID,
    });
  });

  it("writes the audit row inside the transaction", async () => {
    const ctx = makeCtx();

    const result = await ctx.run(invoiceInput());

    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        entityId: result.orderId,
        action: "membership_invoice_paid",
        data: expect.objectContaining({
          feesPlatformCents: 0,
          amountGrossCents: SUBTOTAL,
          taxAmountCents: TAX,
          payeeId: PAYEE_ID,
        }),
      }),
    );
  });

  it("rejects a conflicting replay of the same event id", async () => {
    // Same event, different invoice = something is very wrong upstream.
    const ctx = makeCtx();

    await ctx.run(invoiceInput());

    await expect(
      ctx.run(invoiceInput({ stripeInvoiceId: "in_other" })),
    ).rejects.toMatchObject({ code: "STRIPE_EVENT_CONFLICT" });
  });

  // ── Ledger credit ──────────────────────────────────────────────────────────
  // Without a SETTLEMENT_CREDIT entry the money is unreachable forever: the
  // payee ledger is the source of truth for what a payee is owed
  // (ledger-authoritative-settlement spec §2/§3).
  describe("ledger credit", () => {
    it("writes ONE credit for the subtotal, maturing the first of the NEXT UTC month", async () => {
      const ctx = makeCtx();

      // invoiceCreatedAt = NOW = 2026-08-10, mid-month.
      await ctx.run(invoiceInput());

      expect(ctx.payeeLedger.settlementCredit).toHaveBeenCalledTimes(1);
      const credit = ctx.payeeLedger.settlementCredit.mock.calls[0]![0];
      expect(credit.idempotencyKey).toBe(
        `settlement-credit:${ORDER_ID}:${PAYEE_ID}`,
      );
      expect(credit.payeeId).toBe(PAYEE_ID);
      expect(credit.amountCents).toBe(SUBTOTAL);
      expect(credit.currency).toBe("usd");
      expect(credit.orderId).toBe(ORDER_ID);
      expect(credit.availableAt.toISOString()).toBe(
        "2026-09-01T00:00:00.000Z",
      );
      expect(credit.sourceKind).toBe("order_split");
      expect(credit.sourceId).toBe(ORDER_ID);
      // Item attribution rides the entry metadata: the single membership item
      // carries the whole credit.
      expect(credit.metadata).toEqual({
        items: { [`item-${ORDER_ID}-1`]: SUBTOTAL },
      });

      // Step B of the ledger cutover: revenue writes NO settlement rows.
      expect(ctx.settlements.create).not.toHaveBeenCalled();
      expect(ctx.settlements.incrementAmount).not.toHaveBeenCalled();
      expect(ctx.settlementLineRows).toHaveLength(0);
    });

    it("rolls a month-boundary invoice into the FOLLOWING month (Jan 31 → Feb 1)", async () => {
      const ctx = makeCtx();

      await ctx.run(
        invoiceInput({
          invoiceCreatedAt: new Date("2027-01-31T23:59:59.999Z"),
        }),
      );

      const credit = ctx.payeeLedger.settlementCredit.mock.calls[0]![0];
      expect(credit.availableAt.toISOString()).toBe(
        "2027-02-01T00:00:00.000Z",
      );
    });

    // ── Stripe availability floor ───────────────────────────────────────
    // Same guard as the ticketing writer (`createCreditsFromOrder`).
    // `run-batch` transfers WITHOUT `source_transaction`, so it spends the
    // platform's AVAILABLE balance; the monthly bucket alone can mature a
    // credit before the money can possibly be there.
    describe("availability floor", () => {
      /**
       * The shared mock types its recorded call loosely, so reach the field
       * through one cast here rather than repeating it per assertion (the
       * ticketing suite's `availableAtOf` does the same).
       */
      const availableAtOf = (ctx: {
        payeeLedger: { settlementCredit: { mock: { calls: unknown[][] } } };
      }): Date =>
        (ctx.payeeLedger.settlementCredit.mock.calls[0]![0] as {
          availableAt: Date;
        }).availableAt;

      it("is a NO-OP for a mid-month invoice", async () => {
        // Charged Mon 2026-08-10 → floor Wed 2026-08-12, three weeks behind
        // the 2026-09-01 bucket. The monthly rule wins untouched.
        const ctx = makeCtx({ now: new Date("2026-08-10T12:00:00.000Z") });
        await ctx.run(
          invoiceInput({ invoiceCreatedAt: new Date("2026-08-10T12:00:00.000Z") }),
        );

        expect(availableAtOf(ctx).toISOString()).toBe("2026-09-01T00:00:00.000Z");
      });

      it("moves a month-END invoice past the bucket (Mon 2026-08-31 → Wed 2026-09-02)", async () => {
        // Bucket says 2026-09-01T00:00Z. A card charged Monday 08-31 is not
        // available until Wednesday 09-02, so the bucket is a day early.
        const ctx = makeCtx({ now: new Date("2026-08-31T12:00:00.000Z") });
        await ctx.run(
          invoiceInput({ invoiceCreatedAt: new Date("2026-08-31T12:00:00.000Z") }),
        );

        // Midnight America/Chicago on Wed 2026-09-02 (CDT, UTC-5).
        expect(availableAtOf(ctx).toISOString()).toBe("2026-09-02T05:00:00.000Z");
      });

      it("moves a Friday month-end invoice to the Tuesday, crossing the UTC/CT boundary", async () => {
        // Fri 2026-08-28: day 0 is Friday, so +2 business days is Tue
        // 2026-09-01 — but at midnight CENTRAL (05:00Z), five hours after the
        // 2026-09-01T00:00Z UTC bucket. A small move, and a real one.
        const ctx = makeCtx({ now: new Date("2026-08-28T12:00:00.000Z") });
        await ctx.run(
          invoiceInput({ invoiceCreatedAt: new Date("2026-08-28T12:00:00.000Z") }),
        );

        expect(availableAtOf(ctx).toISOString()).toBe("2026-09-01T05:00:00.000Z");
      });

      it("a WEEKEND month-end invoice starts counting from the Monday", async () => {
        // Sat 2026-08-29 → Monday 08-31 is day 0 → Wed 2026-09-02.
        const ctx = makeCtx({ now: new Date("2026-08-29T12:00:00.000Z") });
        await ctx.run(
          invoiceInput({ invoiceCreatedAt: new Date("2026-08-29T12:00:00.000Z") }),
        );

        expect(availableAtOf(ctx).toISOString()).toBe("2026-09-02T05:00:00.000Z");
      });

      it("instantPayouts still bypasses the floor at month end", async () => {
        const monthEnd = new Date("2026-08-31T12:00:00.000Z");
        const ctx = makeCtx({ instantPayouts: true, now: monthEnd });
        await ctx.run(invoiceInput({ invoiceCreatedAt: monthEnd }));

        expect(availableAtOf(ctx)).toEqual(monthEnd);
      });

      it("keeps invoiceCreatedAt as the BUCKETING input, not the floor basis", async () => {
        // Invoice created mid-July (bucket 2026-08-01) but the charge only
        // settles Mon 2026-08-31: the bucket is long past, so the floor —
        // measured from the settle instant — takes over.
        const ctx = makeCtx({ now: new Date("2026-08-31T12:00:00.000Z") });
        await ctx.run(
          invoiceInput({ invoiceCreatedAt: new Date("2026-07-15T12:00:00.000Z") }),
        );

        expect(availableAtOf(ctx).toISOString()).toBe("2026-09-02T05:00:00.000Z");
      });
    });

    it("rolls a December invoice into January of the NEXT year", async () => {
      const ctx = makeCtx();

      await ctx.run(
        invoiceInput({
          invoiceCreatedAt: new Date("2026-12-15T05:00:00.000Z"),
        }),
      );

      const credit = ctx.payeeLedger.settlementCredit.mock.calls[0]![0];
      expect(credit.availableAt.toISOString()).toBe(
        "2027-01-01T00:00:00.000Z",
      );
    });

    it("a SECOND invoice in the same month writes its OWN credit, maturing at the SAME instant", async () => {
      // Monthly folding is now a payout-time behaviour: every invoice in a
      // calendar month matures at the same instant, so one batch cycle pays
      // the payee's whole month in one transfer (the spec's break-even table
      // and the $2 fee unit assume one payout event per month). There is no
      // shared row to merge into at write time.
      const ctx = makeCtx();

      const first = await ctx.run(invoiceInput());
      const second = await ctx.run(
        invoiceInput({ stripeInvoiceId: "in_2", stripeEventId: "evt_2b" }),
      );

      // Two real orders...
      expect(second.orderId).not.toBe(first.orderId);
      expect(ctx.orders.createPending).toHaveBeenCalledTimes(2);

      // ...two credits, one per order, same maturity, distinct keys.
      expect(ctx.payeeLedger.settlementCredit).toHaveBeenCalledTimes(2);
      const [a, b] = ctx.payeeLedger.settlementCredit.mock.calls.map(
        (call) => call[0],
      );
      expect(a.availableAt).toEqual(b.availableAt);
      expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
      expect(new Set([a.orderId, b.orderId]).size).toBe(2);

      // And still no settlement rows anywhere.
      expect(ctx.settlements.create).not.toHaveBeenCalled();
      expect(ctx.settlements.incrementAmount).not.toHaveBeenCalled();
    });

    it("a replayed invoice writes no second credit", async () => {
      // The credit write sits AFTER the in-transaction invoice-id replay
      // return, so it inherits the order's idempotency: a redelivery never
      // reaches it. (The repo's unique key is the further backstop.)
      const ctx = makeCtx();

      await ctx.run(invoiceInput());
      await ctx.run(invoiceInput({ stripeEventId: "evt_replay" }));

      expect(ctx.payeeLedger.settlementCredit).toHaveBeenCalledTimes(1);
      expect(ctx.ledgerEntriesByKey.size).toBe(1);
    });

    it("a different-currency invoice writes its own credit in ITS currency", async () => {
      // The old settlement fold refused cross-currency merges
      // (CURRENCY_MISMATCH → DLQ). Credits are per order, per payee, each
      // carrying its own currency — the hazard is structurally gone.
      const ctx = makeCtx();

      await ctx.run(invoiceInput());
      await ctx.run(
        invoiceInput({
          stripeInvoiceId: "in_cad",
          stripeEventId: "evt_cad",
          currency: "cad",
        }),
      );

      expect(ctx.payeeLedger.settlementCredit).toHaveBeenCalledTimes(2);
      const currencies = ctx.payeeLedger.settlementCredit.mock.calls.map(
        (call) => call[0].currency,
      );
      expect(currencies.sort()).toEqual(["cad", "usd"]);
    });

    it("matures at NOW when instantPayouts is set (dev/test seam)", async () => {
      const ctx = makeCtx({ instantPayouts: true });

      await ctx.run(invoiceInput());

      const credit = ctx.payeeLedger.settlementCredit.mock.calls[0]![0];
      expect(credit.availableAt).toEqual(NOW);
    });

    it("records ledgerEntryIds and the maturity date on the audit row", async () => {
      const ctx = makeCtx();

      await ctx.run(invoiceInput());

      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "membership_invoice_paid",
          data: expect.objectContaining({
            ledgerEntryIds: ["ledger-entry-1"],
            availableAt: "2026-09-01T00:00:00.000Z",
          }),
        }),
      );
    });
  });
});

describe("recordMembershipPaymentFailed", () => {
  it("marks the membership past due in Stripe's own vocabulary", async () => {
    const ctx = makeCtx();

    const result = await recordMembershipPaymentFailed(ctx.deps, {
      stripeInvoiceId: "in_1",
      stripeSubscriptionId: "sub_1",
      amountDueCents: AMOUNT_PAID,
      currency: "usd",
      attemptCount: 1,
      nextPaymentAttemptAt: PERIOD_END,
      stripeEventId: "evt_failed_1",
    });

    // Lower-snake, because Membership.status mirrors Stripe verbatim and
    // startMembership's live-membership guard compares against these values.
    expect(ctx.memberships.updateFromStripe).toHaveBeenCalledWith({
      id: MEMBERSHIP_ID,
      status: "past_due",
    });
    expect(result).toMatchObject({ ok: true, membershipId: MEMBERSHIP_ID });
  });

  it("creates no Order — a failed invoice collected nothing", async () => {
    const ctx = makeCtx();

    await recordMembershipPaymentFailed(ctx.deps, failureInput());

    expect(ctx.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.splits.upsertForOrder).not.toHaveBeenCalled();
  });

  it("is idempotent across a redelivery of the same event", async () => {
    const ctx = makeCtx();

    await recordMembershipPaymentFailed(ctx.deps, failureInput());
    await recordMembershipPaymentFailed(ctx.deps, failureInput());

    expect(ctx.memberships.updateFromStripe).toHaveBeenCalledTimes(1);
    expect(ctx.audit.log).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown subscription", async () => {
    const ctx = makeCtx({ membership: null });

    await expect(
      recordMembershipPaymentFailed(ctx.deps, failureInput()),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_FOUND" });
  });
});

describe("syncMembershipFromStripe", () => {
  it("mirrors an updated subscription onto the membership row", async () => {
    const ctx = makeCtx();

    const result = await syncMembershipFromStripe(ctx.deps, {
      stripeSubscriptionId: "sub_1",
      status: "past_due",
      currentPeriodStart: NOW,
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: true,
      canceledAt: null,
      stripeEventId: "evt_sub_1",
    });

    expect(result).toMatchObject({
      ok: true,
      membershipId: MEMBERSHIP_ID,
      applied: true,
      skippedReason: null,
    });
    expect(ctx.memberships.updateFromStripe).toHaveBeenCalledWith({
      id: MEMBERSHIP_ID,
      status: "past_due",
      currentPeriodStart: NOW,
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: true,
      canceledAt: null,
    });
  });

  it("mirrors a deleted subscription, including canceledAt", async () => {
    const ctx = makeCtx();

    await syncMembershipFromStripe(ctx.deps, {
      stripeSubscriptionId: "sub_1",
      status: "canceled",
      currentPeriodStart: NOW,
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      canceledAt: PERIOD_END,
      stripeEventId: "evt_sub_deleted",
    });

    expect(ctx.memberships.updateFromStripe).toHaveBeenCalledWith(
      expect.objectContaining({ status: "canceled", canceledAt: PERIOD_END }),
    );
  });

  it("is a silent no-op for a subscription we do not track", async () => {
    // The platform account carries subscriptions we did not create. Not an
    // error, not reported — see the use case header.
    const ctx = makeCtx({ membership: null });

    const result = await syncMembershipFromStripe(ctx.deps, {
      stripeSubscriptionId: "sub_someone_elses",
      status: "active",
      stripeEventId: "evt_foreign",
    });

    expect(result).toMatchObject({
      ok: true,
      membershipId: null,
      applied: false,
      skippedReason: "untracked_subscription",
    });
    expect(ctx.memberships.updateFromStripe).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
    // Logged at info, because nothing failed.
    expect(ctx.deps.logger.info).toHaveBeenCalledWith(
      "membership.sync_skipped_untracked_subscription",
      expect.objectContaining({ stripeSubscriptionId: "sub_someone_elses" }),
    );
  });

  it("throws when the repo write fails, so the DLQ can catch it", async () => {
    const ctx = makeCtx();
    ctx.memberships.updateFromStripe.mockRejectedValueOnce(
      new Error("db down"),
    );

    await expect(
      syncMembershipFromStripe(ctx.deps, {
        stripeSubscriptionId: "sub_1",
        status: "active",
        stripeEventId: "evt_sub_2",
      }),
    ).rejects.toThrow("db down");
  });

  it("ignores an out-of-order event describing an older billing period", async () => {
    const ctx = makeCtx();

    const result = await syncMembershipFromStripe(ctx.deps, {
      stripeSubscriptionId: "sub_1",
      status: "active",
      currentPeriodStart: new Date("2026-07-10T12:00:00.000Z"),
      currentPeriodEnd: NOW,
      stripeEventId: "evt_stale",
    });

    expect(result).toMatchObject({ applied: false, skippedReason: "stale_event" });
    expect(ctx.memberships.updateFromStripe).not.toHaveBeenCalled();
  });
});

// ── Harness ────────────────────────────────────────────────────────────────

function invoiceInput(overrides: Record<string, unknown> = {}) {
  return {
    stripeInvoiceId: "in_1",
    stripeSubscriptionId: "sub_1",
    stripeCustomerId: "cus_1",
    stripePaymentIntentId: "pi_1",
    amountPaidCents: AMOUNT_PAID,
    subtotalCents: SUBTOTAL,
    taxAmountCents: TAX,
    currency: "usd",
    invoiceCreatedAt: NOW,
    periodStart: NOW,
    periodEnd: PERIOD_END,
    stripeEventId: "evt_1",
    ...overrides,
  };
}

function failureInput(overrides: Record<string, unknown> = {}) {
  return {
    stripeInvoiceId: "in_1",
    stripeSubscriptionId: "sub_1",
    amountDueCents: AMOUNT_PAID,
    currency: "usd",
    attemptCount: 1,
    nextPaymentAttemptAt: null,
    stripeEventId: "evt_failed_1",
    ...overrides,
  };
}

function buildTier(
  overrides: Partial<MembershipTierRecord> = {},
): MembershipTierRecord {
  return {
    id: TIER_ID,
    ownerOrgId: ORG_ID,
    ownerHumanId: null,
    name: "Sustaining Member",
    description: null,
    priceCents: SUBTOTAL,
    currency: "usd",
    interval: "MONTH",
    stripeProductId: "prod_1",
    stripePriceId: "price_1",
    status: "ACTIVE",
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildMembership(
  overrides: Partial<MembershipRecord> = {},
): MembershipRecord {
  return {
    id: MEMBERSHIP_ID,
    tierId: TIER_ID,
    memberHumanId: MEMBER_ID,
    stripeSubscriptionId: "sub_1",
    stripeCustomerId: "cus_1",
    status: "active",
    taxJurisdictionId: "jur_1",
    billingPostalCode: "37206",
    billingCountryCode: "US",
    currentPeriodStart: NOW,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * In-memory IdempotencyPort with the real begin/commit/fail semantics — the
 * replay assertions are worthless against a stub that always claims the key.
 */
function makeIdempotency() {
  const claimed = new Set<string>();
  const committed = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => committed.get(key) ?? null),
    begin: vi.fn(async (key: string) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
    commit: vi.fn(async (key: string, result: unknown) => {
      committed.set(key, result);
    }),
    fail: vi.fn(async (key: string) => {
      claimed.delete(key);
    }),
    // Owner-checked release (lib/idempotency-claim.ts): frees the key.
    release: vi.fn(async (key: string, _ownerToken: string) => {
      claimed.delete(key);
      return true;
    }),
    run: vi.fn(),
    purgeExpired: vi.fn(async () => 0),
  };
}

function makeCtx(
  options: {
    tier?: MembershipTierRecord;
    membership?: MembershipRecord | null;
    payee?: { id: string } | null;
    instantPayouts?: boolean;
    /**
     * `clock.now()` — the instant the invoice charge settled, and the basis
     * for the Stripe availability floor on credit maturity.
     */
    now?: Date;
  } = {},
) {
  const now = options.now ?? NOW;
  const membership =
    options.membership === undefined ? buildMembership() : options.membership;
  const payee = options.payee === undefined ? { id: PAYEE_ID } : options.payee;

  /** Orders actually written, keyed by invoice id — backs the replay read. */
  const byInvoice = new Map<string, { id: string; input: CreatePendingOrderInput }>();

  // The first order minted is ORDER_ID (many assertions name it); a second
  // DISTINCT invoice in one test gets a distinct-but-valid uuid, because the
  // settlement aggregation tests need two real orders in one month.
  let orderSeq = 0;
  const mintOrderId = () => {
    const id =
      orderSeq === 0 ? ORDER_ID : ORDER_ID.slice(0, -2) + String(10 + orderSeq);
    orderSeq += 1;
    return id;
  };

  /**
   * Items persisted per order, with minted ids — the ledger-credit item
   * attribution re-reads them via `orderItems.listByOrderId` (createPending's
   * return does not carry item ids).
   */
  const itemRowsByOrder = new Map<
    string,
    Array<{ id: string; kind: string; amountCents: number }>
  >();

  const orders = {
    findByStripeInvoiceId: vi.fn(async (invoiceId: string) => {
      const row = byInvoice.get(invoiceId);
      if (!row) return null;
      return { id: row.id, items: [] } as never;
    }),
    createPending: vi.fn(async (input: CreatePendingOrderInput) => {
      const id = mintOrderId();
      if (input.stripeInvoiceId) {
        byInvoice.set(input.stripeInvoiceId, { id, input });
      }
      itemRowsByOrder.set(
        id,
        (input.items ?? []).map((item, index) => ({
          id: `item-${id}-${index + 1}`,
          kind: item.kind,
          amountCents: item.amountCents,
        })),
      );
      return {
        id,
        amountGrossCents: input.amountGrossCents,
        feesPlatformCents: input.feesPlatformCents,
        currency: input.currency,
      };
    }),
    markSucceeded: vi.fn(async () => {}),
  };

  const orderItems = {
    listByOrderId: vi.fn(
      async (orderId: string) => itemRowsByOrder.get(orderId) ?? [],
    ),
  };

  const memberships = {
    findByStripeSubscriptionId: vi.fn(async () => membership),
    updateFromStripe: vi.fn(async (input: { id: string; status?: string }) =>
      buildMembership({ status: input.status ?? "active" }),
    ),
  };

  const membershipTiers = {
    findById: vi.fn(async () => options.tier ?? buildTier()),
  };

  const payees = { getBySubject: vi.fn(async () => payee) };

  // Splits behave like the real repo: `upsertForOrder` persists rows and
  // `getForOrder` returns them WITH `orderSplitId`s — the settlement path
  // re-reads through it to get the ids for its lines.
  let splitSeq = 0;
  const splitRowsByOrder = new Map<
    string,
    Array<{
      id: string;
      orderId: string;
      orderSplitId: string;
      payeeId: string;
      amountCents: number;
    }>
  >();
  const splits = {
    upsertForOrder: vi.fn(
      async (
        orderId: string,
        rows: Array<{ payeeId: string; amountCents: number }>,
      ) => {
        splitRowsByOrder.set(
          orderId,
          rows.map((row) => {
            splitSeq += 1;
            return {
              id: `split-${splitSeq}`,
              orderId,
              orderSplitId: `order-split-${splitSeq}`,
              payeeId: row.payeeId,
              amountCents: row.amountCents,
            };
          }),
        );
      },
    ),
    getForOrder: vi.fn(
      async (orderId: string) => splitRowsByOrder.get(orderId) ?? [],
    ),
  };

  // Settlements honour the real `(payeeId, scheduledPayoutDate)` uniqueness —
  // the monthly-aggregation assertions are worthless against a fake that
  // always creates a fresh row.
  let settlementSeq = 0;
  const settlementRows = new Map<
    string,
    {
      id: string;
      payeeId: string;
      date: Date;
      scheduledPayoutDate: Date;
      amountCents: number;
      currency: string;
      status: string;
      eventId: string | null;
      payoutTermsId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }
  >();
  const settlements = {
    getByPayeeAndScheduledDate: vi.fn(
      async (payeeId: string, scheduledPayoutDate: Date) =>
        [...settlementRows.values()].find(
          (s) =>
            s.payeeId === payeeId &&
            s.scheduledPayoutDate.getTime() === scheduledPayoutDate.getTime(),
        ) ?? null,
    ),
    create: vi.fn(
      async (row: {
        payeeId: string;
        date: Date;
        scheduledPayoutDate: Date;
        amountCents: number;
        currency: string;
        eventId?: string | null;
        payoutTermsId?: string | null;
        agreementId?: string | null;
      }) => {
        settlementSeq += 1;
        const record = {
          id: `settlement-${settlementSeq}`,
          payeeId: row.payeeId,
          date: row.date,
          scheduledPayoutDate: row.scheduledPayoutDate,
          amountCents: row.amountCents,
          currency: row.currency,
          status: "pending",
          eventId: row.eventId ?? null,
          payoutTermsId: row.agreementId ?? row.payoutTermsId ?? null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        settlementRows.set(record.id, record);
        return record;
      },
    ),
    updateAmount: vi.fn(async (settlementId: string, amountCents: number) => {
      const row = settlementRows.get(settlementId);
      if (row) row.amountCents = amountCents;
    }),
    // Mirrors the adapter's atomic `{ amountCents: { increment } }`.
    incrementAmount: vi.fn(async (settlementId: string, deltaCents: number) => {
      const row = settlementRows.get(settlementId);
      if (row) row.amountCents += deltaCents;
    }),
    getById: vi.fn(
      async (settlementId: string) => settlementRows.get(settlementId) ?? null,
    ),
  };

  // Mirrors the adapter's `createMany({ skipDuplicates: true })`.
  const settlementLineRows: Array<{
    settlementId: string;
    orderId: string;
    orderSplitId: string;
    payeeId: string;
    amountCents: number;
    currency: string;
  }> = [];
  const settlementLines = {
    addDraft: vi.fn(async (rows: typeof settlementLineRows) => {
      for (const row of rows) {
        const duplicate = settlementLineRows.some(
          (r) =>
            r.settlementId === row.settlementId &&
            r.orderSplitId === row.orderSplitId,
        );
        if (!duplicate) settlementLineRows.push(row);
      }
    }),
  };

  const audit = { log: vi.fn(async () => {}) };

  // Payee ledger honouring the real idempotency contract: unique on
  // `idempotencyKey`, a replay returns the existing row without re-applying
  // effects, and `amountCents <= 0` throws (the adapter rejects it by design).
  let ledgerEntrySeq = 0;
  const ledgerEntriesByKey = new Map<string, Record<string, unknown>>();
  const payeeLedger = {
    settlementCredit: vi.fn(async (input: { idempotencyKey: string; amountCents: number }) => {
      if (input.amountCents <= 0) {
        throw new Error("settlementCredit requires amountCents > 0");
      }
      const existing = ledgerEntriesByKey.get(input.idempotencyKey);
      if (existing) return existing;
      ledgerEntrySeq += 1;
      const record = {
        id: `ledger-entry-${ledgerEntrySeq}`,
        type: "SETTLEMENT_CREDIT",
        ...input,
        createdAt: NOW,
      };
      ledgerEntriesByKey.set(input.idempotencyKey, record);
      return record;
    }),
  };

  const repos = {
    orders,
    orderItems,
    memberships,
    membershipTiers,
    payees,
    splits,
    settlements,
    settlementLines,
    payeeLedger,
    audit,
  };

  const deps = {
    repos: {
      ...repos,
      tx: async (fn: (tx: unknown) => Promise<unknown>) => fn(repos),
    } as unknown as Repos,
    idempotency: makeIdempotency() as never,
    clock: { now: () => now },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    ...(options.instantPayouts ? { instantPayouts: true } : {}),
  };

  return {
    orders,
    orderItems,
    memberships,
    membershipTiers,
    payees,
    splits,
    settlements,
    settlementLines,
    settlementLineRows,
    settlementRows,
    payeeLedger,
    ledgerEntriesByKey,
    audit,
    deps: deps as never as Parameters<typeof recordMembershipInvoicePaid>[0] & {
      logger: { info: ReturnType<typeof vi.fn> };
    },
    run: (input: unknown) =>
      recordMembershipInvoicePaid(deps as never, input),
    createdOrder: () => orders.createPending.mock.calls[0]![0],
  };
}
