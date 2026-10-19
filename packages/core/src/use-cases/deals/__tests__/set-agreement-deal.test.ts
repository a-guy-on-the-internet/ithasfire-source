import { describe, expect, it } from "vitest";

import { getAgreementDeal } from "../get-agreement-deal";
import { projectAgreementDeal } from "../project-agreement-deal";
import { setAgreementDeal } from "../set-agreement-deal";
import {
  ACT_HUMAN,
  AGREEMENT_ID,
  EVENT_ID,
  SOUND_ORG,
  SUPPORT_HUMAN,
  TERMS_ID,
  VENUE_ADMIN,
  VENUE_EDITOR,
  VENUE_ORG,
  VENUE_VIEWER,
  caught,
  clauseRecord,
  clock,
  makeRepos,
  standardStore,
} from "./deal-fakes";

const act = { kind: "human" as const, id: ACT_HUMAN };
const venue = { kind: "org" as const, id: VENUE_ORG };
const support = { kind: "human" as const, id: SUPPORT_HUMAN };
const sound = { kind: "org" as const, id: SOUND_ORG };

/** The 08-07 worked example as a preset write. */
const versusDeal = {
  source: "PRESET" as const,
  preset: { preset: "VERSUS" as const, act, guaranteeCents: 80_000, percent: 70 },
  remainder: venue,
  extraClauses: [{ payee: support, amountType: "PERCENT" as const, percent: 10, basis: "NET_POOL" as const }],
  deductions: [
    { kind: "RENTAL" as const, label: "Room rental", amountCents: 50_000, creditedPayee: venue, estimated: false },
    { kind: "EXPENSE" as const, label: "Sound", amountCents: 30_000, creditedPayee: sound, estimated: true },
    { kind: "EXPENSE" as const, label: "Marketing", amountCents: 15_000, creditedPayee: venue, estimated: true },
  ],
};

const write = (s: ReturnType<typeof standardStore>, actorHumanId: string, deal: unknown) =>
  setAgreementDeal({ repos: makeRepos(s), clock }, { actorHumanId, agreementId: AGREEMENT_ID, deal });

describe("setAgreementDeal — the existing agreement edit rules", () => {
  it("the venue's edit-level member writes it; the act, a viewer and an outsider are refused", async () => {
    const s = standardStore();
    expect(await caught(write(s, ACT_HUMAN, versusDeal))).toMatchObject({ code: "TERMS_EDITOR_ONLY" });
    expect(await caught(write(s, VENUE_VIEWER, versusDeal))).toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
    expect(await caught(write(s, SUPPORT_HUMAN, versusDeal))).toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
    await expect(write(s, VENUE_EDITOR, versusDeal)).resolves.toMatchObject({ payoutTermsId: TERMS_ID });
  });

  it("only a DRAFT, unfinalized agreement", async () => {
    const proposed = standardStore();
    proposed.agreements.set(AGREEMENT_ID, { ...proposed.agreements.get(AGREEMENT_ID)!, status: "PROPOSED" });
    expect(await caught(write(proposed, VENUE_ADMIN, versusDeal))).toMatchObject({ code: "AGREEMENT_NOT_DRAFT" });
    const finalized = standardStore();
    finalized.agreements.set(AGREEMENT_ID, { ...finalized.agreements.get(AGREEMENT_ID)!, eventId: EVENT_ID });
    expect(await caught(write(finalized, VENUE_ADMIN, versusDeal))).toMatchObject({ code: "AGREEMENT_FINALIZED" });
  });

  it("never writes onto a default terms row", async () => {
    const s = standardStore();
    s.terms.get(TERMS_ID)!.isDefault = true;
    expect(await caught(write(s, VENUE_ADMIN, versusDeal))).toMatchObject({ code: "AGREEMENT_NOT_EDITABLE" });
  });

  it("the remainder holder must be one of the two parties — it owes every shortfall", async () => {
    const s = standardStore();
    expect(await caught(write(s, VENUE_ADMIN, { ...versusDeal, remainder: support }))).toMatchObject({
      code: "invalid_input",
      message: "deal_remainder_not_a_party",
    });
  });
});

describe("setAgreementDeal — what is stored", () => {
  it("a versus preset: the act's clause, the support act's clause, the costs in order, and the venue's per-order rest", async () => {
    const s = standardStore();
    const out = await write(s, VENUE_ADMIN, versusDeal);
    const stored = s.terms.get(TERMS_ID)!.deal;
    expect(stored.remainderPayeeId).toBe(s.venuePayee);
    expect(out.remainderPerOrderPercent).toBe(100);
    const byPayee = (payeeId: string) => stored.clauses.filter((c) => c.payeeId === payeeId);
    expect(byPayee(s.actPayee)).toEqual([
      expect.objectContaining({ amountType: "FIXED_AND_PERCENT", amountCents: 80_000, percent: 70, basis: "NET_POOL", resolution: "GREATER_OF" }),
    ]);
    expect(byPayee(s.supportPayee)).toEqual([expect.objectContaining({ amountType: "PERCENT", percent: 10, basis: "NET_POOL" })]);
    // The venue is paid the whole order per order (nobody else is per-order);
    // the legacy 80% line's id is kept for it.
    expect(byPayee(s.venuePayee)).toEqual([
      expect.objectContaining({ id: "a0000000-0000-4000-8000-000000000002", amountType: "PERCENT", percent: 100, basis: "GROSS" }),
    ]);
    // The act's old 20% per-order line is gone: the deal replaced it.
    expect(stored.clauses.some((c) => c.id === "a0000000-0000-4000-8000-000000000001")).toBe(false);
    expect(stored.deductions.map((d) => [d.label, d.sortOrder, d.creditedPayeeId])).toEqual([
      ["Room rental", 0, s.venuePayee],
      ["Sound", 1, s.soundPayee],
      ["Marketing", 2, s.venuePayee],
    ]);
    expect(s.audit.map((a) => a.action)).toContain("booking_agreement.deal_set");
  });

  it("the 08-07 worked example projects to $2,135 / $305 / $1,560 on the stored deal", async () => {
    const s = standardStore();
    await write(s, VENUE_ADMIN, versusDeal);
    const out = await projectAgreementDeal(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID, tiers: [{ tickets: 200, unitBasisCents: 2_000 }] },
    );
    expect(out.projection.visibility).toBe("FULL");
    if (out.projection.visibility !== "FULL") return;
    const r = out.projection.result;
    const entitled = Object.fromEntries(r.payees.map((p) => [p.payeeId, p.entitlementCents]));
    expect(entitled[s.actPayee]).toBe(213_500);
    expect(entitled[s.supportPayee]).toBe(30_500);
    expect(entitled[s.venuePayee]).toBe(61_000 + 65_000);
    expect(entitled[s.soundPayee]).toBe(30_000);
    expect(r.conservation.distributedCents).toBe(400_000);
    // Per order the venue is paid the whole $4,000; the rest is settled directly.
    expect(r.payees.find((p) => p.payeeId === s.venuePayee)?.projectedPaidPerOrderCents).toBe(400_000);
  });

  it("keeps a confirmed third-party per-order line's confirmation when its percent is unchanged, resets it when it moves", async () => {
    const s = standardStore();
    const deal = s.terms.get(TERMS_ID)!.deal;
    const supportLine = clauseRecord({
      id: "a0000000-0000-4000-8000-000000000003",
      payeeId: s.supportPayee,
      percent: 10,
      requiresConfirmation: true,
      confirmationStatus: "CONFIRMED",
      confirmedAt: new Date("2026-09-01T00:00:00.000Z"),
      capPercent: 15,
      priority: 3,
    });
    deal.clauses = [
      clauseRecord({ id: "a0000000-0000-4000-8000-000000000002", payeeId: s.venuePayee, percent: 90 }),
      supportLine,
    ];
    const clauses = (percent: number) => ({
      source: "CLAUSES" as const,
      remainder: venue,
      deductions: [],
      clauses: [
        { payee: act, amountType: "FIXED" as const, amountCents: 50_000, basis: "GROSS" as const },
        { payee: support, amountType: "PERCENT" as const, percent, basis: "GROSS" as const },
      ],
    });
    await write(s, VENUE_ADMIN, clauses(10));
    const kept = s.terms.get(TERMS_ID)!.deal.clauses.find((c) => c.payeeId === s.supportPayee)!;
    expect(kept).toMatchObject({ id: supportLine.id, confirmationStatus: "CONFIRMED", capPercent: 15, priority: 3 });
    // The act is a party: its clause settled directly carries no confirmation.
    expect(s.terms.get(TERMS_ID)!.deal.clauses.find((c) => c.payeeId === s.actPayee)).toMatchObject({
      requiresConfirmation: false,
      confirmationStatus: null,
    });
    await write(s, VENUE_ADMIN, clauses(12));
    const moved = s.terms.get(TERMS_ID)!.deal.clauses.find((c) => c.payeeId === s.supportPayee)!;
    expect(moved).toMatchObject({ id: supportLine.id, percent: 12, confirmationStatus: "PENDING", confirmedAt: null });
    expect(s.terms.get(TERMS_ID)!.deal.clauses.find((c) => c.payeeId === s.venuePayee)?.percent).toBe(88);
  });

  it("keeps a deduction's id when it is sent back, so actuals typed against it stay attached", async () => {
    const s = standardStore();
    await write(s, VENUE_ADMIN, versusDeal);
    const sound = s.terms.get(TERMS_ID)!.deal.deductions.find((d) => d.label === "Sound")!;
    await write(s, VENUE_ADMIN, {
      source: "CLAUSES",
      remainder: venue,
      clauses: [{ payee: act, amountType: "FIXED", amountCents: 80_000, basis: "GROSS" }],
      deductions: [
        { id: sound.id, kind: "EXPENSE", label: "Sound (PA hire)", amountCents: 32_000, creditedPayee: { kind: "org", id: SOUND_ORG }, estimated: true },
      ],
    });
    expect(s.terms.get(TERMS_ID)!.deal.deductions).toEqual([
      expect.objectContaining({ id: sound.id, label: "Sound (PA hire)", amountCents: 32_000, sortOrder: 0 }),
    ]);
  });

  it.each([
    [
      "a typed per-order clause on the remainder holder (its line is derived)",
      [{ payee: venue, amountType: "PERCENT", percent: 50, basis: "GROSS" }],
      "deal_remainder_per_order_clause_is_derived",
    ],
    [
      "two per-order clauses for one payee (OrderSplit is one row per order and payee)",
      [
        { payee: act, amountType: "PERCENT", percent: 10, basis: "GROSS" },
        { payee: act, amountType: "PERCENT", percent: 5, basis: "GROSS" },
      ],
      "deal_duplicate_per_order_payee",
    ],
    [
      "a 0% per-order clause (the engine would still pay it rounding cents)",
      [{ payee: act, amountType: "PERCENT", percent: 0, basis: "GROSS" }],
      "deal_clause_zero_percent",
    ],
    [
      "claims over 100%",
      [
        { payee: act, amountType: "PERCENT", percent: 70, basis: "NET_POOL" },
        { payee: support, amountType: "PERCENT", percent: 31, basis: "GROSS" },
      ],
      "deal_percent_over_100",
    ],
    [
      "a FIXED clause with a percent (shape)",
      [{ payee: act, amountType: "FIXED", amountCents: 100, percent: 5, basis: "GROSS" }],
      "deal_clause_fixed_shape",
    ],
  ])("refuses %s, and writes nothing", async (_name, clauses, message) => {
    const s = standardStore();
    const before = structuredClone(s.terms.get(TERMS_ID)!.deal);
    expect(
      await caught(write(s, VENUE_ADMIN, { source: "CLAUSES", remainder: venue, deductions: [], clauses })),
    ).toMatchObject({ code: "invalid_input", message });
    expect(s.terms.get(TERMS_ID)!.deal).toEqual(before);
  });

  it("sanitizes free text before its length check", async () => {
    const s = standardStore();
    await write(s, VENUE_ADMIN, {
      source: "CLAUSES",
      remainder: venue,
      clauses: [{ payee: act, amountType: "FIXED", amountCents: 100, basis: "GROSS", displayLabel: "<b>Headline</b> fee" }],
      deductions: [{ kind: "EXPENSE", label: "<script>x</script>Sound", amountCents: 1, creditedPayee: venue, estimated: false }],
    });
    const stored = s.terms.get(TERMS_ID)!.deal;
    expect(stored.clauses.find((c) => c.amountType === "FIXED")?.displayLabel).toBe("Headline fee");
    expect(stored.deductions[0]?.label).not.toContain("<");
  });
});

describe("getAgreementDeal on legacy terms", () => {
  it("labels the derived remainder and the venue's per-order line, writing nothing", async () => {
    const s = standardStore();
    const out = await getAgreementDeal({ repos: makeRepos(s) }, { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID });
    expect(out.remainder).toEqual({ payeeId: s.venuePayee, source: "LEGACY_AGREEMENT_EDITOR" });
    expect(out.perOrderPercentTotal).toBe(100);
    expect(out.clauses.map((c) => [c.payeeId, c.role, c.stage1])).toEqual([
      [s.actPayee, "CLAUSE", "PAID_PER_ORDER"],
      [s.venuePayee, "REMAINDER_PER_ORDER", "PAID_PER_ORDER"],
    ]);
    expect(out.mayEdit).toBe(true);
    expect(s.terms.get(TERMS_ID)!.deal.remainderPayeeId).toBeNull();
  });
});

describe("setAgreementDeal — review round (B1, NIT)", () => {
  it("B1: the terms row lock is taken before the deal it replaces is read", async () => {
    const s = standardStore();
    const repos = makeRepos(s);
    const order: string[] = [];
    const tx = repos.tx;
    (repos as { tx: unknown }).tx = (fn: (t: never) => Promise<unknown>) =>
      tx(async (t) => {
        const deals = t.deals;
        return fn({
          ...t,
          deals: {
            ...deals,
            lockTerms: async (id: string) => (order.push("lockTerms"), deals.lockTerms(id)),
            getTermsDeal: async (id: string) => (order.push("getTermsDeal"), deals.getTermsDeal(id)),
          },
        } as never);
      });
    await setAgreementDeal({ repos, clock }, { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID, deal: versusDeal });
    expect(order[0]).toBe("lockTerms");
    expect(order).toContain("getTermsDeal");
    expect(s.locks).toEqual([TERMS_ID]);
  });

  it("NIT: refuses a payee with several stored per-order lines (ticket-type scoped) rather than keep one silently", async () => {
    const s = standardStore();
    const deal = s.terms.get(TERMS_ID)!.deal;
    deal.clauses = [
      clauseRecord({ payeeId: s.actPayee, percent: 10, ticketTypeId: "11111111-0000-4000-8000-000000000001" }),
      clauseRecord({ payeeId: s.actPayee, percent: 10, ticketTypeId: "11111111-0000-4000-8000-000000000002" }),
      clauseRecord({ payeeId: s.venuePayee, percent: 80 }),
    ];
    const before = structuredClone(deal);
    expect(await caught(write(s, VENUE_ADMIN, versusDeal))).toMatchObject({
      code: "invalid_input",
      message: "deal_payee_has_several_per_order_lines",
    });
    expect(s.terms.get(TERMS_ID)!.deal).toEqual(before);
  });
});
