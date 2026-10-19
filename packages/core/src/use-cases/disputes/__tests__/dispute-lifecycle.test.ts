import { formatOrderCode } from "@th/types/order-identifier";
import { describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import type { DisputeRecord } from "@th/ports/repos/disputes";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { PayeeLedgerEntryRecord } from "@th/ports/repos/payee-ledger";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { SplitEntry } from "@th/ports/repos/splits";
import type { HumanWithIdentity } from "@th/types/repos/humans";
import type { OrgMemberRecord } from "@th/types/repos/organizations";

import { closeDispute } from "../close-dispute";
import { openDispute } from "../open-dispute";
import { recordFundsWithdrawn } from "../record-funds-withdrawn";
import { refreshDispute } from "../refresh-dispute";

const NOW = new Date("2026-05-15T12:00:00.000Z");
const FUNDS_WITHDRAWN_AT = new Date("2026-05-15T12:05:00.000Z");
const EVIDENCE_DUE_BY = new Date("2026-05-20T12:00:00.000Z");

describe("dispute lifecycle use cases", () => {
  it("opens and links a dispute by payment intent", async () => {
    const ctx = makeDeps();

    const result = await openDispute(ctx.deps, baseDisputeInput());

    expect(result).toEqual({
      ok: true,
      disputeId: "dispute_1",
      stripeDisputeId: "dp_123",
      orderId: ctx.order.id,
      status: "OPEN",
      triageReason: null,
    });
    expect(ctx.store.get("dp_123")).toMatchObject({
      stripeDisputeId: "dp_123",
      orderId: ctx.order.id,
      ownerSubjectType: "ORGANIZATION",
      ownerSubjectId: ctx.event.orgId,
      ownerOrgId: ctx.event.orgId,
      status: "OPEN",
      linkedAt: NOW,
      evidenceDueBy: EVIDENCE_DUE_BY,
    });
    expect(ctx.mocks.orders.markDisputeStatus).toHaveBeenCalledWith({
      orderId: ctx.order.id,
      disputeStatus: "OPEN",
      disputedAt: NOW,
    });
  });

  it("notifies linked org risk owners and ops when a formal dispute opens", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_open_notify" }),
    );

    expect(ctx.mocks.notifications.create).toHaveBeenCalledTimes(3);
    expect(
      ctx.mocks.notifications.create.mock.calls.map(([input]) => input.humanId),
    ).toEqual(["owner-human", "admin-human", "finance-human"]);
    expect(ctx.mocks.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Dispute opened",
        kind: "WARNING",
        tags: ["dispute", "payments", "status-open"],
        metadata: expect.objectContaining({
          disputeId: "dispute_1",
          stripeDisputeId: "dp_123",
          stripeEventId: "evt_open_notify",
          orderId: ctx.order.id,
          eventId: ctx.event.id,
        }),
      }),
    );
    expect(ctx.mocks.mailer.send).toHaveBeenCalledTimes(3);
    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "owner@example.com", name: "Owner One" },
        subject: expect.stringContaining("payout held"),
        text: expect.stringContaining("holding the affected payout share"),
        idempotencyKey: "dispute-lifecycle:evt_open_notify:owner-human",
      }),
    );
    expect(ctx.mocks.discordAlert).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.discordAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Dispute opened",
        colour: "warning",
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "Dispute", value: "dp_123" }),
          expect.objectContaining({ name: "Order", value: ctx.order.id }),
          expect.objectContaining({ name: "Status", value: "OPEN" }),
        ]),
      }),
    );
  });

  it("creates full dispute holds for each order split when the dispute covers the full split total", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_open_holds" }),
    );

    const holds = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_HOLD",
    );
    expect(ctx.mocks.splits.getForOrder).toHaveBeenCalledWith(ctx.order.id);
    expect(holds).toHaveLength(2);
    expect(holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: `dispute-hold:dispute_1:payee_artist:usd`,
          payeeId: "payee_artist",
          amountCents: 3_000,
          currency: "usd",
          disputeId: "dispute_1",
          orderId: ctx.order.id,
          description: `Dispute hold for order ${ctx.order.id.slice(-8).toUpperCase()}`,
          metadata: expect.objectContaining({
            originalSplitAmountCents: 3_000,
            heldAmountCents: 3_000,
            holdCapAmountCents: 5_000,
            totalPositiveSplitAmountCents: 5_000,
            prorated: false,
          }),
        }),
        expect.objectContaining({
          idempotencyKey: `dispute-hold:dispute_1:payee_venue:usd`,
          payeeId: "payee_venue",
          amountCents: 2_000,
          currency: "usd",
          disputeId: "dispute_1",
          orderId: ctx.order.id,
          metadata: expect.objectContaining({
            originalSplitAmountCents: 2_000,
            heldAmountCents: 2_000,
            holdCapAmountCents: 5_000,
            totalPositiveSplitAmountCents: 5_000,
            prorated: false,
          }),
        }),
      ]),
    );
  });

  it("caps partial dispute holds to the disputed amount and prorates by split share", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({
        stripeEventId: "evt_open_partial_holds",
        amountCents: 3_333,
      }),
    );

    const holds = ledgerEntries(ctx)
      .filter((entry) => entry.type === "DISPUTE_HOLD")
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));

    expect(holds).toHaveLength(2);
    expect(holds.reduce((sum, hold) => sum + hold.amountCents, 0)).toBe(3_333);
    expect(
      holds.map((hold) => ({
        payeeId: hold.payeeId,
        amountCents: hold.amountCents,
      })),
    ).toEqual([
      { payeeId: "payee_artist", amountCents: 2_000 },
      { payeeId: "payee_venue", amountCents: 1_333 },
    ]);
    expect(holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: `dispute-hold:dispute_1:payee_artist:usd`,
          metadata: expect.objectContaining({
            originalSplitAmountCents: 3_000,
            heldAmountCents: 2_000,
            disputedAmountCents: 3_333,
            holdCapAmountCents: 3_333,
            totalPositiveSplitAmountCents: 5_000,
            prorated: true,
          }),
        }),
        expect.objectContaining({
          idempotencyKey: `dispute-hold:dispute_1:payee_venue:usd`,
          metadata: expect.objectContaining({
            originalSplitAmountCents: 2_000,
            heldAmountCents: 1_333,
            disputedAmountCents: 3_333,
            holdCapAmountCents: 3_333,
            totalPositiveSplitAmountCents: 5_000,
            prorated: true,
          }),
        }),
      ]),
    );
  });

  it("does not double-hold on duplicate or repeated lifecycle events", async () => {
    const ctx = makeDeps();
    const input = baseDisputeInput({ stripeEventId: "evt_hold_replay_1" });

    await openDispute(ctx.deps, input);
    await openDispute(ctx.deps, input);
    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_hold_replay_2" }),
    );

    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_HOLD"),
    ).toHaveLength(2);
    expect(ctx.mocks.payeeLedger.hold).toHaveBeenCalledTimes(4);
  });

  it("persists orphan disputes as NEEDS_TRIAGE", async () => {
    const ctx = makeDeps({ order: null });

    const result = await openDispute(ctx.deps, baseDisputeInput());

    expect(result).toMatchObject({
      orderId: null,
      status: "NEEDS_TRIAGE",
      triageReason: "order_not_found",
    });
    expect(ctx.store.get("dp_123")).toMatchObject({
      orderId: null,
      ownerSubjectType: null,
      ownerSubjectId: null,
      ownerOrgId: null,
      status: "NEEDS_TRIAGE",
      triageReason: "order_not_found",
    });
    expect(ctx.mocks.orders.markDisputeStatus).not.toHaveBeenCalled();
    expect(ctx.mocks.notifications.create).not.toHaveBeenCalled();
    expect(ctx.mocks.mailer.send).not.toHaveBeenCalled();
    expect(ctx.mocks.discordAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Dispute needs triage",
        colour: "error",
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "Triage reason", value: "order_not_found" }),
        ]),
      }),
    );
    expect(ledgerEntries(ctx)).toHaveLength(0);
  });

  // ── Dispute fee capture ─────────────────────────────────────────────────
  // Stripe reports the per-dispute fee late: it is absent at
  // charge.dispute.created and materialises around funds_withdrawn. Until this
  // was captured, dispute COST was unmeasurable on ticketing too, where a
  // single $15 fee erases roughly 30 tickets of platform revenue.

  it("leaves the fee at zero while Stripe has not reported one", async () => {
    const ctx = makeDeps();

    await openDispute(ctx.deps, baseDisputeInput());

    expect(ctx.store.get("dp_123")).toMatchObject({
      feeCents: 0,
      // Null, not PLATFORM: nobody has been charged anything yet, and that is
      // a different fact from "the platform absorbed it".
      feeBorneBy: null,
    });
  });

  it("captures the fee when it materialises at funds_withdrawn", async () => {
    const ctx = makeDeps();

    await openDispute(ctx.deps, baseDisputeInput());
    await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_funds", feeCents: 1_500 }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });

    expect(ctx.store.get("dp_123")).toMatchObject({
      feeCents: 1_500,
      feeBorneBy: "PLATFORM",
    });
  });

  it("does not wipe a captured fee on a later event that omits it", async () => {
    const ctx = makeDeps();

    await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_funds", feeCents: 1_500 }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });
    // A subsequent lifecycle event carries no balance transactions at all.
    await refreshDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_refresh", feeCents: null }),
    );

    expect(ctx.store.get("dp_123")).toMatchObject({
      feeCents: 1_500,
      feeBorneBy: "PLATFORM",
    });
  });

  it("debits the fee to the payee when the disputed order is a membership", async () => {
    const event = buildEvent();
    const ctx = makeDeps({ order: buildOrder(event.id, "MEMBERSHIP"), event });

    await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_funds", feeCents: 1_500 }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });

    // The owner sold the recurring subscription, so the chargeback risk is
    // theirs — unlike ticketing, where clawing a buyer's fee off a venue would
    // punish them for something they had no part in.
    expect(ctx.store.get("dp_123")).toMatchObject({
      feeCents: 1_500,
      feeBorneBy: "PAYEE",
    });
  });

  it("records funds withdrawn without moving money", async () => {
    const ctx = makeDeps();

    await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_funds" }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });

    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "OPEN",
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });
    expect(ctx.mocks.orders.markDisputeStatus).toHaveBeenCalledWith({
      orderId: ctx.order.id,
      disputeStatus: "OPEN",
      disputedAt: NOW,
    });
  });

  it("marks linked disputes for manual review when settlement transfer is already in flight", async () => {
    const ctx = makeDeps({
      transferringSettlementIds: new Set(["settlement-in-flight"]),
    });

    const result = await openDispute(ctx.deps, baseDisputeInput());

    expect(result).toMatchObject({
      orderId: ctx.order.id,
      status: "OPEN",
      triageReason: "settlement_transfer_in_flight",
    });
    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "OPEN",
      triageReason: "settlement_transfer_in_flight",
      metadata: expect.objectContaining({
        settlementTransferBoundary: expect.objectContaining({
          condition: "settlement_transfer_in_flight",
          settlementIds: ["settlement-in-flight"],
          phase: "post_transfer_dispute_debit",
          requiresManualReview: true,
        }),
      }),
    });
    expect(ctx.mocks.orders.markDisputeStatus).toHaveBeenCalledWith({
      orderId: ctx.order.id,
      disputeStatus: "OPEN",
      disputedAt: NOW,
    });
    expect(
      ctx.mocks.settlementLines.settlementIdsForOrderWithSettlementStatuses,
    ).toHaveBeenCalledWith(ctx.order.id, ["transferring"]);
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          triageReason: "settlement_transfer_in_flight",
          settlementTransferBoundary: expect.objectContaining({
            condition: "settlement_transfer_in_flight",
            settlementIds: ["settlement-in-flight"],
            phase: "post_transfer_dispute_debit",
          }),
        }),
      }),
    );
    expect(ctx.mocks.logger.warn).toHaveBeenCalledWith(
      "dispute.lifecycle.settlement_transfer_in_flight",
      expect.objectContaining({
        orderId: ctx.order.id,
        settlementIds: ["settlement-in-flight"],
        phase: "post_transfer_dispute_debit",
      }),
    );
  });

  it("records warning updates without marking the order as formally disputed", async () => {
    const ctx = makeDeps();

    const result = await refreshDispute(ctx.deps, {
      ...baseDisputeInput({
        stripeEventId: "evt_warning_updated",
        isWarning: true,
      }),
      stripeStatus: "under_review",
    });

    expect(result).toMatchObject({
      status: "WARNING_UNDER_REVIEW",
      orderId: ctx.order.id,
    });
    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "WARNING_UNDER_REVIEW",
      linkedAt: NOW,
    });
    expect(ctx.mocks.orders.markDisputeStatus).not.toHaveBeenCalled();
    expect(ctx.mocks.notifications.create).not.toHaveBeenCalled();
    expect(ctx.mocks.mailer.send).not.toHaveBeenCalled();
    expect(ctx.mocks.discordAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Dispute warning received",
        description: expect.stringContaining("no risk-owner payout-hold notice"),
      }),
    );
    expect(ledgerEntries(ctx)).toHaveLength(0);
  });

  it("records warning closures without marking the order as formally disputed", async () => {
    const ctx = makeDeps();

    const result = await closeDispute(ctx.deps, {
      ...baseDisputeInput({
        stripeEventId: "evt_warning_closed",
        isWarning: true,
      }),
      stripeStatus: "warning_closed",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    expect(result).toMatchObject({
      status: "WARNING_CLOSED",
      orderId: ctx.order.id,
    });
    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "WARNING_CLOSED",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
    expect(ctx.mocks.orders.markDisputeStatus).not.toHaveBeenCalled();
    expect(ledgerEntries(ctx)).toHaveLength(0);
  });

  it("releases active holds when a linked formal dispute is won", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_open_before_won" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_closed_won_release" }),
      stripeStatus: "won",
      outcome: "won",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    expect(ctx.mocks.payeeLedger.releaseHoldsForDispute).toHaveBeenCalledWith(
      "dispute_1",
    );
    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(2);
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
    ).resolves.toHaveLength(0);
  });

  it("consumes active holds into per-payee debits when a linked formal dispute is lost", async () => {
    // Formerly "preserves active holds when lost": a ticketing LOST used to
    // leave both holds standing forever, waiting for a manual clawback that
    // had no surface. Now the LOST close realises the loss exactly like a
    // membership does — the hold rows stay (they are history) but every one
    // is consumed by a DISPUTE_DEBIT, so none is active and nothing is left
    // for anyone to "follow up" on.
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_open_before_lost" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_closed_lost_consume" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const holds = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_HOLD",
    );
    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(holds).toHaveLength(2);
    expect(debits).toHaveLength(2);
    // Each debit links the hold it consumed (same payee), and the two agree
    // on amount and currency.
    for (const debit of debits) {
      const consumed = holds.find((hold) => hold.id === debit.relatedEntryId);
      expect(consumed).toMatchObject({
        payeeId: debit.payeeId,
        amountCents: debit.amountCents,
        currency: debit.currency,
      });
    }
    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(0);
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
    ).resolves.toHaveLength(0);
  });

  it.each([
    ["won", "WON"],
    ["lost", "LOST"],
  ] as const)(
    "closes a %s dispute and mirrors the order status",
    async (stripeStatus, expectedStatus) => {
      const ctx = makeDeps();

      await openDispute(ctx.deps, baseDisputeInput());
      ctx.mocks.orders.markDisputeStatus.mockClear();

      const result = await closeDispute(ctx.deps, {
        ...baseDisputeInput({ stripeEventId: `evt_closed_${stripeStatus}` }),
        stripeStatus,
        outcome: stripeStatus,
        closedAt: FUNDS_WITHDRAWN_AT,
      });

      expect(result).toMatchObject({
        status: expectedStatus,
        orderId: ctx.order.id,
      });
      expect(ctx.store.get("dp_123")).toMatchObject({
        status: expectedStatus,
        closedAt: FUNDS_WITHDRAWN_AT,
        outcome: stripeStatus,
      });
      expect(ctx.mocks.orders.markDisputeStatus).toHaveBeenCalledWith({
        orderId: ctx.order.id,
        disputeStatus: expectedStatus,
        disputedAt: NOW,
      });
    },
  );

  it("replays duplicate Stripe events without a second upsert", async () => {
    const ctx = makeDeps();
    const input = baseDisputeInput({ stripeEventId: "evt_replayed" });

    const first = await openDispute(ctx.deps, input);
    const second = await openDispute(ctx.deps, input);

    expect(second).toEqual(first);
    expect(ctx.store.size).toBe(1);
    expect(ctx.mocks.disputes.upsertFromStripe).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.notifications.create).toHaveBeenCalledTimes(3);
    expect(ctx.mocks.mailer.send).toHaveBeenCalledTimes(3);
    expect(ctx.mocks.discordAlert).toHaveBeenCalledTimes(1);
  });

  it("swallows mailer failures and logs the notification failure", async () => {
    const ctx = makeDeps({ mailerRejects: true });

    await expect(
      openDispute(
        ctx.deps,
        baseDisputeInput({ stripeEventId: "evt_mailer_failure" }),
      ),
    ).resolves.toMatchObject({ ok: true, status: "OPEN" });

    expect(ctx.mocks.notifications.create).toHaveBeenCalledTimes(3);
    expect(ctx.mocks.discordAlert).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.logger.warn).toHaveBeenCalledWith(
      "dispute.lifecycle.email_failed",
      expect.objectContaining({
        disputeId: "dispute_1",
        error: "smtp unavailable",
      }),
    );
  });

  it("upserts repeated lifecycle events by Stripe dispute id", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_open_1" }),
    );
    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_open_2", amountCents: 7_500 }),
    );

    expect(ctx.store.size).toBe(1);
    expect(ctx.store.get("dp_123")).toMatchObject({ amountCents: 7_500 });
    expect(ctx.mocks.disputes.upsertFromStripe).toHaveBeenCalledTimes(2);
  });

  it("keeps terminal status when a delayed created event arrives after close", async () => {
    const ctx = makeDeps();

    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_closed_won" }),
      stripeStatus: "won",
      outcome: "won",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const result = await openDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_created_after_close" }),
      stripeStatus: "needs_response",
    });

    expect(result).toMatchObject({ status: "WON" });
    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "WON",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
  });

  it("keeps terminal status when a delayed updated event arrives after close", async () => {
    const ctx = makeDeps();

    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_closed_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const result = await refreshDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_updated_after_close" }),
      stripeStatus: "under_review",
    });

    expect(result).toMatchObject({ status: "LOST" });
    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "LOST",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
  });

  it("keeps terminal status while stamping funds withdrawn after close", async () => {
    const ctx = makeDeps();

    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_warning_closed" }),
      stripeStatus: "warning_closed",
      isWarning: true,
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const result = await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_funds_after_close" }),
      fundsWithdrawnAt: new Date("2026-05-15T12:10:00.000Z"),
    });

    expect(result).toMatchObject({ status: "WARNING_CLOSED" });
    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "WARNING_CLOSED",
      fundsWithdrawnAt: new Date("2026-05-15T12:10:00.000Z"),
      closedAt: FUNDS_WITHDRAWN_AT,
    });
  });

  // ── Membership dispute ledger flow ──────────────────────────────────────
  // Spec (recurring-memberships, "Dispute policy"): absorb on ticketing,
  // debit to the payee on memberships. A membership order has no event, so
  // its owner comes from the order's splits; while the dispute is open the
  // ordinary hold applies, and a LOST close converts the hold into a
  // DISPUTE_DEBIT for the disputed amount plus Stripe's dispute fee.

  it("resolves a membership dispute owner from the order's splits and places a hold", async () => {
    const ctx = makeMembershipDeps();

    const result = await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_open" }),
    );

    expect(result).toMatchObject({ status: "OPEN", triageReason: null });
    expect(ctx.store.get("dp_123")).toMatchObject({
      orderId: ctx.order.id,
      ownerSubjectType: "ORGANIZATION",
      ownerSubjectId: MEMBERSHIP_ORG_ID,
      ownerOrgId: MEMBERSHIP_ORG_ID,
      ownerHumanId: null,
      status: "OPEN",
      linkedAt: NOW,
    });
    expect(ctx.mocks.payees.getById).toHaveBeenCalledWith(MEMBERSHIP_PAYEE_ID);

    const holds = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_HOLD",
    );
    expect(holds).toEqual([
      expect.objectContaining({
        idempotencyKey: `dispute-hold:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
        payeeId: MEMBERSHIP_PAYEE_ID,
        amountCents: 5_000,
        currency: "usd",
        disputeId: "dispute_1",
        orderId: ctx.order.id,
      }),
    ]);

    // The copy must never render "your event" for an eventless membership.
    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("your membership"),
      }),
    );
    expect(ctx.mocks.mailer.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("your event"),
      }),
    );
  });

  it("marks a membership dispute NEEDS_TRIAGE when no single payee can be resolved", async () => {
    const ctx = makeMembershipDeps({ splits: [] });

    const result = await openDispute(ctx.deps, baseDisputeInput());

    expect(result).toMatchObject({
      status: "NEEDS_TRIAGE",
      triageReason: "membership_owner_unresolved",
    });
    expect(ledgerEntries(ctx)).toHaveLength(0);
  });

  it("debits amount plus fee and consumes the hold when a membership dispute is lost", async () => {
    const ctx = makeMembershipDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_open_lost" }),
    );
    await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_m_funds", feeCents: 1_500 }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_m_closed_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const holds = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_HOLD",
    );
    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(holds).toHaveLength(1);
    // Always TWO entries when a payee-borne fee exists: the amount and the fee
    // carry independent idempotency keys so a fee that materialises after the
    // LOST close can still be collected on a later pass.
    expect(debits).toEqual([
      expect.objectContaining({
        idempotencyKey: `dispute-debit:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
        payeeId: MEMBERSHIP_PAYEE_ID,
        amountCents: 5_000,
        currency: "usd",
        disputeId: "dispute_1",
        orderId: ctx.order.id,
        // Consuming the hold: the AMOUNT debit links the hold so it stops
        // counting as an active (pending) hold — the provisional hold is
        // replaced by the real balance debit, never stacked on top of it.
        relatedEntryId: holds[0].id,
        metadata: expect.objectContaining({
          disputedAmountCents: 5_000,
          cappedAmountCents: 5_000,
          source: "hold",
          feeCents: 1_500,
          feeBorneBy: "PAYEE",
        }),
      }),
      expect.objectContaining({
        idempotencyKey: `dispute-debit-fee:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
        payeeId: MEMBERSHIP_PAYEE_ID,
        amountCents: 1_500,
        currency: "usd",
        disputeId: "dispute_1",
        orderId: ctx.order.id,
        // The fee entry must NOT consume a hold — the amount entry already
        // did, and ordering (amount first) guarantees none remains.
        relatedEntryId: null,
        metadata: expect.objectContaining({
          feeCents: 1_500,
          feeBorneBy: "PAYEE",
        }),
      }),
    ]);
    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(0);
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
    ).resolves.toHaveLength(0);
    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "LOST",
      feeCents: 1_500,
      feeBorneBy: "PAYEE",
    });
    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "will be deducted from your upcoming payouts",
        ),
      }),
    );
  });

  it("releases holds and writes no debit when a membership dispute is won", async () => {
    const ctx = makeMembershipDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_open_won" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_m_closed_won" }),
      stripeStatus: "won",
      outcome: "won",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(1);
    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_DEBIT"),
    ).toHaveLength(0);
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
    ).resolves.toHaveLength(0);
    // A plain win has nothing to reverse — no debit ever existed.
    expect(ctx.mocks.payeeLedger.reverseDisputeDebit).not.toHaveBeenCalled();
  });

  it("reverses amount and fee debits when a WON close arrives after a LOST close", async () => {
    // Stripe CAN re-close a dispute in the payee's favour after a LOST close
    // (`resolveNextStatus` lets a close operation flip a terminal status).
    // The LOST close consumed the hold and wrote real DISPUTE_DEBITs, so
    // releaseHoldsForDispute finds nothing — the WON transition must write
    // compensating reversals or the payee stays recovered-from for a dispute
    // they won.
    const ctx = makeMembershipDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_open_flip" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({
        stripeEventId: "evt_m_closed_lost_flip",
        feeCents: 1_500,
      }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    // Sanity: the LOST close debited amount + fee.
    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_DEBIT"),
    ).toHaveLength(2);
    expect(ctx.ledgerBalanceByKey.get(`${MEMBERSHIP_PAYEE_ID}::usd`)).toBe(
      -6_500,
    );

    const wonInput = {
      ...baseDisputeInput({
        stripeEventId: "evt_m_closed_won_flip",
        feeCents: 1_500,
      }),
      stripeStatus: "won",
      outcome: "won",
      closedAt: FUNDS_WITHDRAWN_AT,
    };
    await closeDispute(ctx.deps, wonInput);

    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    const reversals = ledgerEntries(ctx).filter((entry) =>
      entry.idempotencyKey.startsWith("dispute-debit-reversal"),
    );
    expect(reversals).toEqual([
      expect.objectContaining({
        idempotencyKey: `dispute-debit-reversal:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
        type: "DISPUTE_RELEASE",
        payeeId: MEMBERSHIP_PAYEE_ID,
        amountCents: 5_000,
        currency: "usd",
        disputeId: "dispute_1",
        // Names the subject by a short code, never a full id.
        description: `Dispute debit reversed for order ${formatOrderCode(
          debits.find((d) => d.idempotencyKey.startsWith("dispute-debit:"))!
            .orderId!,
        )} (dispute won)`,
        // Linked to the debit it compensates.
        relatedEntryId: debits.find((d) =>
          d.idempotencyKey.startsWith("dispute-debit:"),
        )!.id,
      }),
      expect.objectContaining({
        idempotencyKey: `dispute-debit-reversal-fee:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
        type: "DISPUTE_RELEASE",
        amountCents: 1_500,
        relatedEntryId: debits.find((d) =>
          d.idempotencyKey.startsWith("dispute-debit-fee:"),
        )!.id,
      }),
    ]);
    // Balance fully restored: -6500 debited, +6500 reversed.
    expect(ctx.ledgerBalanceByKey.get(`${MEMBERSHIP_PAYEE_ID}::usd`)).toBe(0);

    // Replay of the WON close (same event and a re-delivery under a fresh
    // event id): the stable reversal keys make both no-ops.
    await closeDispute(ctx.deps, wonInput);
    await closeDispute(ctx.deps, {
      ...wonInput,
      stripeEventId: "evt_m_closed_won_flip_2",
    });
    expect(
      ledgerEntries(ctx).filter((entry) =>
        entry.idempotencyKey.startsWith("dispute-debit-reversal"),
      ),
    ).toHaveLength(2);
    expect(ctx.ledgerBalanceByKey.get(`${MEMBERSHIP_PAYEE_ID}::usd`)).toBe(0);

    // The WON copy must cover the flip without lying: the deduction was
    // credited back.
    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("won"),
        text: expect.stringContaining("credited back"),
      }),
    );
  });

  // ── Ticketing dispute LOST → realised debit ──────────────────────────────
  // Ithas Fire is merchant of record: a lost ticketing dispute debits the
  // platform's Stripe balance, and recovery from the organizer happens through
  // the payee ledger. Ticketing LOST behaves like membership LOST for the
  // PRINCIPAL — hold consumed, DISPUTE_DEBIT per payee, negative payable
  // recovered by the payout batch — with one deliberate difference: Stripe's
  // dispute fee stays platform-borne, so no fee debit is ever written.
  // (Before this, a ticketing LOST wrote nothing and the hold sat forever.)

  it("debits each payee's full share, consumes both holds and writes no fee debit when a ticketing dispute is lost", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_open_lost" }),
    );
    await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_funds", feeCents: 1_500 }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_closed_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const holds = ledgerEntries(ctx)
      .filter((entry) => entry.type === "DISPUTE_HOLD")
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));
    const debits = ledgerEntries(ctx)
      .filter((entry) => entry.type === "DISPUTE_DEBIT")
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));
    expect(holds).toHaveLength(2);
    // The disputed $50 covers the whole $50 of splits: artist owes $30,
    // venue owes $20 — the same allocation the holds were written with, and
    // the SAME keys the membership path uses so WON-after-LOST finds them.
    expect(debits).toEqual([
      expect.objectContaining({
        idempotencyKey: `dispute-debit:dispute_1:payee_artist:usd`,
        payeeId: "payee_artist",
        amountCents: 3_000,
        currency: "usd",
        disputeId: "dispute_1",
        orderId: ctx.order.id,
        relatedEntryId: holds[0].id,
        metadata: expect.objectContaining({
          source: "hold",
          holdAmountCents: 3_000,
          retainedCents: 3_000,
          disputedAmountCents: 5_000,
          cappedAmountCents: 3_000,
          feeCents: 1_500,
          feeBorneBy: "PLATFORM",
        }),
      }),
      expect.objectContaining({
        idempotencyKey: `dispute-debit:dispute_1:payee_venue:usd`,
        payeeId: "payee_venue",
        amountCents: 2_000,
        currency: "usd",
        relatedEntryId: holds[1].id,
        metadata: expect.objectContaining({
          source: "hold",
          cappedAmountCents: 2_000,
        }),
      }),
    ]);
    // Sum of debits == disputed amount; no fee entry anywhere.
    expect(debits.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(
      5_000,
    );
    expect(
      ledgerEntries(ctx).some((entry) =>
        entry.idempotencyKey.startsWith("dispute-debit-fee:"),
      ),
    ).toBe(false);
    expect(ctx.mocks.payeeLedger.debit).toHaveBeenCalledTimes(2);
    // Holds consumed: none active, pending-hold rollup back to zero, and the
    // realised balance carries exactly the principal.
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
    ).resolves.toHaveLength(0);
    await expect(
      ctx.mocks.payeeLedger.getBalance("payee_artist", "usd"),
    ).resolves.toMatchObject({ pendingHoldCents: 0, ledgerBalanceCents: -3_000 });
    await expect(
      ctx.mocks.payeeLedger.getBalance("payee_venue", "usd"),
    ).resolves.toMatchObject({ pendingHoldCents: 0, ledgerBalanceCents: -2_000 });
    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "LOST",
      feeCents: 1_500,
      feeBorneBy: "PLATFORM",
    });
    // The organizer is told the principal comes out of upcoming payouts and
    // that the fee is not theirs — never the old "ops will follow up" line.
    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("lost"),
        text: expect.stringContaining(
          "The disputed amount will be deducted from your upcoming payouts. The card network's dispute fee is not passed on to you.",
        ),
      }),
    );
    expect(ctx.mocks.mailer.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Ops will follow up"),
      }),
    );
  });

  it("writes one debit equal to the hold when a single-payee ticketing dispute is lost", async () => {
    const event = buildEvent();
    const order = buildOrder(event.id);
    const ctx = makeDeps({
      order,
      event,
      splits: [
        {
          id: "split_solo",
          orderId: order.id,
          orderSplitId: "split_solo",
          payeeId: "payee_solo",
          amountCents: 4_200,
        },
      ],
    });

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_solo_open" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_solo_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const [hold] = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_HOLD",
    );
    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    // Disputed $50 but the payee was only credited $42: the hold was capped
    // at the split total at OPEN, and the debit is derived from that hold —
    // amount, key and link all agree.
    expect(hold).toMatchObject({ payeeId: "payee_solo", amountCents: 4_200 });
    expect(debits).toEqual([
      expect.objectContaining({
        idempotencyKey: `dispute-debit:dispute_1:payee_solo:usd`,
        payeeId: "payee_solo",
        amountCents: 4_200,
        relatedEntryId: hold.id,
        metadata: expect.objectContaining({
          source: "hold",
          holdAmountCents: 4_200,
          retainedCents: 4_200,
          disputedAmountCents: 5_000,
          cappedAmountCents: 4_200,
        }),
      }),
    ]);
    expect(
      ledgerEntries(ctx).some((entry) =>
        entry.idempotencyKey.startsWith("dispute-debit-fee:"),
      ),
    ).toBe(false);
  });

  it("prorates a partial ticketing loss across payees so the debits sum to the disputed amount and each matches its hold", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_partial_open", amountCents: 3_333 }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_partial_lost", amountCents: 3_333 }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const holds = ledgerEntries(ctx)
      .filter((entry) => entry.type === "DISPUTE_HOLD")
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));
    const debits = ledgerEntries(ctx)
      .filter((entry) => entry.type === "DISPUTE_DEBIT")
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));

    // 3333 over a 3000/2000 split: 1999.8 → 1999 + 1333.2 → 1333 leaves one
    // cent, handed to the larger remainder (artist) → 2000 / 1333.
    expect(
      debits.map((debit) => ({ payeeId: debit.payeeId, amountCents: debit.amountCents })),
    ).toEqual([
      { payeeId: "payee_artist", amountCents: 2_000 },
      { payeeId: "payee_venue", amountCents: 1_333 },
    ]);
    expect(debits.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(3_333);
    // Each debit is capped at the payee's own split total and equals the
    // hold it consumed to the cent.
    const splitTotals: Record<string, number> = {
      payee_artist: 3_000,
      payee_venue: 2_000,
    };
    // The holds were ALSO written at 3333 (open and close agree here), so
    // each debit equals the hold it consumes to the cent.
    debits.forEach((debit, index) => {
      expect(debit.amountCents).toBeLessThanOrEqual(splitTotals[debit.payeeId]!);
      expect(debit.relatedEntryId).toBe(holds[index].id);
      expect(debit.amountCents).toBe(holds[index].amountCents);
      expect(debit.metadata).toMatchObject({
        source: "hold",
        holdAmountCents: holds[index].amountCents,
        allocatedCents: holds[index].amountCents,
        releasedRemainderCents: 0,
        disputedAmountCents: 3_333,
      });
    });
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
    ).resolves.toHaveLength(0);
  });

  it("writes nothing new when a lost ticketing close replays or a later event observes the LOST status", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_replay_open" }),
    );
    const closeInput = {
      ...baseDisputeInput({ stripeEventId: "evt_t_replay_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    };
    await closeDispute(ctx.deps, closeInput);
    // Same event replayed, a re-delivery under a fresh event id, and a late
    // refresh + funds_withdrawn observing the persisted LOST status.
    await closeDispute(ctx.deps, closeInput);
    await closeDispute(ctx.deps, {
      ...closeInput,
      stripeEventId: "evt_t_replay_lost_2",
    });
    await refreshDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_replay_refresh" }),
    );
    await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_replay_funds", feeCents: 1_500 }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });

    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(debits.map((entry) => entry.idempotencyKey).sort()).toEqual([
      `dispute-debit:dispute_1:payee_artist:usd`,
      `dispute-debit:dispute_1:payee_venue:usd`,
    ]);
    expect(ctx.ledgerBalanceByKey.get("payee_artist::usd")).toBe(-3_000);
    expect(ctx.ledgerBalanceByKey.get("payee_venue::usd")).toBe(-2_000);
  });

  it("keeps a fee that arrives after the lost close platform-borne on ticketing and writes no fee debit", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_latefee_open" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_latefee_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
    // Stripe reports the fee on a later balance-transaction event; on a
    // membership this pass would add the fee entry. Ticketing: never.
    await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_latefee_funds", feeCents: 1_500 }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });

    expect(ctx.store.get("dp_123")).toMatchObject({
      status: "LOST",
      feeCents: 1_500,
      feeBorneBy: "PLATFORM",
    });
    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(debits).toHaveLength(2);
    expect(
      debits.every((entry) => entry.idempotencyKey.startsWith("dispute-debit:")),
    ).toBe(true);
    expect(debits.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(
      5_000,
    );
  });

  it("reverses every ticketing debit when a WON close arrives after a LOST close", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_flip_open" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_flip_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
    expect(ctx.ledgerBalanceByKey.get("payee_artist::usd")).toBe(-3_000);
    expect(ctx.ledgerBalanceByKey.get("payee_venue::usd")).toBe(-2_000);

    const wonInput = {
      ...baseDisputeInput({ stripeEventId: "evt_t_flip_won" }),
      stripeStatus: "won",
      outcome: "won",
      closedAt: FUNDS_WITHDRAWN_AT,
    };
    await closeDispute(ctx.deps, wonInput);

    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    const reversals = ledgerEntries(ctx)
      .filter((entry) => entry.idempotencyKey.startsWith("dispute-debit-reversal"))
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));
    // One reversal per payee debit, keyed exactly as the membership path is,
    // because `reverseDisputeDebits` lists the dispute's debits and needed no
    // change to cover ticketing.
    expect(reversals).toEqual([
      expect.objectContaining({
        idempotencyKey: `dispute-debit-reversal:dispute_1:payee_artist:usd`,
        type: "DISPUTE_RELEASE",
        payeeId: "payee_artist",
        amountCents: 3_000,
        relatedEntryId: debits.find((d) => d.payeeId === "payee_artist")!.id,
      }),
      expect.objectContaining({
        idempotencyKey: `dispute-debit-reversal:dispute_1:payee_venue:usd`,
        type: "DISPUTE_RELEASE",
        payeeId: "payee_venue",
        amountCents: 2_000,
        relatedEntryId: debits.find((d) => d.payeeId === "payee_venue")!.id,
      }),
    ]);
    expect(ctx.ledgerBalanceByKey.get("payee_artist::usd")).toBe(0);
    expect(ctx.ledgerBalanceByKey.get("payee_venue::usd")).toBe(0);

    // Replays of the WON close are no-ops on the stable reversal keys.
    await closeDispute(ctx.deps, wonInput);
    await closeDispute(ctx.deps, { ...wonInput, stripeEventId: "evt_t_flip_won_2" });
    expect(
      ledgerEntries(ctx).filter((entry) =>
        entry.idempotencyKey.startsWith("dispute-debit-reversal"),
      ),
    ).toHaveLength(2);
    expect(ctx.ledgerBalanceByKey.get("payee_artist::usd")).toBe(0);
    expect(ctx.ledgerBalanceByKey.get("payee_venue::usd")).toBe(0);
  });

  it("still debits the full allocated amount when the settlement transfer was already in flight", async () => {
    // The payee was already PAID for this order when the dispute landed.
    // The old marker promised a "manual clawback" that never existed; now
    // the debit is written regardless, the payable goes negative, and the
    // payout batch nets it out of the next transfer. The triage marker stays
    // for visibility only.
    const ctx = makeDeps({
      transferringSettlementIds: new Set(["settlement-in-flight"]),
    });

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_inflight_open" }),
    );
    const result = await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_inflight_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    expect(result).toMatchObject({
      status: "LOST",
      triageReason: "settlement_transfer_in_flight",
    });
    expect(ctx.store.get("dp_123")).toMatchObject({
      metadata: expect.objectContaining({
        settlementTransferBoundary: expect.objectContaining({
          condition: "settlement_transfer_in_flight",
          phase: "post_transfer_dispute_debit",
          requiresManualReview: true,
        }),
      }),
    });
    const debits = ledgerEntries(ctx)
      .filter((entry) => entry.type === "DISPUTE_DEBIT")
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));
    expect(
      debits.map((debit) => ({ payeeId: debit.payeeId, amountCents: debit.amountCents })),
    ).toEqual([
      { payeeId: "payee_artist", amountCents: 3_000 },
      { payeeId: "payee_venue", amountCents: 2_000 },
    ]);
    expect(ctx.ledgerBalanceByKey.get("payee_artist::usd")).toBe(-3_000);
    expect(ctx.ledgerBalanceByKey.get("payee_venue::usd")).toBe(-2_000);
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
    ).resolves.toHaveLength(0);
  });

  it("writes exactly one amount and one fee debit when the lost close replays", async () => {
    const ctx = makeMembershipDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_open_replay" }),
    );
    const closeInput = {
      ...baseDisputeInput({
        stripeEventId: "evt_m_closed_replay",
        feeCents: 1_500,
      }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    };
    await closeDispute(ctx.deps, closeInput);
    // Same event replayed, a re-delivery under a fresh event id, and a late
    // refresh observing the persisted LOST status: still exactly two entries
    // (one amount, one fee) — both keys are stable across replays.
    await closeDispute(ctx.deps, closeInput);
    await closeDispute(ctx.deps, {
      ...closeInput,
      stripeEventId: "evt_m_closed_replay_2",
    });
    await refreshDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_refresh_after_close" }),
    );

    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(debits.map((entry) => entry.idempotencyKey)).toEqual([
      `dispute-debit:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
      `dispute-debit-fee:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
    ]);
  });

  it("debits the amount alone when no fee was reported by close time", async () => {
    const ctx = makeMembershipDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_open_nofee" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_m_closed_nofee" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(debits).toEqual([
      expect.objectContaining({
        idempotencyKey: `dispute-debit:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
        amountCents: 5_000,
        metadata: expect.objectContaining({
          disputedAmountCents: 5_000,
          cappedAmountCents: 5_000,
          feeCents: 0,
        }),
      }),
    ]);
  });

  it("caps the loss debit at the payee's split total when the charge includes sales tax", async () => {
    // We are merchant of record: the buyer's charge (and therefore the
    // dispute) includes sales tax the payee was never credited. $10.00
    // subtotal + $0.98 tax → dispute for 1098, but the payee's split is
    // 1000 — the amount debit is capped there. The fee is theirs in full.
    const order = buildMembershipOrder();
    const ctx = makeMembershipDeps({
      splits: [
        {
          id: "split_membership",
          orderId: order.id,
          orderSplitId: "split_membership",
          payeeId: MEMBERSHIP_PAYEE_ID,
          amountCents: 1_000,
        },
      ],
    });

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_open_tax", amountCents: 1_098 }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({
        stripeEventId: "evt_m_closed_tax",
        amountCents: 1_098,
        feeCents: 1_500,
      }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(debits).toEqual([
      expect.objectContaining({
        idempotencyKey: `dispute-debit:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
        amountCents: 1_000,
        metadata: expect.objectContaining({
          disputedAmountCents: 1_098,
          cappedAmountCents: 1_000,
          holdAmountCents: 1_000,
          retainedCents: 1_000,
        }),
      }),
      expect.objectContaining({
        idempotencyKey: `dispute-debit-fee:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
        amountCents: 1_500,
      }),
    ]);
    // Total debited = capped amount + fee = 2500, never 1098 + 1500.
    expect(debits.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(
      2_500,
    );
  });

  it("collects a fee that materialises only after the lost close on a later pass", async () => {
    const ctx = makeMembershipDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_open_latefee" }),
    );
    const closeInput = {
      ...baseDisputeInput({ stripeEventId: "evt_m_closed_latefee" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    };
    await closeDispute(ctx.deps, closeInput);

    // Fee unknown at close: amount entry only.
    expect(
      ledgerEntries(ctx)
        .filter((entry) => entry.type === "DISPUTE_DEBIT")
        .map((entry) => entry.idempotencyKey),
    ).toEqual([`dispute-debit:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`]);

    // Stripe reports the fee on a later balance-transaction event. The
    // lifecycle re-runs the ledger sync against the persisted LOST status:
    // the fee entry lands, the amount entry replays as a no-op.
    const lateFeeInput = {
      ...baseDisputeInput({
        stripeEventId: "evt_m_funds_latefee",
        feeCents: 1_500,
      }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    };
    await recordFundsWithdrawn(ctx.deps, lateFeeInput);

    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(debits.map((entry) => entry.idempotencyKey)).toEqual([
      `dispute-debit:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
      `dispute-debit-fee:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
    ]);
    expect(debits[1]).toMatchObject({
      amountCents: 1_500,
      // The hold was consumed by the amount entry on the close pass; the fee
      // entry must not touch it.
      relatedEntryId: null,
    });

    // Full replay of BOTH events: still exactly two entries.
    await closeDispute(ctx.deps, closeInput);
    await recordFundsWithdrawn(ctx.deps, lateFeeInput);
    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_DEBIT"),
    ).toHaveLength(2);
  });

  // ── LOST debits are derived from the holds, capped by what is retained ──

  it.each([
    // close 1 over holds 3000/2000: cap 1, largest remainder → artist gets
    // the cent, venue's allocation is 0 → its hold is RELEASED, not debited.
    { label: "far below", closeAmountCents: 1, artist: 1, venue: 0 },
    // close 3333: 1999.8→1999 / 1333.2→1333, leftover cent to artist.
    { label: "partially below", closeAmountCents: 3_333, artist: 2_000, venue: 1_333 },
    // close 9000 > Σ holds: every hold consumed in full, never more.
    { label: "above", closeAmountCents: 9_000, artist: 3_000, venue: 2_000 },
  ])(
    "bounds hold-derived debits by the close amount ($label: $closeAmountCents) and leaves no hold standing",
    async ({ closeAmountCents, artist, venue }) => {
      const ctx = makeDeps();

      await openDispute(
        ctx.deps,
        baseDisputeInput({ stripeEventId: `evt_t_delta_open_${closeAmountCents}` }),
      );
      await closeDispute(ctx.deps, {
        ...baseDisputeInput({
          stripeEventId: `evt_t_delta_lost_${closeAmountCents}`,
          amountCents: closeAmountCents,
        }),
        stripeStatus: "lost",
        outcome: "lost",
        closedAt: FUNDS_WITHDRAWN_AT,
      });

      const holds = ledgerEntries(ctx)
        .filter((entry) => entry.type === "DISPUTE_HOLD")
        .sort((left, right) => left.payeeId.localeCompare(right.payeeId));
      const debits = ledgerEntries(ctx).filter(
        (entry) => entry.type === "DISPUTE_DEBIT",
      );
      const releases = ledgerEntries(ctx).filter(
        (entry) => entry.type === "DISPUTE_RELEASE",
      );
      const expected = [
        { payeeId: "payee_artist", amountCents: artist, hold: holds[0] },
        { payeeId: "payee_venue", amountCents: venue, hold: holds[1] },
      ];
      for (const { payeeId, amountCents, hold } of expected) {
        const debit = debits.find((entry) => entry.payeeId === payeeId);
        const release = releases.find((entry) => entry.payeeId === payeeId);
        if (amountCents > 0) {
          expect(debit).toMatchObject({
            amountCents,
            relatedEntryId: hold.id,
            metadata: expect.objectContaining({
              source: "hold",
              holdAmountCents: hold.amountCents,
              allocatedCents: amountCents,
              disputedAmountCents: closeAmountCents,
              releasedRemainderCents: hold.amountCents - amountCents,
            }),
          });
          expect(release).toBeUndefined();
        } else {
          expect(debit).toBeUndefined();
          expect(release).toMatchObject({
            relatedEntryId: hold.id,
            metadata: expect.objectContaining({
              reason: "dispute_amount_below_hold",
              holdAmountCents: hold.amountCents,
              allocatedCents: 0,
            }),
          });
        }
        expect(amountCents).toBeLessThanOrEqual(hold.amountCents);
        await expect(
          ctx.mocks.payeeLedger.getBalance(payeeId, "usd"),
        ).resolves.toMatchObject({
          pendingHoldCents: 0,
          // `0 - x`, not `-x`: a released payee owes 0, and -0 !== 0 here.
          ledgerBalanceCents: 0 - amountCents,
        });
      }
      // Σ debits == min(close, Σ holds); no active hold survives.
      expect(debits.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(
        Math.min(closeAmountCents, 5_000),
      );
      await expect(
        ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
      ).resolves.toHaveLength(0);
      expect(ctx.mocks.reportError).not.toHaveBeenCalled();
    },
  );

  it("falls back to a splits allocation when a ticketing dispute is lost with no prior hold", async () => {
    // A missed `charge.dispute.created` (or LOST-after-WON): the close is the
    // first event we see, so no hold exists to derive from.
    const ctx = makeDeps();

    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_nohold_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_HOLD"),
    ).toHaveLength(0);
    const debits = ledgerEntries(ctx)
      .filter((entry) => entry.type === "DISPUTE_DEBIT")
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));
    expect(debits).toEqual([
      expect.objectContaining({
        idempotencyKey: `dispute-debit:dispute_1:payee_artist:usd`,
        amountCents: 3_000,
        relatedEntryId: null,
        metadata: expect.objectContaining({
          source: "splits",
          allocatedAmountCents: 3_000,
          retainedCents: 3_000,
          cappedAmountCents: 3_000,
          prorated: false,
        }),
      }),
      expect.objectContaining({
        idempotencyKey: `dispute-debit:dispute_1:payee_venue:usd`,
        amountCents: 2_000,
        relatedEntryId: null,
        metadata: expect.objectContaining({ source: "splits" }),
      }),
    ]);
    expect(ctx.ledgerBalanceByKey.get("payee_artist::usd")).toBe(-3_000);
    expect(ctx.ledgerBalanceByKey.get("payee_venue::usd")).toBe(-2_000);
    expect(ctx.mocks.reportError).not.toHaveBeenCalled();
  });

  it("debits nothing and releases the hold for a payee whose share was fully refunded before the loss", async () => {
    // The artist's $30 was already clawed back by a REFUND_DEBIT; a lost
    // chargeback must not take it a second time. Their hold is released (not
    // left standing against money they are not holding); the venue, never
    // refunded, is debited in full.
    // The refund lands AFTER the dispute opened, so the artist's hold
    // already exists when the loss arrives (a refund BEFORE open now means
    // no hold is written at all — see the hold-cap cases below).
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_refunded_open" }),
    );
    ctx.recordRefund("payee_artist", 3_000);
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_refunded_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(debits).toEqual([
      expect.objectContaining({
        payeeId: "payee_venue",
        amountCents: 2_000,
        metadata: expect.objectContaining({ retainedCents: 2_000 }),
      }),
    ]);
    const artistHold = ledgerEntries(ctx).find(
      (entry) => entry.type === "DISPUTE_HOLD" && entry.payeeId === "payee_artist",
    )!;
    const releases = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_RELEASE",
    );
    expect(releases).toEqual([
      expect.objectContaining({
        payeeId: "payee_artist",
        relatedEntryId: artistHold.id,
        metadata: expect.objectContaining({
          reason: "nothing_retained_from_order",
          holdAmountCents: 3_000,
          retainedCents: 0,
        }),
      }),
    ]);
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
    ).resolves.toHaveLength(0);
    expect(ctx.ledgerBalanceByKey.get("payee_artist::usd") ?? 0).toBe(0);
    expect(ctx.ledgerBalanceByKey.get("payee_venue::usd")).toBe(-2_000);
    // The venue's recovery does not hide that the artist's share is gone:
    // one report, naming the artist, on the transition only.
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dispute_lost_no_debit" }),
      expect.objectContaining({
        tags: { useCase: "closeDispute", reason: "lost_no_debit" },
        extra: expect.objectContaining({
          unrecoverablePayeeIds: ["payee_artist"],
          releasedHolds: [
            expect.objectContaining({
              holdId: artistHold.id,
              reason: "nothing_retained_from_order",
            }),
          ],
        }),
      }),
    );
  });

  it("caps the debit at the un-refunded remainder after a partial refund, still consuming the whole hold", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_partial_refund_open" }),
    );
    ctx.recordRefund("payee_artist", 1_000);
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_partial_refund_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const artistHold = ledgerEntries(ctx).find(
      (entry) => entry.type === "DISPUTE_HOLD" && entry.payeeId === "payee_artist",
    )!;
    const artistDebit = ledgerEntries(ctx).find(
      (entry) => entry.type === "DISPUTE_DEBIT" && entry.payeeId === "payee_artist",
    )!;
    // Credited 3000, refunded 1000 → at most 2000 can come back; the $30
    // hold is consumed in full (its pending effect ends), the debit is 2000.
    expect(artistDebit).toMatchObject({
      amountCents: 2_000,
      relatedEntryId: artistHold.id,
      metadata: expect.objectContaining({
        holdAmountCents: 3_000,
        retainedCents: 2_000,
        cappedAmountCents: 2_000,
      }),
    });
    await expect(
      ctx.mocks.payeeLedger.getBalance("payee_artist", "usd"),
    ).resolves.toMatchObject({ pendingHoldCents: 0, ledgerBalanceCents: -2_000 });
    // The $10 shortfall is platform-absorbed — reported once, on the
    // transition, as its own signal (not `lost_no_debit`: money WAS
    // recovered).
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dispute_debit_capped_by_retained" }),
      expect.objectContaining({
        tags: { useCase: "closeDispute", reason: "dispute_debit_capped_by_retained" },
        extra: {
          disputeId: "dispute_1",
          orderId: ctx.order.id,
          payeeId: "payee_artist",
          allocatedCents: 3_000,
          retainedCents: 2_000,
        },
      }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_partial_refund_lost_2" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("writes the membership fee without consuming the hold when the close amount is zero", async () => {
    // Open at $50 (hold 5000), Stripe closes reporting amount 0 with a
    // $15 fee. The close amount bounds the principal: nothing is allocated,
    // so the hold is RELEASED (no principal debit) and only the fee is
    // written — with consumeHold:false, linking nothing. The pending-hold
    // rollup is untouched by the fee.
    const ctx = makeMembershipDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_zero_open" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({
        stripeEventId: "evt_m_zero_lost",
        amountCents: 0,
        feeCents: 1_500,
      }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const [hold] = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_HOLD",
    );
    const amountDebit = ledgerEntries(ctx).find((entry) =>
      entry.idempotencyKey.startsWith("dispute-debit:"),
    );
    const feeDebit = ledgerEntries(ctx).find((entry) =>
      entry.idempotencyKey.startsWith("dispute-debit-fee:"),
    )!;
    const release = ledgerEntries(ctx).find(
      (entry) => entry.type === "DISPUTE_RELEASE",
    );
    expect(amountDebit).toBeUndefined();
    expect(release).toMatchObject({
      relatedEntryId: hold.id,
      metadata: expect.objectContaining({ reason: "dispute_amount_below_hold" }),
    });
    expect(feeDebit).toMatchObject({ amountCents: 1_500, relatedEntryId: null });
    expect(ctx.mocks.payeeLedger.debit).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `dispute-debit-fee:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
        consumeHold: false,
      }),
    );
    // Pending hold went 5000 → 0 on the RELEASE and the fee left it there;
    // balance carries the fee alone. Something was debited (the fee), so
    // this is not a no-recovery report.
    await expect(
      ctx.mocks.payeeLedger.getBalance(MEMBERSHIP_PAYEE_ID, "usd"),
    ).resolves.toMatchObject({ pendingHoldCents: 0, ledgerBalanceCents: -1_500 });
    // `dispute_amount_below_hold` is Stripe claiming less than we held —
    // never a no-recovery report, fee or no fee.
    expect(ctx.mocks.reportError).not.toHaveBeenCalled();
    // And the copy says so: no principal deduction, fee still deducted.
    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("lost"),
        text: expect.stringContaining(
          "Nothing further will be deducted from your payouts for the disputed amount. The card network's dispute fee will be deducted from your upcoming payouts.",
        ),
      }),
    );
  });

  it("reports a LOST dispute that produced no debit to Sentry and the error log", async () => {
    // Both shares were fully refunded before the dispute: no hold is
    // written at open (retained 0), and at LOST the splits fallback finds
    // nothing retained for either payee. The webhook still succeeds — but
    // silently never recovering the money is exactly what must not happen
    // quietly.
    const ctx = makeDeps({
      priorRefunds: [
        { payeeId: "payee_artist", amountCents: 3_000 },
        { payeeId: "payee_venue", amountCents: 2_000 },
      ],
    });

    const result = await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_nodebit_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    expect(result).toMatchObject({ ok: true, status: "LOST" });
    expect(ledgerEntries(ctx)).toHaveLength(0);
    expect(ctx.mocks.logger.error).toHaveBeenCalledWith(
      "dispute.lifecycle.lost_no_debit",
      expect.objectContaining({
        disputeId: "dispute_1",
        orderId: ctx.order.id,
        unrecoverablePayeeIds: ["payee_artist", "payee_venue"],
      }),
    );
    // The organizer is told nothing further comes out — not "the disputed
    // amount will be deducted".
    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("lost"),
        text: expect.stringContaining(
          "Nothing further will be deducted from your payouts for this dispute. The card network's dispute fee is not passed on to you.",
        ),
      }),
    );
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dispute_lost_no_debit" }),
      expect.objectContaining({
        tags: { useCase: "closeDispute", reason: "lost_no_debit" },
        extra: expect.objectContaining({
          disputeId: "dispute_1",
          orderId: ctx.order.id,
        }),
      }),
    );
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);

    // Only the TRANSITION into LOST reports. The same event replayed, a
    // re-delivery under a fresh id, and a later funds_withdrawn all observe
    // the persisted LOST status and must not page again.
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_nodebit_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_nodebit_lost_2" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
    await recordFundsWithdrawn(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_nodebit_funds", feeCents: 1_500 }),
      fundsWithdrawnAt: FUNDS_WITHDRAWN_AT,
    });
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it("keeps the lifecycle result when the no-debit reporter throws", async () => {
    const ctx = makeDeps({
      priorRefunds: [
        { payeeId: "payee_artist", amountCents: 3_000 },
        { payeeId: "payee_venue", amountCents: 2_000 },
      ],
      reporterThrows: true,
    });

    await expect(
      closeDispute(ctx.deps, {
        ...baseDisputeInput({ stripeEventId: "evt_t_nodebit_throws" }),
        stripeStatus: "lost",
        outcome: "lost",
        closedAt: FUNDS_WITHDRAWN_AT,
      }),
    ).resolves.toMatchObject({ ok: true, status: "LOST" });
    expect(ctx.mocks.reportError).toHaveBeenCalled();
  });

  it("does not report a replayed LOST close as a no-debit after a later refund shrinks the cap", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_replaycap_open" }),
    );
    const closeInput = {
      ...baseDisputeInput({ stripeEventId: "evt_t_replaycap_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    };
    await closeDispute(ctx.deps, closeInput);
    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_DEBIT"),
    ).toHaveLength(2);

    // A refund lands after the loss (the asymmetric case the refund path
    // owns), then Stripe re-delivers the close: existing debits are
    // recognised as the replay, nothing new is written, nothing is reported.
    ctx.mocks.payeeLedger.listOrderEntries.mockResolvedValue([]);
    await closeDispute(ctx.deps, {
      ...closeInput,
      stripeEventId: "evt_t_replaycap_lost_2",
    });
    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_DEBIT"),
    ).toHaveLength(2);
    expect(ctx.mocks.reportError).not.toHaveBeenCalled();
  });

  it("uses one WON wording for both product lines that is true with or without a prior debit", async () => {
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_won_copy_open" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_won_copy" }),
      stripeStatus: "won",
      outcome: "won",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("won"),
        text: expect.stringContaining(
          "Nothing will be deducted from your payouts for it. Any hold on the affected payout share has been released, and any amount already deducted for this dispute has been credited back.",
        ),
      }),
    );
    expect(ctx.mocks.mailer.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("manual review"),
      }),
    );
  });

  // ── Round 4: hold cap at OPEN, dispute-aware cap, reason-driven report ──

  it("writes no hold at open for a payee whose share was fully refunded, and caps a partially refunded share", async () => {
    const ctx = makeDeps({
      priorRefunds: [
        { payeeId: "payee_artist", amountCents: 3_000 },
        { payeeId: "payee_venue", amountCents: 500 },
      ],
    });

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_holdcap_open" }),
    );

    // Artist retains nothing → no hold (nothing to withhold, and a hold
    // would freeze their OTHER payouts until close). Venue retains 1500 of
    // its 2000 allocation → hold 1500.
    const holds = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_HOLD",
    );
    expect(holds).toEqual([
      expect.objectContaining({
        payeeId: "payee_venue",
        amountCents: 1_500,
        metadata: expect.objectContaining({
          allocatedAmountCents: 2_000,
          retainedCents: 1_500,
          heldAmountCents: 1_500,
        }),
      }),
    ]);
    expect(ctx.mocks.payeeLedger.hold).toHaveBeenCalledTimes(1);
  });

  it("caps a second dispute on the same order by the first dispute's realised debit", async () => {
    // Dispute 1 ($10) is lost first: debits 600/400. Dispute 2 ($50) on the
    // same order then opens: artist retains 3000−600=2400, venue 2000−400=
    // 1600, so its holds — and, when lost, its debits — stop there. Total
    // per payee never exceeds the credit.
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_d1_open", amountCents: 1_000 }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_d1_lost", amountCents: 1_000 }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
    expect(
      ledgerEntries(ctx)
        .filter((entry) => entry.type === "DISPUTE_DEBIT")
        .map((entry) => entry.amountCents)
        .sort(),
    ).toEqual([400, 600]);

    const second = { ...baseDisputeInput({ stripeEventId: "evt_d2_open" }), stripeDisputeId: "dp_456" };
    await openDispute(ctx.deps, second);
    const secondHolds = ledgerEntries(ctx)
      .filter((entry) => entry.type === "DISPUTE_HOLD" && entry.disputeId === "dispute_2")
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));
    expect(
      secondHolds.map((hold) => ({ payeeId: hold.payeeId, amountCents: hold.amountCents })),
    ).toEqual([
      { payeeId: "payee_artist", amountCents: 2_400 },
      { payeeId: "payee_venue", amountCents: 1_600 },
    ]);

    await closeDispute(ctx.deps, {
      ...second,
      stripeEventId: "evt_d2_lost",
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
    const secondDebits = ledgerEntries(ctx)
      .filter((entry) => entry.type === "DISPUTE_DEBIT" && entry.disputeId === "dispute_2")
      .sort((left, right) => left.payeeId.localeCompare(right.payeeId));
    expect(
      secondDebits.map((debit) => ({ payeeId: debit.payeeId, amountCents: debit.amountCents })),
    ).toEqual([
      { payeeId: "payee_artist", amountCents: 2_400 },
      { payeeId: "payee_venue", amountCents: 1_600 },
    ]);
    // Σ dispute principal per payee == credit, never above.
    expect(ctx.ledgerBalanceByKey.get("payee_artist::usd")).toBe(-3_000);
    expect(ctx.ledgerBalanceByKey.get("payee_venue::usd")).toBe(-2_000);
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_2"),
    ).resolves.toHaveLength(0);
    // Silent on purpose: dispute 2's holds were already capped at retained
    // when they were WRITTEN (2400/1600), so at LOST allocated == retained
    // and nothing was absorbed at close. The capped-by-retained signal is
    // for a refund that lands AFTER the hold — see the partial-refund case.
    expect(ctx.mocks.reportError).not.toHaveBeenCalled();
  });

  it("reports a refunded membership loss once even though the fee was debited, and says so in the copy", async () => {
    // The member was fully refunded before the dispute (retained 0): no
    // hold at open, nothing to recover at LOST — but the fee is still the
    // payee's. A fee entry must not hide the unrecoverable principal.
    const ctx = makeMembershipDeps({
      priorRefunds: [{ payeeId: MEMBERSHIP_PAYEE_ID, amountCents: 5_000 }],
    });

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_refunded_open" }),
    );
    expect(
      ledgerEntries(ctx).filter((entry) => entry.type === "DISPUTE_HOLD"),
    ).toHaveLength(0);
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_m_refunded_lost", feeCents: 1_500 }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const debits = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_DEBIT",
    );
    expect(debits.map((entry) => entry.idempotencyKey)).toEqual([
      `dispute-debit-fee:dispute_1:${MEMBERSHIP_PAYEE_ID}:usd`,
    ]);
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dispute_lost_no_debit" }),
      expect.objectContaining({
        tags: { useCase: "closeDispute", reason: "lost_no_debit" },
        extra: expect.objectContaining({
          feeDebited: true,
          unrecoverablePayeeIds: [MEMBERSHIP_PAYEE_ID],
        }),
      }),
    );
    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("lost"),
        text: expect.stringContaining(
          "Nothing further will be deducted from your payouts for the disputed amount. The card network's dispute fee will be deducted from your upcoming payouts.",
        ),
      }),
    );

    // Replay: no second report.
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_m_refunded_lost_2", feeCents: 1_500 }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("keeps the deducted wording on a membership loss whose principal was debited", async () => {
    const ctx = makeMembershipDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_m_copy_open" }),
    );
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_m_copy_lost", feeCents: 1_500 }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    expect(ctx.mocks.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "The disputed amount plus the card network's dispute fee will be deducted from your upcoming payouts.",
        ),
      }),
    );
  });

  it("releases and reports a duplicate active hold instead of stranding it", async () => {
    // Unreachable by the key convention; planted directly to prove the
    // group loop consumes every hold and the anomaly is surfaced.
    const ctx = makeDeps();

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_dup_open" }),
    );
    await ctx.mocks.payeeLedger.hold({
      idempotencyKey: "dispute-hold:dispute_1:payee_artist:usd:rogue",
      payeeId: "payee_artist",
      amountCents: 700,
      currency: "usd",
      disputeId: "dispute_1",
      orderId: ctx.order.id,
    });
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_dup_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    const rogue = ledgerEntries(ctx).find(
      (entry) => entry.idempotencyKey === "dispute-hold:dispute_1:payee_artist:usd:rogue",
    )!;
    const releases = ledgerEntries(ctx).filter(
      (entry) => entry.type === "DISPUTE_RELEASE",
    );
    expect(releases).toEqual([
      expect.objectContaining({
        relatedEntryId: rogue.id,
        metadata: expect.objectContaining({ reason: "duplicate_hold_superseded" }),
      }),
    ]);
    // The group total (3700) is allocated/capped: retained 3000 → debit 3000.
    const artistDebit = ledgerEntries(ctx).find(
      (entry) => entry.type === "DISPUTE_DEBIT" && entry.payeeId === "payee_artist",
    )!;
    expect(artistDebit).toMatchObject({
      amountCents: 3_000,
      metadata: expect.objectContaining({ holdAmountCents: 3_700, retainedCents: 3_000 }),
    });
    await expect(
      ctx.mocks.payeeLedger.listActiveHoldsByDispute("dispute_1"),
    ).resolves.toHaveLength(0);
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dispute_duplicate_active_holds" }),
      expect.objectContaining({
        tags: { useCase: "closeDispute", reason: "duplicate_active_holds" },
        extra: expect.objectContaining({ duplicateHoldIds: [rogue.id] }),
      }),
    );
  });

  it("reports an unrecoverable share even when another payee's share was debited", async () => {
    // Artist fully refunded BEFORE the dispute → no hold at open → never
    // enters the hold groups at LOST. The venue's successful debit must not
    // hide that the artist's share is gone for good.
    const ctx = makeDeps({
      priorRefunds: [{ payeeId: "payee_artist", amountCents: 3_000 }],
    });

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_t_mixed_open" }),
    );
    expect(
      ledgerEntries(ctx)
        .filter((entry) => entry.type === "DISPUTE_HOLD")
        .map((entry) => entry.payeeId),
    ).toEqual(["payee_venue"]);
    await closeDispute(ctx.deps, {
      ...baseDisputeInput({ stripeEventId: "evt_t_mixed_lost" }),
      stripeStatus: "lost",
      outcome: "lost",
      closedAt: FUNDS_WITHDRAWN_AT,
    });

    expect(
      ledgerEntries(ctx)
        .filter((entry) => entry.type === "DISPUTE_DEBIT")
        .map((entry) => ({ payeeId: entry.payeeId, amountCents: entry.amountCents })),
    ).toEqual([{ payeeId: "payee_venue", amountCents: 2_000 }]);
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dispute_lost_no_debit" }),
      expect.objectContaining({
        tags: { useCase: "closeDispute", reason: "lost_no_debit" },
        extra: expect.objectContaining({
          unrecoverablePayeeIds: ["payee_artist"],
        }),
      }),
    );
  });

  // ── Reporter wiring for swallowed notification failures ─────────────────
  // The notifier tells payees money left their balance; its catch-and-degrade
  // branches must reach Sentry via reportError (logger.warn is not captured).

  it("reports a swallowed mailer failure to the error reporter", async () => {
    const ctx = makeDeps({ mailerRejects: true });

    await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_report_mailer" }),
    );

    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "smtp unavailable" }),
      expect.objectContaining({
        tags: { area: "dispute_notify", stage: "email" },
      }),
    );
  });

  it("reports a swallowed recipient-resolution failure to the error reporter", async () => {
    const ctx = makeDeps();
    ctx.mocks.organizations.listMembers.mockRejectedValue(
      new Error("db unavailable"),
    );

    await expect(
      openDispute(
        ctx.deps,
        baseDisputeInput({ stripeEventId: "evt_report_recipients" }),
      ),
    ).resolves.toMatchObject({ ok: true, status: "OPEN" });

    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db unavailable" }),
      expect.objectContaining({
        tags: { area: "dispute_notify", stage: "recipient_resolution" },
      }),
    );
  });

  it("keeps notify behaviour unchanged when the reporter itself throws", async () => {
    const ctx = makeDeps({ mailerRejects: true, reporterThrows: true });

    await expect(
      openDispute(
        ctx.deps,
        baseDisputeInput({ stripeEventId: "evt_report_throws" }),
      ),
    ).resolves.toMatchObject({ ok: true, status: "OPEN" });

    // The swallow branch still logs, and the throwing reporter was invoked
    // without breaking the lifecycle result above.
    expect(ctx.mocks.reportError).toHaveBeenCalled();
    expect(ctx.mocks.logger.warn).toHaveBeenCalledWith(
      "dispute.lifecycle.email_failed",
      expect.objectContaining({ error: "smtp unavailable" }),
    );
  });
});

function baseDisputeInput(
  overrides: Partial<{
    stripeEventId: string;
    amountCents: number;
    feeCents: number | null;
    isWarning: boolean;
  }> = {},
) {
  return {
    stripeEventId: overrides.stripeEventId ?? "evt_open",
    stripeDisputeId: "dp_123",
    stripeChargeId: "ch_123",
    paymentIntentId: "pi_123",
    amountCents: overrides.amountCents ?? 5_000,
    feeCents: overrides.feeCents === undefined ? null : overrides.feeCents,
    currency: "USD",
    reason: "fraudulent",
    stripeStatus: "needs_response",
    isWarning: overrides.isWarning ?? false,
    evidenceDueBy: EVIDENCE_DUE_BY,
    metadata: { source: "stripe_webhook" },
  };
}

function makeDeps(
  options: {
    order?: OrderRecord | null;
    event?: EventRecord;
    orgMembers?: OrgMemberRecord[];
    humanIdentities?: Map<string, HumanWithIdentity>;
    mailerRejects?: boolean;
    reporterThrows?: boolean;
    transferringSettlementIds?: Set<string>;
    splits?: SplitEntry[];
    payeeSubjects?: Map<string, PayeeRecord>;
    // Seeds SETTLEMENT_CREDIT rows per payee from the splits (the credit
    // writer's exact shape) so the LOST cap sees a credited order. Default
    // true; false models an order that was never credited.
    seedCredits?: boolean;
    // Prior REFUND_DEBIT rows on the order, per payee — what the LOST cap
    // subtracts.
    priorRefunds?: Array<{ payeeId: string; amountCents: number }>;
  } = {},
) {
  const event = options.event ?? buildEvent();
  const order =
    options.order === undefined ? buildOrder(event.id) : options.order;
  const store = new Map<string, DisputeRecord>();
  const idempotency = createFakeIdempotencyPort();
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const orgMembers = options.orgMembers ?? buildOrgMembers();
  const humanIdentities = options.humanIdentities ?? buildHumanIdentities();
  const orderSplits = options.splits ?? buildOrderSplits(order?.id ?? buildOrder(event.id).id);
  const payeeSubjects = options.payeeSubjects ?? new Map<string, PayeeRecord>();
  const ledgerEntriesByKey = new Map<string, PayeeLedgerEntryRecord>();
  const ledgerEntriesById = new Map<string, PayeeLedgerEntryRecord>();
  // The order's credit/refund history, served by `listOrderEntries` (the
  // refund writers' read, reused by the LOST cap). Kept OUT of
  // ledgerEntriesById so assertions over dispute-written entries stay exact.
  const orderEntries: PayeeLedgerEntryRecord[] = [];
  const seedOrderEntry = (
    type: "SETTLEMENT_CREDIT" | "REFUND_DEBIT",
    payeeId: string,
    amountCents: number,
    seq: number,
  ) => {
    const orderId = order?.id ?? "no-order";
    orderEntries.push({
      id: `order_entry_${type}_${payeeId}_${seq}`,
      idempotencyKey:
        type === "SETTLEMENT_CREDIT"
          ? `settlement-credit:${orderId}:${payeeId}`
          : `refund-debit:${orderId}:${payeeId}:refund_${seq}`,
      payeeId,
      type,
      amountCents,
      currency: "usd",
      sourceKind: type === "SETTLEMENT_CREDIT" ? "order_split" : "order_refund",
      sourceId: orderId,
      orderId,
      settlementId: null,
      disputeId: null,
      relatedEntryId: null,
      description: type,
      metadata: null,
      createdAt: NOW,
    });
  };
  if (order && options.seedCredits !== false) {
    const creditByPayee = new Map<string, number>();
    for (const split of orderSplits) {
      if (split.amountCents <= 0) continue;
      creditByPayee.set(
        split.payeeId,
        (creditByPayee.get(split.payeeId) ?? 0) + split.amountCents,
      );
    }
    for (const [payeeId, amountCents] of creditByPayee) {
      seedOrderEntry("SETTLEMENT_CREDIT", payeeId, amountCents, 0);
    }
  }
  (options.priorRefunds ?? []).forEach((refund, index) => {
    seedOrderEntry("REFUND_DEBIT", refund.payeeId, refund.amountCents, index + 1);
  });
  // Stateful ledgerBalanceCents per `${payeeId}::${currency}`, mirroring the
  // adapter's rollup: a created debit decrements, a created debit-reversal
  // increments, replays touch nothing.
  const ledgerBalanceByKey = new Map<string, number>();
  const bumpLedgerBalance = (
    payeeId: string,
    currency: string,
    deltaCents: number,
  ) => {
    const key = `${payeeId}::${currency}`;
    ledgerBalanceByKey.set(key, (ledgerBalanceByKey.get(key) ?? 0) + deltaCents);
  };
  let nextDisputeId = 1;
  let nextLedgerEntryId = 1;

  const disputes = {
    findByStripeDisputeId: vi.fn(async (stripeDisputeId: string) => {
      return store.get(stripeDisputeId) ?? null;
    }),
    upsertFromStripe: vi.fn(async (input) => {
      const existing = store.get(input.stripeDisputeId);
      const record: DisputeRecord = {
        id: existing?.id ?? `dispute_${nextDisputeId++}`,
        stripeDisputeId: input.stripeDisputeId,
        stripeChargeId: input.stripeChargeId ?? null,
        paymentIntentId: input.paymentIntentId ?? null,
        orderId: input.orderId ?? null,
        ownerSubjectType: input.ownerSubjectType ?? null,
        ownerSubjectId: input.ownerSubjectId ?? null,
        ownerOrgId: input.ownerOrgId ?? null,
        ownerHumanId: input.ownerHumanId ?? null,
        amountCents: input.amountCents,
        feeCents: input.feeCents ?? existing?.feeCents ?? 0,
        feeBorneBy: input.feeBorneBy ?? existing?.feeBorneBy ?? null,
        currency: input.currency,
        reason: input.reason,
        status: input.status,
        triageReason: input.triageReason ?? null,
        linkedAt: input.linkedAt ?? null,
        evidenceDueBy: input.evidenceDueBy ?? null,
        fundsWithdrawnAt: input.fundsWithdrawnAt ?? null,
        closedAt: input.closedAt ?? null,
        outcome: input.outcome ?? null,
        metadata: input.metadata ?? null,
        // Evidence-desk columns: nothing in the lifecycle writes them; the
        // fixture carries them so the record matches `DisputeRecord`.
        evidenceHasEvidence: existing?.evidenceHasEvidence ?? null,
        evidencePastDue: existing?.evidencePastDue ?? null,
        evidenceSubmissionCount: existing?.evidenceSubmissionCount ?? null,
        evidenceSubmittedAt: existing?.evidenceSubmittedAt ?? null,
        createdAt: existing?.createdAt ?? NOW,
        updatedAt: NOW,
      };
      store.set(record.stripeDisputeId, record);
      return record;
    }),
  };

  const orders = {
    getById: vi.fn(async (orderId: string) => {
      return order && order.id === orderId ? order : null;
    }),
    findByPaymentIntent: vi.fn(async (paymentIntentId: string) => {
      if (!order || order.stripePaymentIntentId !== paymentIntentId)
        return null;
      return { id: order.id, status: order.status };
    }),
    markDisputeStatus: vi.fn(async (input) => {
      if (order && order.id === input.orderId) {
        order.disputeStatus = input.disputeStatus;
        order.disputedAt = input.disputedAt ?? order.disputedAt ?? null;
      }
    }),
  };

  const events = {
    getById: vi.fn(async (eventId: string) => {
      return event.id === eventId ? event : null;
    }),
  };

  const splits = {
    getForOrder: vi.fn(async (orderId: string) => {
      return order && order.id === orderId ? orderSplits : [];
    }),
    upsertForOrder: vi.fn(async () => undefined),
  };

  const payees = {
    getById: vi.fn(async (payeeId: string) => {
      return payeeSubjects.get(payeeId) ?? null;
    }),
  };

  const listActiveHoldsByDispute = vi.fn(async (disputeId: string) => {
    const entries = [...ledgerEntriesById.values()];
    return entries.filter((entry) => {
      if (entry.type !== "DISPUTE_HOLD" || entry.disputeId !== disputeId) {
        return false;
      }
      return !entries.some(
        (related) =>
          related.relatedEntryId === entry.id &&
          (related.type === "DISPUTE_RELEASE" || related.type === "DISPUTE_DEBIT"),
      );
    });
  });

  const releaseHold = vi.fn(
    async (input: {
      holdEntryId: string;
      idempotencyKey?: string | null;
      description?: string | null;
      metadata?: unknown;
    }) => {
    const hold = ledgerEntriesById.get(input.holdEntryId);
    if (!hold || hold.type !== "DISPUTE_HOLD" || !hold.disputeId) return null;

    const idempotencyKey =
      input.idempotencyKey ?? `dispute-release:${hold.disputeId}:${hold.id}`;
    const existing = ledgerEntriesByKey.get(idempotencyKey);
    if (existing) return existing;

    const release: PayeeLedgerEntryRecord = {
      ...hold,
      id: `ledger_${nextLedgerEntryId++}`,
      idempotencyKey,
      type: "DISPUTE_RELEASE",
      sourceId: hold.disputeId,
      relatedEntryId: hold.id,
      description:
        input.description ?? `Dispute hold released for ${hold.disputeId}`,
      metadata: input.metadata ?? null,
      createdAt: NOW,
    };
    ledgerEntriesByKey.set(release.idempotencyKey, release);
    ledgerEntriesById.set(release.id, release);
    return release;
    },
  );

  const payeeLedger = {
    // Mirrors the adapter: credit/refund/reversal history PLUS the order's
    // DISPUTE_DEBIT / DISPUTE_RELEASE rows (so a second dispute's cap sees
    // the first's realised debit).
    listOrderEntries: vi.fn(async (orderId: string) => [
      ...orderEntries.filter((entry) => entry.orderId === orderId),
      ...[...ledgerEntriesById.values()].filter(
        (entry) =>
          entry.orderId === orderId &&
          (entry.type === "DISPUTE_DEBIT" || entry.type === "DISPUTE_RELEASE"),
      ),
    ]),
    hold: vi.fn(async (input) => {
      const existing = ledgerEntriesByKey.get(input.idempotencyKey);
      if (existing) return existing;

      const entry: PayeeLedgerEntryRecord = {
        id: `ledger_${nextLedgerEntryId++}`,
        idempotencyKey: input.idempotencyKey,
        payeeId: input.payeeId,
        type: "DISPUTE_HOLD",
        amountCents: input.amountCents,
        currency: input.currency,
        sourceKind: "dispute",
        sourceId: input.sourceId ?? input.disputeId,
        orderId: input.orderId ?? null,
        settlementId: null,
        disputeId: input.disputeId,
        relatedEntryId: null,
        description: input.description ?? `Dispute hold for ${input.disputeId}`,
        metadata: input.metadata ?? null,
        createdAt: NOW,
      };
      ledgerEntriesByKey.set(entry.idempotencyKey, entry);
      ledgerEntriesById.set(entry.id, entry);
      return entry;
    }),
    // Mirrors the Prisma adapter's debit semantics: idempotent on key, and a
    // debit consumes the dispute's active hold for the same payee+currency by
    // linking relatedEntryId (DISPUTE_DEBIT is a release type).
    debit: vi.fn(async (input) => {
      const existing = ledgerEntriesByKey.get(input.idempotencyKey);
      if (existing) return existing;

      // `consumeHold: false` (the fee entry) never touches a hold — mirrors
      // the adapter's guard.
      const activeHolds =
        input.consumeHold === false
          ? []
          : await listActiveHoldsByDispute(input.disputeId);
      const consumedHold =
        activeHolds.find(
          (hold) =>
            hold.payeeId === input.payeeId && hold.currency === input.currency,
        ) ?? null;

      const entry: PayeeLedgerEntryRecord = {
        id: `ledger_${nextLedgerEntryId++}`,
        idempotencyKey: input.idempotencyKey,
        payeeId: input.payeeId,
        type: "DISPUTE_DEBIT",
        amountCents: input.amountCents,
        currency: input.currency,
        sourceKind: "dispute",
        sourceId: input.sourceId ?? input.disputeId,
        orderId: input.orderId ?? null,
        settlementId: null,
        disputeId: input.disputeId,
        relatedEntryId: consumedHold?.id ?? null,
        description: input.description ?? `Dispute debit for ${input.disputeId}`,
        metadata: input.metadata ?? null,
        createdAt: NOW,
      };
      ledgerEntriesByKey.set(entry.idempotencyKey, entry);
      ledgerEntriesById.set(entry.id, entry);
      bumpLedgerBalance(entry.payeeId, entry.currency, -entry.amountCents);
      return entry;
    }),
    // Mirrors the Prisma adapter's reverseDisputeDebit: idempotent on key,
    // DISPUTE_RELEASE typed, links the compensated debit via relatedEntryId,
    // and increments ledgerBalanceCents only when actually created.
    reverseDisputeDebit: vi.fn(async (input) => {
      const existing = ledgerEntriesByKey.get(input.idempotencyKey);
      if (existing) return existing;

      const entry: PayeeLedgerEntryRecord = {
        id: `ledger_${nextLedgerEntryId++}`,
        idempotencyKey: input.idempotencyKey,
        payeeId: input.payeeId,
        type: "DISPUTE_RELEASE",
        amountCents: input.amountCents,
        currency: input.currency,
        sourceKind: "dispute",
        sourceId: input.disputeId,
        orderId: input.orderId ?? null,
        settlementId: null,
        disputeId: input.disputeId,
        relatedEntryId: input.debitEntryId,
        description:
          input.description ??
          `Dispute debit reversed for ${input.disputeId} (dispute won)`,
        metadata: input.metadata ?? null,
        createdAt: NOW,
      };
      ledgerEntriesByKey.set(entry.idempotencyKey, entry);
      ledgerEntriesById.set(entry.id, entry);
      bumpLedgerBalance(entry.payeeId, entry.currency, entry.amountCents);
      return entry;
    }),
    listDebitsForDispute: vi.fn(async (disputeId: string) => {
      return [...ledgerEntriesById.values()].filter(
        (entry) =>
          entry.type === "DISPUTE_DEBIT" && entry.disputeId === disputeId,
      );
    }),
    listActiveHoldsByDispute,
    releaseHold,
    releaseHoldsForDispute: vi.fn(async (disputeId: string) => {
      const holds = await listActiveHoldsByDispute(disputeId);
      const releases: PayeeLedgerEntryRecord[] = [];
      for (const hold of holds) {
        const release = await releaseHold({ holdEntryId: hold.id });
        if (release) releases.push(release);
      }
      return releases;
    }),
    // Mirrors the adapter's rollup: pendingHoldCents counts ACTIVE holds only
    // — a hold consumed by a DISPUTE_RELEASE/DISPUTE_DEBIT has had its
    // pending-hold effect removed (decreasePendingHoldWithoutGoingNegative).
    getBalance: vi.fn(async (payeeId: string, currency: string) => {
      const entries = [...ledgerEntriesById.values()];
      return {
        payeeId,
        currency,
        ledgerBalanceCents: ledgerBalanceByKey.get(`${payeeId}::${currency}`) ?? 0,
        pendingHoldCents: entries
          .filter(
            (entry) =>
              entry.payeeId === payeeId &&
              entry.currency === currency &&
              entry.type === "DISPUTE_HOLD" &&
              !entries.some(
                (related) =>
                  related.relatedEntryId === entry.id &&
                  (related.type === "DISPUTE_RELEASE" ||
                    related.type === "DISPUTE_DEBIT"),
              ),
          )
          .reduce((sum, entry) => sum + entry.amountCents, 0),
        reserveCents: 0,
        availableCents: 0,
      };
    }),
    listEntries: vi.fn(async (payeeId: string) => {
      return [...ledgerEntriesById.values()].filter(
        (entry) => entry.payeeId === payeeId,
      );
    }),
  };

  const notifications = {
    create: vi.fn(async () => ({ id: "notification_1", createdAt: NOW })),
  };

  const organizations = {
    listMembers: vi.fn(async (input: { limit: number; offset: number }) => {
      return {
        items: orgMembers.slice(input.offset, input.offset + input.limit),
        total: orgMembers.length,
      };
    }),
  };

  const humans = {
    getByIdWithIdentity: vi.fn(async (humanId: string) => {
      return humanIdentities.get(humanId) ?? null;
    }),
  };

  const settlementLines = {
    settlementIdsForOrderWithSettlementStatuses: vi.fn(
      async (_orderId: string, _statuses: readonly string[]) => {
        return options.transferringSettlementIds ?? new Set<string>();
      },
    ),
  };

  const audit = { log: vi.fn(async () => undefined) };
  const txRepos = {
    disputes,
    orders,
    events,
    splits,
    payees,
    payeeLedger,
    notifications,
    organizations,
    humans,
    settlementLines,
    audit,
  } as unknown as TxRepos;
  const repos = {
    ...txRepos,
    tx: vi.fn(async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos)),
  } as unknown as Repos;

  const mailer = {
    send: vi.fn(async () => {
      if (options.mailerRejects) throw new Error("smtp unavailable");
      return { result: { success: true, id: "email_1" } };
    }),
    sendBatch: vi.fn(async () => ({ results: [], okCount: 0, errorCount: 0 })),
    health: vi.fn(async () => ({ ok: true })),
  };
  const discordAlert = vi.fn(async () => undefined);
  const reportError = vi.fn(() => {
    if (options.reporterThrows) throw new Error("sentry unavailable");
  });

  return {
    deps: {
      repos,
      idempotency,
      clock: { now: () => NOW },
      logger,
      mailer,
      publicAppUrl: "https://ithasfire.test",
      discordAlert,
      reportError,
    },
    event,
    order: order ?? buildOrder(event.id),
    store,
    mocks: {
      disputes,
      orders,
      events,
      splits,
      payees,
      payeeLedger,
      notifications,
      organizations,
      humans,
      settlementLines,
      audit,
      idempotency,
      logger,
      mailer,
      discordAlert,
      reportError,
    },
    ledgerEntriesById,
    ledgerBalanceByKey,
    // A refund landing AFTER open (the refund path's REFUND_DEBIT), so the
    // LOST cap can be exercised against a hold that already exists.
    recordRefund: (payeeId: string, amountCents: number) =>
      seedOrderEntry("REFUND_DEBIT", payeeId, amountCents, 900 + orderEntries.length),
  };
}

describe("dispute lifecycle idempotency claim on failure", () => {
  // Live 2026-09-01: a transient DB error inside the lifecycle tx left a
  // 15-minute `failed:` marker, and every DLQ replay of the event was refused
  // with IDEMPOTENCY_LOCK_IN_PROGRESS until it expired (19:54Z → 20:06Z).
  it("a transient failure RELEASES the claim so the very next attempt can proceed", async () => {
    const ctx = makeDeps();
    ctx.mocks.orders.markDisputeStatus.mockRejectedValueOnce(
      new Error("db_unavailable"),
    );
    const idem = ctx.mocks.idempotency.__mocks;

    await expect(
      openDispute(ctx.deps, baseDisputeInput({ stripeEventId: "evt_transient" })),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    expect(idem.fail).not.toHaveBeenCalled();
    expect(idem.release).toHaveBeenCalledTimes(1);
    const [key, ownerToken] = idem.release.mock.calls[0] as [string, string];
    // The lifecycle key is per Stripe EVENT, which is exactly what a DLQ
    // replay re-presents — so this is the key a replay must find free.
    expect(key).toBe("stripe-dispute:evt_transient");
    expect(ownerToken).toEqual(expect.any(String));
    // Owner-scoped: the token released is the one `begin` was given.
    expect(idem.begin).toHaveBeenCalledWith(key, expect.any(Number), ownerToken);

    // The replay is not refused: same event, fresh claim, success.
    const replay = await openDispute(
      ctx.deps,
      baseDisputeInput({ stripeEventId: "evt_transient" }),
    );
    expect(replay).toMatchObject({ ok: true, status: "OPEN" });
    expect(idem.commit).toHaveBeenCalledTimes(1);
  });

  it("a commit that throws after the lifecycle tx committed KEEPS the claim: the replay is refused, nothing re-persisted, no duplicate notice", async () => {
    const ctx = makeDeps();
    const idem = ctx.mocks.idempotency.__mocks;
    idem.commit.mockRejectedValueOnce(new Error("idempotency_store_down"));
    const input = baseDisputeInput({ stripeEventId: "evt_commit_down" });

    await expect(openDispute(ctx.deps, input)).rejects.toMatchObject({
      code: "dependency_failed",
    });
    expect(idem.release).not.toHaveBeenCalled();
    expect(idem.fail).not.toHaveBeenCalled();
    const upsertsAfterFirst = ctx.mocks.disputes.upsertFromStripe.mock.calls.length;
    expect(upsertsAfterFirst).toBe(1);

    await expect(openDispute(ctx.deps, input)).rejects.toMatchObject({
      code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
    });
    expect(ctx.mocks.disputes.upsertFromStripe).toHaveBeenCalledTimes(upsertsAfterFirst);
    expect(ctx.mocks.notifications.create).not.toHaveBeenCalled();
  });

  it("a deterministic rejection still writes the failed marker", async () => {
    const ctx = makeDeps();
    ctx.mocks.disputes.upsertFromStripe.mockImplementationOnce(async () => {
      throw { code: "invalid_input", message: "invalid_input" };
    });
    const idem = ctx.mocks.idempotency.__mocks;

    await expect(openDispute(ctx.deps, baseDisputeInput())).rejects.toMatchObject({
      code: "invalid_input",
    });

    expect(idem.fail).toHaveBeenCalledTimes(1);
    expect(idem.release).not.toHaveBeenCalled();
  });
});

function ledgerEntries(ctx: ReturnType<typeof makeDeps>): PayeeLedgerEntryRecord[] {
  return [...ctx.ledgerEntriesById.values()];
}

function buildEvent(): EventRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "22222222-2222-4222-8222-222222222222",
    humanId: null,
    title: "Dispute Test Event",
  } as EventRecord;
}

function buildOrder(eventId: string, kind: "TICKETING" | "MEMBERSHIP" = "TICKETING"): OrderRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    eventId,
    kind,
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    disputeStatus: null,
    disputedAt: null,
    currency: "usd",
    items: [],
  } as OrderRecord;
}

function buildOrderSplits(orderId: string): SplitEntry[] {
  return [
    {
      id: "split_artist",
      orderId,
      orderSplitId: "split_artist",
      payeeId: "payee_artist",
      amountCents: 3_000,
    },
    {
      id: "split_venue",
      orderId,
      orderSplitId: "split_venue",
      payeeId: "payee_venue",
      amountCents: 2_000,
    },
  ];
}

const MEMBERSHIP_ORG_ID = "55555555-5555-4555-8555-555555555555";
const MEMBERSHIP_PAYEE_ID = "payee_owner";

// A realistic membership dispute fixture: eventless order, one payee split,
// and a payee row pointing at the owning org.
function makeMembershipDeps(
  overrides: {
    splits?: SplitEntry[];
    payeeSubjects?: Map<string, PayeeRecord>;
    priorRefunds?: Array<{ payeeId: string; amountCents: number }>;
  } = {},
) {
  const order = buildMembershipOrder();
  return makeDeps({
    order,
    priorRefunds: overrides.priorRefunds,
    splits: overrides.splits ?? [
      {
        id: "split_membership",
        orderId: order.id,
        orderSplitId: "split_membership",
        payeeId: MEMBERSHIP_PAYEE_ID,
        amountCents: 5_000,
      },
    ],
    payeeSubjects:
      overrides.payeeSubjects ??
      new Map([
        [
          MEMBERSHIP_PAYEE_ID,
          {
            id: MEMBERSHIP_PAYEE_ID,
            subjectType: "ORGANIZATION",
            subjectId: MEMBERSHIP_ORG_ID,
          } as PayeeRecord,
        ],
      ]),
  });
}

function buildMembershipOrder(): OrderRecord {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    eventId: null,
    kind: "MEMBERSHIP",
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    disputeStatus: null,
    disputedAt: null,
    currency: "usd",
    items: [],
  } as unknown as OrderRecord;
}

function buildOrgMembers(): OrgMemberRecord[] {
  return [
    {
      humanId: "owner-human",
      name: "Owner One",
      email: "owner@example.com",
      role: "OWNER",
      joinedAt: NOW,
    },
    {
      humanId: "admin-human",
      name: "Admin Two",
      email: "admin@example.com",
      role: "ADMIN",
      joinedAt: NOW,
    },
    {
      humanId: "finance-human",
      name: "Finance Three",
      email: "finance@example.com",
      role: "FINANCE",
      joinedAt: NOW,
    },
    {
      humanId: "viewer-human",
      name: "Viewer Four",
      email: "viewer@example.com",
      role: "VIEWER",
      joinedAt: NOW,
    },
  ];
}

function buildHumanIdentities(): Map<string, HumanWithIdentity> {
  return new Map([
    [
      "owner-human",
      buildHumanWithIdentity("owner-human", "owner@example.com", "Owner One"),
    ],
  ]);
}

function buildHumanWithIdentity(
  humanId: string,
  email: string,
  name: string,
): HumanWithIdentity {
  return {
    human: { id: humanId, name } as HumanWithIdentity["human"],
    identity: {
      authUserId: `auth-${humanId}`,
      email,
      emailVerified: true,
      phone: null,
      phoneVerified: false,
      username: null,
      displayUsername: null,
      image: null,
    },
  };
}
