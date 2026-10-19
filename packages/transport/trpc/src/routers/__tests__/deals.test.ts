import { describe, expect, it, vi } from "vitest";

import {
  ACT_HUMAN,
  AGREEMENT_ID,
  EVENT_ID,
  NOW,
  OUTSIDER,
  SHOW_ENDS,
  SHOW_STARTS,
  SUPPORT_HUMAN,
  TERMS_ID,
  VENUE_ADMIN,
  VENUE_ORG,
  addFinalizedEvent,
  clauseRecord,
  currentFingerprint,
  makeRepos,
  standardStore,
} from "@th/core/use-cases/deals/__tests__/deal-fakes";

import { dealsRouter } from "../deals";
import { createCaller } from "./test-helpers";

/**
 * Transport seam for the deal terms and settlement sheet procedures (P4b):
 * the actor is threaded, the M5 projection survives the procedures' output
 * schemas, domain codes map to client errors, and ctx.reportError reaches
 * the read's degraded branch. Behaviour is pinned in
 * packages/core/src/use-cases/deals/__tests__/.
 */

function night() {
  const s = standardStore();
  addFinalizedEvent(s);
  // A support act paid 10% per order alongside the legacy 20/80 lines.
  s.terms.get(TERMS_ID)!.deal.clauses = [
    clauseRecord({ payeeId: s.actPayee, percent: 20 }),
    clauseRecord({ payeeId: s.supportPayee, percent: 10 }),
    clauseRecord({ payeeId: s.venuePayee, percent: 70 }),
  ];
  s.ledger.set(EVENT_ID, {
    orders: [{ orderId: "o1", status: "SUCCEEDED", amountGrossCents: 105_000, feesPlatformCents: 5_000, credited: true }],
    refundCount: 0,
    perPayee: [
      { payeeId: s.actPayee, creditCents: 20_000, refundDebitCents: 0 },
      { payeeId: s.supportPayee, creditCents: 10_000, refundDebitCents: 0 },
      { payeeId: s.venuePayee, creditCents: 70_000, refundDebitCents: 0 },
    ],
    currencies: ["usd"],
  });
  return s;
}

const caller = (s: ReturnType<typeof night>, actorHumanId: string | null, extra: Record<string, unknown> = {}) =>
  createCaller(dealsRouter, {
    repos: makeRepos(s),
    actorHumanId,
    clock: { now: () => NOW },
    ...extra,
  } as never).caller;

describe("deals router", () => {
  it("returns the whole sheet to a party and one line to a non-party payee, through the output schema", async () => {
    const s = night();
    const full = await caller(s, VENUE_ADMIN).getEventSettlement({ eventId: EVENT_ID });
    expect(full.sheet.visibility).toBe("FULL");
    const own = await caller(s, SUPPORT_HUMAN).getEventSettlement({ eventId: EVENT_ID });
    expect(own.sheet.visibility).toBe("OWN_LINE");
    expect(own.sheet.positions.map((p: { payeeId: string }) => p.payeeId)).toEqual([s.supportPayee]);
    expect(JSON.stringify(own)).not.toContain(s.actPayee);
  });

  it("maps refusals to client errors: outsider FORBIDDEN, write after settled CONFLICT, no actor UNAUTHORIZED", async () => {
    const s = night();
    await expect(caller(s, OUTSIDER).getEventSettlement({ eventId: EVENT_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller(s, VENUE_ADMIN).markEventSettled({ eventId: EVENT_ID });
    await expect(
      caller(s, VENUE_ADMIN).upsertSheetOffPlatform({
        eventId: EVENT_ID,
        kind: "DOOR_CASH",
        label: "Door cash",
        amountCents: 100,
        heldByPayeeId: s.venuePayee,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller(s, null).getEventSettlement({ eventId: EVENT_ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("writes a deal and reads it back; the act may read, not write", async () => {
    const s = night();
    s.agreements.set(AGREEMENT_ID, { ...s.agreements.get(AGREEMENT_ID)!, eventId: null, status: "DRAFT" });
    const target = { kind: "BOOKING_AGREEMENT" as const, agreementId: AGREEMENT_ID };
    await caller(s, VENUE_ADMIN).setTermsDeal({
      target,
      expectedDealFingerprint: currentFingerprint(s, target),
      deal: {
        source: "PRESET",
        preset: { preset: "GUARANTEE", act: { kind: "human", id: ACT_HUMAN }, guaranteeCents: 50_000 },
        remainder: { kind: "org", id: VENUE_ORG },
      },
    });
    const deal = await caller(s, ACT_HUMAN).getAgreementDeal({ agreementId: AGREEMENT_ID });
    expect(deal.clauses.map((c: { amountType: string; stage1: string }) => [c.amountType, c.stage1])).toEqual(
      expect.arrayContaining([
        ["FIXED", "SETTLED_DIRECTLY"],
        ["PERCENT", "PAID_PER_ORDER"],
      ]),
    );
    await expect(
      caller(s, ACT_HUMAN).setTermsDeal({
        target,
        expectedDealFingerprint: currentFingerprint(s, target),
        deal: { source: "CLAUSES", clauses: [], deductions: [], remainder: { kind: "org", id: VENUE_ORG } },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a stale whole-deal save with CONFLICT (expectedDealFingerprint)", async () => {
    const s = night();
    s.agreements.set(AGREEMENT_ID, { ...s.agreements.get(AGREEMENT_ID)!, eventId: null, status: "DRAFT" });
    const target = { kind: "BOOKING_AGREEMENT" as const, agreementId: AGREEMENT_ID };
    const stale = currentFingerprint(s, target);
    const deal = {
      source: "PRESET" as const,
      preset: { preset: "GUARANTEE" as const, act: { kind: "human" as const, id: ACT_HUMAN }, guaranteeCents: 50_000 },
      remainder: { kind: "org" as const, id: VENUE_ORG },
    };
    await caller(s, VENUE_ADMIN).setTermsDeal({ target, expectedDealFingerprint: stale, deal });
    await expect(
      caller(s, VENUE_ADMIN).setTermsDeal({ target, expectedDealFingerprint: stale, deal }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("has no setAgreementDeal procedure (a booking's deal goes through setTermsDeal)", () => {
    expect("setAgreementDeal" in dealsRouter).toBe(false);
  });

  it("threads ctx.reportError into the read's and Mark settled's degraded branch", async () => {
    const s = night();
    await caller(s, VENUE_ADMIN).upsertSheetOffPlatform({
      eventId: EVENT_ID,
      kind: "BAR_SHARE",
      label: "Bar",
      amountCents: 100,
      heldByPayeeId: s.supportPayee,
    });
    // The support act leaves the deal; its row can no longer be placed.
    s.terms.get(TERMS_ID)!.deal.clauses = [
      clauseRecord({ payeeId: s.actPayee, percent: 20 }),
      clauseRecord({ payeeId: s.venuePayee, percent: 80 }),
    ];
    s.ledger.get(EVENT_ID)!.perPayee = [
      { payeeId: s.actPayee, creditCents: 20_000, refundDebitCents: 0 },
      { payeeId: s.venuePayee, creditCents: 80_000, refundDebitCents: 0 },
    ];
    const reportError = vi.fn();
    const out = await caller(s, VENUE_ADMIN, { reportError }).getEventSettlement({ eventId: EVENT_ID });
    expect(out.staleEntryIds.length).toBe(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    // B2: Mark settled freezes that degraded sheet — and reports it too.
    const settleReporter = vi.fn();
    await caller(s, VENUE_ADMIN, { reportError: settleReporter }).markEventSettled({
      eventId: EVENT_ID,
      acknowledgeIncomplete: true,
    });
    expect(settleReporter).toHaveBeenCalledWith(
      expect.objectContaining({ message: "settlement_sheet_stale_entries" }),
      expect.anything(),
    );
  });

  it("confirmDealClause requires the terms the payee saw, and a changed clause is a CONFLICT", async () => {
    const s = standardStore();
    const eventTerms = "e0000000-0000-4000-8000-000000000001";
    const eventId = "e0000000-0000-4000-8000-0000000000ee";
    const guarantee = clauseRecord({
      payoutTermsId: eventTerms,
      payeeId: s.actPayee,
      amountType: "FIXED",
      amountCents: 50_000,
      percent: null,
      requiresConfirmation: true,
      confirmationStatus: "PENDING",
    });
    s.terms.set(eventTerms, {
      isDefault: false,
      deal: { payoutTermsId: eventTerms, remainderPayeeId: null, clauses: [guarantee], deductions: [] },
    });
    s.events.set(eventId, {
      id: eventId,
      orgId: VENUE_ORG,
      humanId: null,
      startsAt: SHOW_STARTS,
      endsAt: SHOW_ENDS,
      payoutTermsId: eventTerms,
      currency: "usd",
      status: "PUBLISHED",
      publishedAt: SHOW_STARTS,
    });
    const target = { kind: "EVENT" as const, eventId };
    const shown = { amountType: "FIXED" as const, amountCents: 50_000, percent: null, basis: "GROSS" as const, resolution: null };

    // Required in the transport input.
    await expect(
      caller(s, ACT_HUMAN).confirmDealClause({ target, clauseId: guarantee.id } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller(s, ACT_HUMAN).declineDealClause({ target, clauseId: guarantee.id } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Shown $500, stored $50 → CONFLICT, nothing recorded.
    guarantee.amountCents = 5_000;
    await expect(
      caller(s, ACT_HUMAN).confirmDealClause({ target, clauseId: guarantee.id, answered: shown }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(guarantee.confirmationStatus).toBe("PENDING");

    // Shown what is stored → confirmed.
    await expect(
      caller(s, ACT_HUMAN).confirmDealClause({
        target,
        clauseId: guarantee.id,
        answered: { ...shown, amountCents: 5_000 },
      }),
    ).resolves.toMatchObject({ confirmationStatus: "CONFIRMED" });
  });
});
