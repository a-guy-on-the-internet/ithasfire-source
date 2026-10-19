import { describe, expect, it, vi } from "vitest";

import { DEAL_SETTLEMENT_ENGINE_VERSION } from "../../../lib/settlement";
import { getEventSettlement } from "../get-event-settlement";
import { markEventSettled, reopenEventSettlement } from "../mark-event-settled";
import { setAgreementDeal } from "../set-agreement-deal";
import {
  addSheetDirectPayment,
  clearSheetDeductionActual,
  removeSheetDirectPayment,
  removeSheetOffPlatform,
  setSheetDeductionActual,
  upsertSheetOffPlatform,
} from "../settlement-sheet-entries";
import {
  ACT_HUMAN,
  AGREEMENT_ID,
  EVENT_ID,
  OUTSIDER,
  SHOW_ENDS,
  SOUND_ORG,
  SUPPORT_HUMAN,
  VENUE_ADMIN,
  VENUE_EDITOR,
  VENUE_FINANCE,
  VENUE_ORG,
  VENUE_VIEWER,
  addFinalizedEvent,
  addPayee,
  caught,
  clock,
  makeRepos,
  standardStore,
} from "./deal-fakes";

const act = { kind: "human" as const, id: ACT_HUMAN };
const venue = { kind: "org" as const, id: VENUE_ORG };

/**
 * A booked versus night, after the show: $800 vs 70% of the pool to the act,
 * 10% per order to the support act, an estimated $300 of sound fronted by the
 * sound company, the venue keeps the rest. $2,000 of ticket money; the
 * platform paid the support act $200 and the venue $1,800 per order.
 */
async function night() {
  const s = standardStore();
  await setAgreementDeal(
    { repos: makeRepos(s), clock },
    {
      actorHumanId: VENUE_ADMIN,
      agreementId: AGREEMENT_ID,
      deal: {
        source: "PRESET",
        preset: { preset: "VERSUS", act, guaranteeCents: 80_000, percent: 70 },
        remainder: venue,
        extraClauses: [
          { payee: { kind: "human", id: SUPPORT_HUMAN }, amountType: "PERCENT", percent: 10, basis: "GROSS" },
        ],
        deductions: [
          { kind: "EXPENSE", label: "Sound", amountCents: 30_000, creditedPayee: { kind: "org", id: SOUND_ORG }, estimated: true },
          { kind: "RENTAL", label: "Room", amountCents: 10_000, creditedPayee: venue, estimated: false },
        ],
      },
    },
  );
  addFinalizedEvent(s);
  s.ledger.set(EVENT_ID, {
    orders: [
      { orderId: "o1", status: "SUCCEEDED", amountGrossCents: 105_000, feesPlatformCents: 5_000, credited: true },
      { orderId: "o2", status: "PART_REFUNDED", amountGrossCents: 105_000, feesPlatformCents: 5_000, credited: true },
      // Took money, never credited per order: outside the sheet, reported.
      { orderId: "o3", status: "SUCCEEDED", amountGrossCents: 3_000, feesPlatformCents: 100, credited: false },
      // Never took money: not even reported.
      { orderId: "o4", status: "CANCELLED", amountGrossCents: 3_000, feesPlatformCents: 100, credited: false },
    ],
    refundCount: 1,
    perPayee: [
      { payeeId: s.supportPayee, creditCents: 20_000, refundDebitCents: 0 },
      { payeeId: s.venuePayee, creditCents: 180_000, refundDebitCents: 0 },
    ],
    currencies: ["usd"],
  });
  return s;
}

const deps = (s: Awaited<ReturnType<typeof night>>) => ({ repos: makeRepos(s), clock });
const read = (s: Awaited<ReturnType<typeof night>>, actorHumanId = VENUE_ADMIN) =>
  getEventSettlement(deps(s), { actorHumanId, eventId: EVENT_ID });
const full = async (s: Awaited<ReturnType<typeof night>>) => {
  const out = await read(s);
  if (out.sheet.visibility !== "FULL") throw new Error("expected FULL");
  return { out, r: out.sheet.result };
};

describe("the event settlement read (ACTUAL mode)", () => {
  it("ticket money and 'paid through Ithas Fire' come from the ledger; the remainder holder has a position (W5)", async () => {
    const s = await night();
    const { out, r } = await full(s);
    expect(r.revenueMode).toBe("ACTUAL");
    expect(r.waterfall.grossCents).toBe(200_000);
    const paid = Object.fromEntries(r.payees.map((p) => [p.payeeId, p.paidThroughPlatformCents]));
    expect(paid).toMatchObject({ [s.supportPayee]: 20_000, [s.venuePayee]: 180_000, [s.actPayee]: 0, [s.soundPayee]: 0 });
    expect(out.ledger).toEqual({
      orderCount: 2,
      refundCount: 1,
      uncreditedOrderCount: 1,
      uncreditedBasisCents: 2_900,
      cashSales: { count: 0, amountCents: 0 },
      disputes: [],
    });
    expect(out.remainder).toEqual({ payeeId: s.venuePayee, source: "STORED" });
    // Pool = $2,000 − $200 paid first − $300 sound − $100 room = $1,400;
    // 70% = $980 beats $800. The venue owes the act $980 and the sound co $300.
    const bal = Object.fromEntries(r.payees.map((p) => [p.payeeId, p.settleDirectlyCents]));
    expect(bal).toMatchObject({ [s.actPayee]: 98_000, [s.soundPayee]: 30_000, [s.supportPayee]: 0, [s.venuePayee]: -128_000 });
    expect(r.completeness.estimatedDeductionIds.length).toBe(1);
  });

  it("each order's ticket money is summed under ITS OWN credit rule: FULL_PRICE in full, unmarked net of the fee", async () => {
    // Owner ruling 2026-10-11 (platform-fee-charged-once spec FR-005): a sale
    // marked `organiserCredit: "FULL_PRICE"` credited the organiser the full
    // ticket price; an order sold before the ruling has no marker and was
    // credited price minus the platform fee. A sheet that spans the change
    // must not re-derive either under the other's rule.
    const FULL_PRICE = { feeMode: "PASS_THROUGH", organiserCredit: "FULL_PRICE" };
    const s = await night();
    s.ledger.set(EVENT_ID, {
      orders: [
        // Unmarked: 105,000 − 5,000 = 100,000.
        { orderId: "o1", status: "SUCCEEDED", amountGrossCents: 105_000, feesPlatformCents: 5_000, credited: true },
        // Same amounts, marked: 105,000.
        { orderId: "o2", status: "SUCCEEDED", amountGrossCents: 105_000, feesPlatformCents: 5_000, feePolicySnapshot: FULL_PRICE, credited: true },
        // Uncredited, unmarked: 2,000 − 100 = 1,900.
        { orderId: "u1", status: "SUCCEEDED", amountGrossCents: 2_000, feesPlatformCents: 100, feePolicySnapshot: { feeMode: "PASS_THROUGH" }, credited: false },
        // Uncredited, marked: 3,000.
        { orderId: "u2", status: "SUCCEEDED", amountGrossCents: 3_000, feesPlatformCents: 100, feePolicySnapshot: FULL_PRICE, credited: false },
        // Gross below the fee. Unmarked: basis 0, so it is not a payout gap.
        { orderId: "u3", status: "SUCCEEDED", amountGrossCents: 30, feesPlatformCents: 50, credited: false },
        // The same order marked has a basis of 30 and IS reported.
        { orderId: "u4", status: "SUCCEEDED", amountGrossCents: 30, feesPlatformCents: 50, feePolicySnapshot: FULL_PRICE, credited: false },
      ],
      refundCount: 0,
      perPayee: [
        // 10% per order to the support act: 10,000 + 10,500. The rest to the venue.
        { payeeId: s.supportPayee, creditCents: 20_500, refundDebitCents: 0 },
        { payeeId: s.venuePayee, creditCents: 184_500, refundDebitCents: 0 },
      ],
      currencies: ["usd"],
    });

    const { out, r } = await full(s);
    expect(r.waterfall.grossCents).toBe(100_000 + 105_000);
    expect(out.ledger).toMatchObject({
      orderCount: 2,
      uncreditedOrderCount: 3,
      uncreditedBasisCents: 1_900 + 3_000 + 30,
    });
  });

  it("an all-FULL_PRICE night whose payees were credited the full gross reads as consistent, not over-paid", async () => {
    // Under the pre-ruling rule these two orders would sum to 200,000 and
    // the 210,000 the platform paid out would trip `ledger_inconsistent`.
    const FULL_PRICE = { organiserCredit: "FULL_PRICE" };
    const s = await night();
    const ledger = s.ledger.get(EVENT_ID)!;
    ledger.orders = ledger.orders.map((o) => ({ ...o, feePolicySnapshot: FULL_PRICE }));
    ledger.perPayee = [
      { payeeId: s.supportPayee, creditCents: 21_000, refundDebitCents: 0 },
      { payeeId: s.venuePayee, creditCents: 189_000, refundDebitCents: 0 },
    ];

    const { out, r } = await full(s);
    expect(r.waterfall.grossCents).toBe(210_000);
    expect(out.ledger.uncreditedBasisCents).toBe(3_000);
  });

  it("refunds come off the gross and the payee's figure alike", async () => {
    const s = await night();
    s.ledger.get(EVENT_ID)!.perPayee = [
      { payeeId: s.supportPayee, creditCents: 20_000, refundDebitCents: 5_000 },
      { payeeId: s.venuePayee, creditCents: 180_000, refundDebitCents: 45_000 },
    ];
    const { r } = await full(s);
    expect(r.waterfall.grossCents).toBe(150_000);
    expect(r.payees.find((p) => p.payeeId === s.supportPayee)?.settleDirectlyCents).toBe(0);
  });

  it("W1: a payee paid per order under a line the deal no longer has stays on the sheet — a labelled row that nets to $0", async () => {
    const s = await night();
    const former = addPayee(s, "HUMAN", OUTSIDER);
    // A split edited after tickets sold: an old line paid them $150 per order.
    s.ledger.get(EVENT_ID)!.perPayee[1]!.creditCents -= 15_000;
    s.ledger.get(EVENT_ID)!.perPayee.push({ payeeId: former, creditCents: 15_000, refundDebitCents: 0 });
    const { r } = await full(s);
    expect(r.ledgerOnly).toEqual([{ payeeId: former, paidCents: 15_000 }]);
    const position = r.payees.find((p) => p.payeeId === former)!;
    expect(position).toMatchObject({
      ledgerOnlyCents: 15_000,
      clauseIds: [],
      entitlementCents: 15_000,
      paidThroughPlatformCents: 15_000,
      settleDirectlyCents: 0,
    });
    // It came out per order before any cost, like a per-order line: the pool
    // is $150 smaller, the rest of the deal works from what was left.
    expect(r.waterfall.perOrderPaidFirstCents).toBe(20_000 + 15_000);
    expect(r.conservation.distributedCents).toBe(200_000);
    // A ledger-only payee is a participant of the SHEET: money that changed
    // hands with the removed act can be typed in, and stays placed.
    const { id: paymentId } = await addSheetDirectPayment(deps(s), {
      actorHumanId: VENUE_ADMIN,
      eventId: EVENT_ID,
      fromPayeeId: former,
      toPayeeId: s.venuePayee,
      amountCents: 2_500,
      label: "Handed back at the door",
    });
    const after = await full(s);
    expect(after.out.staleEntryIds).toEqual([]);
    expect(after.out.entries.directPayments.map((d) => d.id)).toEqual([paymentId]);
    expect(after.r.payees.find((p) => p.payeeId === former)?.settleDirectlyCents).toBe(2_500);
    // A payee whose credits were all refunded holds nothing and is left out.
    const zeroed = await night();
    const refunded = addPayee(zeroed, "HUMAN", OUTSIDER);
    zeroed.ledger.get(EVENT_ID)!.perPayee.push({ payeeId: refunded, creditCents: 500, refundDebitCents: 500 });
    zeroed.ledger.get(EVENT_ID)!.orders[0]!.amountGrossCents += 500;
    expect((await full(zeroed)).r.ledgerOnly).toEqual([]);
  });

  it("W3: cash sold at the door is shown as cash sales on record — not a payout gap, not in the gross", async () => {
    const s = await night();
    s.ledger.get(EVENT_ID)!.orders.push(
      { orderId: "c1", status: "SUCCEEDED", paymentChannel: "CASH", amountGrossCents: 2_500, feesPlatformCents: 0, credited: false },
      { orderId: "c2", status: "SUCCEEDED", paymentChannel: "CASH", amountGrossCents: 1_500, feesPlatformCents: 0, credited: false },
      // A refunded cash sale is not money on hand.
      { orderId: "c3", status: "REFUNDED", paymentChannel: "CASH", amountGrossCents: 9_999, feesPlatformCents: 0, credited: false },
      // A part-refunded one counts net of what was handed back.
      { orderId: "c4", status: "PART_REFUNDED", paymentChannel: "CASH", amountGrossCents: 3_000, refundedItemCents: 1_000, feesPlatformCents: 0, credited: false },
    );
    const { out, r } = await full(s);
    expect(out.ledger?.cashSales).toEqual({ count: 3, amountCents: 6_000 });
    expect(out.ledger?.uncreditedOrderCount).toBe(1); // o3 only — never a cash sale
    expect(r.waterfall.grossCents).toBe(200_000);
    // Shown, never typed in: the organiser enters (or confirms) the door cash.
    expect(r.offPlatform.rows).toEqual([]);
    expect(out.completeness?.reasons).toContain("CASH_SALES_NOT_ENTERED");
    await upsertSheetOffPlatform(deps(s), {
      actorHumanId: VENUE_ADMIN,
      eventId: EVENT_ID,
      kind: "DOOR_CASH",
      label: "Door cash",
      amountCents: 4_000,
      heldByPayeeId: s.venuePayee,
    });
    expect((await read(s)).completeness?.reasons).not.toContain("CASH_SALES_NOT_ENTERED");
  });

  it("W4: disputes are counted by outcome, with their amounts", async () => {
    const s = await night();
    s.ledger.get(EVENT_ID)!.disputes = [
      { orderId: "o1", status: "OPEN", amountCents: 1_000 },
      { orderId: "o1", status: "UNDER_REVIEW", amountCents: 500 },
      { orderId: "o2", status: "LOST", amountCents: 2_000 },
      { orderId: "o2", status: "WON", amountCents: 700 },
      { orderId: "o2", status: "WARNING_OPEN", amountCents: 50 },
    ];
    const { out } = await full(s);
    expect(out.ledger?.disputes).toEqual([
      { outcome: "OPEN", count: 2, amountCents: 1_500 },
      { outcome: "WON", count: 1, amountCents: 700 },
      { outcome: "LOST", count: 1, amountCents: 2_000 },
      { outcome: "WARNING", count: 1, amountCents: 50 },
    ]);
    // An undecided dispute keeps the sheet incomplete; decided ones don't.
    expect(out.completeness?.reasons).toContain("DISPUTES_OPEN");
    s.ledger.get(EVENT_ID)!.disputes = [{ orderId: "o2", status: "LOST", amountCents: 2_000 }];
    expect((await read(s)).completeness?.reasons).not.toContain("DISPUTES_OPEN");
  });

  it("W2: completeness counts what was left out, not only what the calculator saw", async () => {
    const s = await night();
    const out = await read(s);
    // Sound is an estimate; o3 took money with no credit.
    expect(out.completeness).toEqual({ complete: false, reasons: ["ESTIMATED_COSTS", "UNCREDITED_ORDERS"] });
  });

  it("a ledger that pays out more than the basis is an invariant failure (500), never a quiet sheet", async () => {
    const s = await night();
    s.ledger.get(EVENT_ID)!.perPayee[1]!.creditCents = 180_001;
    expect(await caught(read(s))).toMatchObject({ name: "DealSettlementInvariantError" });
  });
});

describe("typing into the sheet", () => {
  it("door cash: Not entered until a number is typed, and who typed it is recorded", async () => {
    const s = await night();
    const { id } = await upsertSheetOffPlatform(deps(s), {
      actorHumanId: VENUE_EDITOR,
      eventId: EVENT_ID,
      kind: "DOOR_CASH",
      label: "Door cash",
      amountCents: null,
      heldByPayeeId: s.venuePayee,
    });
    let view = await full(s);
    expect(view.r.offPlatform.rows).toEqual([expect.objectContaining({ id, entered: false })]);
    expect(view.r.offPlatform.rows[0]).not.toHaveProperty("amountCents");
    expect(view.r.completeness.notEnteredOffPlatformIds).toEqual([id]);

    await upsertSheetOffPlatform(deps(s), {
      actorHumanId: VENUE_FINANCE,
      eventId: EVENT_ID,
      rowId: id,
      kind: "DOOR_CASH",
      label: "Door cash",
      amountCents: 45_000,
      heldByPayeeId: s.venuePayee,
    });
    view = await full(s);
    expect(view.r.offPlatform.enteredCents).toBe(45_000);
    expect(view.out.entries.offPlatform).toEqual([
      expect.objectContaining({ id, amountCents: 45_000, enteredByHumanId: VENUE_FINANCE }),
    ]);
  });

  it("an actual replaces an estimate; an agreed cost takes none; a stranger can't be put on the sheet", async () => {
    const s = await night();
    const deduction = (label: string) => s.terms.get(s.events.get(EVENT_ID)!.payoutTermsId!)!.deal.deductions.find((d) => d.label === label)!;
    await setSheetDeductionActual(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, deductionId: deduction("Sound").id, amountCents: 27_500 });
    const { r } = await full(s);
    expect(r.waterfall.steps.find((x) => x.label === "Sound")).toMatchObject({ amountCents: 27_500, amountSource: "ACTUAL" });
    expect(
      await caught(setSheetDeductionActual(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, deductionId: deduction("Room").id, amountCents: 1 })),
    ).toMatchObject({ code: "invalid_input", message: "deal_deduction_not_estimated" });
    const stranger = addPayee(s, "HUMAN", OUTSIDER);
    expect(
      await caught(
        upsertSheetOffPlatform(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, kind: "BAR_SHARE", label: "Bar", amountCents: 1, heldByPayeeId: stranger }),
      ),
    ).toMatchObject({ code: "invalid_input", message: "deal_off_platform_unknown_holder" });
    expect(
      await caught(
        addSheetDirectPayment(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, fromPayeeId: s.venuePayee, toPayeeId: stranger, amountCents: 1, label: "x" }),
      ),
    ).toMatchObject({ code: "invalid_input", message: "deal_direct_payment_unknown_party" });
    await clearSheetDeductionActual(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, deductionId: deduction("Sound").id });
    expect((await full(s)).r.waterfall.steps.find((x) => x.label === "Sound")?.amountSource).toBe("ESTIMATE");
  });

  it("a deposit already paid moves two balances, never the split (M10)", async () => {
    const s = await night();
    const before = (await full(s)).r;
    const { id } = await addSheetDirectPayment(deps(s), {
      actorHumanId: VENUE_ADMIN,
      eventId: EVENT_ID,
      fromPayeeId: s.venuePayee,
      toPayeeId: s.actPayee,
      amountCents: 25_000,
      label: "Deposit already paid",
    });
    const after = (await full(s)).r;
    const bal = (r: typeof after, p: string) => r.payees.find((x) => x.payeeId === p)?.settleDirectlyCents;
    expect(bal(after, s.actPayee)).toBe((bal(before, s.actPayee) as number) - 25_000);
    expect(bal(after, s.venuePayee)).toBe((bal(before, s.venuePayee) as number) + 25_000);
    expect(after.clauses.map((c) => c.entitlementCents)).toEqual(before.clauses.map((c) => c.entitlementCents));
    await removeSheetDirectPayment(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, paymentId: id });
    expect((await full(s)).r.payees.find((x) => x.payeeId === s.actPayee)?.directReceivedCents).toBe(0);
  });

  it("only the organiser side writes: a venue VIEWER, the act, a payee and a stranger are refused", async () => {
    const s = await night();
    const row = { eventId: EVENT_ID, kind: "DOOR_CASH" as const, label: "Door", amountCents: 1, heldByPayeeId: s.venuePayee };
    for (const actor of [VENUE_VIEWER, ACT_HUMAN, SUPPORT_HUMAN, OUTSIDER]) {
      expect(await caught(upsertSheetOffPlatform(deps(s), { ...row, actorHumanId: actor })), actor).toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
    }
    expect(s.sheets.get(EVENT_ID)).toBeUndefined();
  });

  it("a human-owned event: the owner writes; an edit-role delegate does not touch the principal's money", async () => {
    const s = await night();
    s.events.set(EVENT_ID, { ...s.events.get(EVENT_ID)!, orgId: null, humanId: ACT_HUMAN });
    const row = { eventId: EVENT_ID, kind: "DOOR_CASH" as const, label: "Door", amountCents: 1, heldByPayeeId: s.venuePayee };
    await expect(upsertSheetOffPlatform(deps(s), { ...row, actorHumanId: ACT_HUMAN })).resolves.toBeTruthy();
    expect(await caught(upsertSheetOffPlatform(deps(s), { ...row, actorHumanId: VENUE_ADMIN }))).toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });
});

describe("Mark settled", () => {
  it("OWNER/ADMIN only, and only once the show is over", async () => {
    const s = await night();
    expect(await caught(markEventSettled(deps(s), { actorHumanId: VENUE_EDITOR, eventId: EVENT_ID }))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(await caught(markEventSettled(deps(s), { actorHumanId: VENUE_FINANCE, eventId: EVENT_ID }))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(await caught(markEventSettled(deps(s), { actorHumanId: ACT_HUMAN, eventId: EVENT_ID }))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    const early = await night();
    early.events.set(EVENT_ID, { ...early.events.get(EVENT_ID)!, endsAt: new Date(clock.now().getTime() + 60_000) });
    expect(await caught(markEventSettled(deps(early), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID }))).toMatchObject({
      code: "SETTLEMENT_EVENT_NOT_ENDED",
    });
    expect(SHOW_ENDS.getTime()).toBeLessThan(clock.now().getTime());
    await expect(markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true })).resolves.toMatchObject({
      status: "SETTLED",
      engineVersion: DEAL_SETTLEMENT_ENGINE_VERSION,
    });
  });

  it("freezes the sheet: later ledger entries and deal changes never rewrite it", async () => {
    const s = await night();
    await upsertSheetOffPlatform(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, kind: "DOOR_CASH", label: "Door cash", amountCents: 12_345, heldByPayeeId: s.venuePayee });
    const before = await full(s);
    await markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true });
    // A late refund lands in the ledger after the sheet was settled.
    s.ledger.get(EVENT_ID)!.perPayee[1]!.refundDebitCents = 50_000;
    const after = await full(s);
    expect(after.out.status).toBe("SETTLED");
    expect(after.out.frozen).toBe(true);
    expect(after.out.settled).toMatchObject({ byHumanId: VENUE_ADMIN, engineVersion: DEAL_SETTLEMENT_ENGINE_VERSION });
    expect(after.r).toEqual(before.r);
    expect(after.out.entries.offPlatform[0]).toMatchObject({ amountCents: 12_345, enteredByHumanId: VENUE_ADMIN });
    expect(after.out.entries.offPlatform[0]?.enteredAt).toBeInstanceOf(Date);
  });

  it("refuses every write once settled — and the refused write leaves nothing", async () => {
    const s = await night();
    await markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true });
    const snapshot = structuredClone(s.sheets.get(EVENT_ID));
    const deductionId = s.terms.get(s.events.get(EVENT_ID)!.payoutTermsId!)!.deal.deductions[0]!.id;
    const writes = [
      upsertSheetOffPlatform(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, kind: "DOOR_CASH", label: "Door", amountCents: 1, heldByPayeeId: s.venuePayee }),
      setSheetDeductionActual(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, deductionId, amountCents: 1 }),
      addSheetDirectPayment(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, fromPayeeId: s.venuePayee, toPayeeId: s.actPayee, amountCents: 1, label: "x" }),
      removeSheetOffPlatform(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, rowId: "00000000-0000-4000-8000-000000000000" }),
      markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true }),
    ];
    for (const w of writes) expect(await caught(w)).toMatchObject({ code: "SETTLEMENT_SHEET_SETTLED" });
    expect(s.sheets.get(EVENT_ID)).toEqual(snapshot);
  });

  it("reopen: OWNER/ADMIN with a reason; the frozen copy goes to the audit log; writes work again", async () => {
    const s = await night();
    expect(await caught(reopenEventSettlement(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, reason: "Typo in door cash" }))).toMatchObject({
      code: "SETTLEMENT_SHEET_NOT_SETTLED",
    });
    await markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true });
    expect(await caught(reopenEventSettlement(deps(s), { actorHumanId: VENUE_EDITOR, eventId: EVENT_ID, reason: "x" }))).toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    await reopenEventSettlement(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, reason: "Typo in door cash" });
    const audit = s.audit.find((a) => a.action === "settlement_sheet.reopened")!.data as { reason: string; previous: { snapshot: unknown } };
    expect(audit.reason).toBe("Typo in door cash");
    expect(audit.previous.snapshot).toBeTruthy();
    const out = await read(s);
    expect(out).toMatchObject({ status: "DRAFT", frozen: false, settled: null, reopened: { byHumanId: VENUE_ADMIN } });
    await expect(
      upsertSheetOffPlatform(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, kind: "DOOR_CASH", label: "Door", amountCents: 1, heldByPayeeId: s.venuePayee }),
    ).resolves.toBeTruthy();
  });
});

describe("Mark settled — review round (W2, B2, W5, NIT)", () => {
  it("W2: refuses an incomplete sheet unless the organiser acknowledges it; the acknowledgement is frozen and audited", async () => {
    const s = await night();
    expect(await caught(markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID }))).toMatchObject({
      code: "SETTLEMENT_SHEET_INCOMPLETE",
    });
    // Refused inside the transaction: nothing settled (nothing created, even).
    expect(s.sheets.get(EVENT_ID)?.status).not.toBe("SETTLED");
    await markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true });
    const ack = { byHumanId: VENUE_ADMIN, reasons: ["ESTIMATED_COSTS", "UNCREDITED_ORDERS"] };
    expect((s.sheets.get(EVENT_ID)!.snapshot as { acknowledgedIncomplete: unknown }).acknowledgedIncomplete).toEqual(ack);
    expect((s.audit.find((a) => a.action === "settlement_sheet.settled")!.data as { acknowledgedIncomplete: unknown }).acknowledgedIncomplete).toEqual(ack);
    const out = await read(s);
    expect(out.settled?.acknowledgedIncomplete).toEqual(ack);
    expect(out.completeness?.complete).toBe(false);
  });

  it("W2: a complete sheet settles without an acknowledgement, and records none", async () => {
    const s = await night();
    s.ledger.get(EVENT_ID)!.orders = s.ledger.get(EVENT_ID)!.orders.filter((o) => o.orderId !== "o3");
    const sound = s.terms.get(s.events.get(EVENT_ID)!.payoutTermsId!)!.deal.deductions.find((d) => d.label === "Sound")!;
    await setSheetDeductionActual(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, deductionId: sound.id, amountCents: 30_000 });
    await markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID });
    expect((await read(s)).settled?.acknowledgedIncomplete).toBeNull();
  });

  it("NIT: refuses an event that was never published", async () => {
    const s = await night();
    s.events.set(EVENT_ID, { ...s.events.get(EVENT_ID)!, status: "DRAFT", publishedAt: null });
    expect(
      await caught(markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true })),
    ).toMatchObject({ code: "SETTLEMENT_EVENT_NOT_PUBLISHED" });
  });

  /** A typed-in row the deal can no longer place: the support act leaves the deal. */
  async function nightWithStaleRow() {
    const s = await night();
    await upsertSheetOffPlatform(deps(s), {
      actorHumanId: VENUE_ADMIN,
      eventId: EVENT_ID,
      kind: "BAR_SHARE",
      label: "Bar",
      amountCents: 1_000,
      heldByPayeeId: s.supportPayee,
    });
    const deal = s.terms.get(s.events.get(EVENT_ID)!.payoutTermsId!)!.deal;
    deal.clauses = deal.clauses.filter((c) => c.payeeId !== s.supportPayee);
    deal.clauses.find((c) => c.payeeId === s.venuePayee)!.percent = 100;
    const ledger = s.ledger.get(EVENT_ID)!;
    ledger.perPayee = [{ payeeId: s.venuePayee, creditCents: 200_000, refundDebitCents: 0 }];
    return s;
  }

  it("B2: freezing a degraded sheet reports it — the frozen copy is the last place for it to go unseen", async () => {
    const s = await nightWithStaleRow();
    const reportError = vi.fn();
    await markEventSettled({ ...deps(s), reportError }, { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "settlement_sheet_stale_entries" }),
      expect.objectContaining({ extra: expect.objectContaining({ eventId: EVENT_ID }) }),
    );
    const frozen = s.sheets.get(EVENT_ID)!.snapshot as { staleEntryIds: string[] };
    expect(frozen.staleEntryIds.length).toBe(1);
  });

  it("B2: a reporter that throws never changes the settle", async () => {
    const s = await nightWithStaleRow();
    await markEventSettled(
      {
        ...deps(s),
        reportError: () => {
          throw new Error("sentry down");
        },
      },
      { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true },
    );
    expect(s.sheets.get(EVENT_ID)?.status).toBe("SETTLED");
  });

  it("W5: a sheet frozen by an OLDER engine still reads — held to the identities every version keeps", async () => {
    const s = await night();
    await markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true });
    const current = await full(s);
    const snapshot = s.sheets.get(EVENT_ID)!.snapshot as Record<string, unknown> & {
      result: Record<string, unknown> & { clauses: Array<Record<string, unknown>>; payees: Array<Record<string, unknown>> };
    };
    // Make it look like what v3 wrote: no cappedFromCents, no ledgerOnly,
    // no ledgerOnlyCents, no completeness / acknowledgement fields.
    const older = structuredClone(snapshot);
    older.engineVersion = 3;
    older.result.engineVersion = 3;
    delete older.result.ledgerOnly;
    for (const c of older.result.clauses) delete c.cappedFromCents;
    for (const p of older.result.payees) delete p.ledgerOnlyCents;
    delete older.completeness;
    delete older.acknowledgedIncomplete;
    s.sheets.get(EVENT_ID)!.snapshot = older;
    const out = await full(s);
    expect(out.out.frozen).toBe(true);
    expect(out.r.payees.map((p) => p.entitlementCents)).toEqual(current.r.payees.map((p) => p.entitlementCents));
    // …and a tampered older copy that no longer balances is refused, not rendered.
    const broken = structuredClone(older);
    (broken.result.payees[0] as { entitlementCents: number }).entitlementCents += 1;
    s.sheets.get(EVENT_ID)!.snapshot = broken;
    expect(await caught(read(s))).toMatchObject({ name: "DealSettlementInvariantError" });
  });

  it("W5: a sheet frozen at the CURRENT version gets the full invariant set", async () => {
    const s = await night();
    await markEventSettled(deps(s), { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true });
    const snapshot = s.sheets.get(EVENT_ID)!.snapshot as { result: { clauses: Array<{ cappedFromCents: unknown }> } };
    // A field only the full set checks: a cap that "raised" a clause.
    snapshot.result.clauses[0]!.cappedFromCents = -1;
    expect(await caught(read(s))).toMatchObject({ name: "DealSettlementInvariantError" });
  });
});
