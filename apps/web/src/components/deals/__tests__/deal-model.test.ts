import { describe, expect, it } from "vitest";

import {
  clauseAgreementOf,
  clauseInputsOf,
  clauseWordsOf,
  currentPresetOf,
  deductionInputsOf,
  hasNoMoneyTerms,
  needsTiersReasonOf,
  presetCandidates,
  presetDefaults,
  presetWrite,
  remainderRefOf,
  restPaidPerOrder,
  settleSummaryOf,
  showsSettledDirectlyNote,
  tiersFromDrafts,
  type DealPerson,
  type DealRead,
} from "../deal-model";

const PLACE_ORG = "11111111-1111-4111-8111-111111111111";
const ACT_ORG = "22222222-2222-4222-8222-222222222222";
const SUPPORT_HUMAN = "33333333-3333-4333-8333-333333333333";

/** The 08-07 worked example, shaped as `deals.getTermsDeal` returns it. */
function versusRead(overrides: Partial<DealRead> = {}): DealRead {
  return {
    target: { kind: "EVENT", eventId: "44444444-4444-4444-8444-444444444444" },
    agreementId: null,
    payoutTermsId: "55555555-5555-4555-8555-555555555555",
    visibility: "FULL",
    mayEdit: true,
    notEditableReason: null,
    remainder: { payeeId: "p-place", source: "STORED" },
    clauses: [
      {
        id: "c-act",
        payeeId: "p-act",
        amountType: "FIXED_AND_PERCENT",
        amountCents: 80_000,
        percent: 70,
        basis: "NET_POOL",
        resolution: "GREATER_OF",
        displayLabel: null,
        stage1: "SETTLED_DIRECTLY",
        role: "CLAUSE",
        requiresConfirmation: true,
        confirmationStatus: "PENDING",
      },
      {
        id: "c-support",
        payeeId: "p-support",
        amountType: "PERCENT",
        amountCents: null,
        percent: 10,
        basis: "NET_POOL",
        resolution: null,
        displayLabel: null,
        stage1: "SETTLED_DIRECTLY",
        role: "CLAUSE",
        requiresConfirmation: true,
        confirmationStatus: "CONFIRMED",
      },
      {
        id: "c-rest",
        payeeId: "p-place",
        amountType: "PERCENT",
        amountCents: null,
        percent: 100,
        basis: "GROSS",
        resolution: null,
        displayLabel: null,
        stage1: "PAID_PER_ORDER",
        role: "REMAINDER_PER_ORDER",
        requiresConfirmation: false,
        confirmationStatus: null,
      },
    ],
    deductions: [
      {
        id: "d-rent",
        kind: "RENTAL",
        label: "Room rental",
        amountCents: 50_000,
        percent: null,
        creditedPayeeId: "p-place",
        estimated: false,
      },
      {
        id: "d-mkt",
        kind: "EXPENSE",
        label: "Marketing",
        amountCents: 15_000,
        percent: null,
        creditedPayeeId: "p-place",
        estimated: true,
      },
    ],
    perOrderPercentTotal: 100,
    payees: [
      {
        payeeId: "p-place",
        subjectType: "organization",
        subjectId: PLACE_ORG,
        displayName: "Marrow Hall",
      },
      {
        payeeId: "p-act",
        subjectType: "organization",
        subjectId: ACT_ORG,
        displayName: "Lowlight Collective",
      },
      {
        payeeId: "p-support",
        subjectType: "human",
        subjectId: SUPPORT_HUMAN,
        displayName: "Paper Moth",
      },
    ],
    ...overrides,
  } as DealRead;
}

const place: DealPerson = {
  ref: { kind: "org", id: PLACE_ORG },
  name: "Marrow Hall",
  source: "party",
};

describe("read → write", () => {
  it("drops the remainder holder's derived per-order line (the server refuses it typed)", () => {
    const clauses = clauseInputsOf(versusRead());
    expect(clauses.map((c) => c.id)).toEqual(["c-act", "c-support"]);
  });

  it("names payees by the entity they pay, never by payee id", () => {
    const [act, support] = clauseInputsOf(versusRead());
    expect(act!.payee).toEqual({ kind: "org", id: ACT_ORG });
    expect(support!.payee).toEqual({ kind: "human", id: SUPPORT_HUMAN });
  });

  it("carries a versus clause's numbers unchanged and nulls what its shape doesn't use", () => {
    const [act, support] = clauseInputsOf(versusRead());
    expect(act).toMatchObject({
      amountCents: 80_000,
      percent: 70,
      resolution: "GREATER_OF",
    });
    expect(support).toMatchObject({
      amountCents: null,
      percent: 10,
      resolution: null,
    });
  });

  it("keeps costs in waterfall order with who fronted them", () => {
    const costs = deductionInputsOf(versusRead());
    expect(costs.map((d) => d.id)).toEqual(["d-rent", "d-mkt"]);
    expect(costs[1]).toMatchObject({
      creditedPayee: { kind: "org", id: PLACE_ORG },
      estimated: true,
    });
  });

  it("takes the stored remainder, else the first party", () => {
    expect(remainderRefOf(versusRead(), [])).toEqual({
      kind: "org",
      id: PLACE_ORG,
    });
    expect(remainderRefOf(null, [place])).toEqual(place.ref);
    expect(remainderRefOf(null, [])).toBeNull();
  });
});

describe("presets", () => {
  it("recognises the deal's current shape from the act's clause", () => {
    expect(currentPresetOf(versusRead())).toBe("VERSUS");
    expect(currentPresetOf(null)).toBeNull();
  });

  it("reads a deal with only a rental cost as a room rental", () => {
    const read = versusRead({ clauses: [] });
    expect(currentPresetOf(read)).toBe("ROOM_RENTAL");
  });

  it("prefills the preset form from the deal as it stands", () => {
    const d = presetDefaults("VERSUS", versusRead(), [place], []);
    expect(d).toMatchObject({
      payee: { kind: "org", id: ACT_ORG },
      remainder: { kind: "org", id: PLACE_ORG },
      guaranteeCents: 80_000,
      percent: 70,
      basis: "NET_POOL",
      rentalCents: 50_000,
    });
  });

  it("offers the other party as the act when the deal holds only the rest holder and the bill is empty", () => {
    const act: DealPerson = {
      ref: { kind: "org", id: ACT_ORG },
      name: "Nyx Quartet",
      source: "party",
    };
    const onlyRest = versusRead({
      clauses: [],
      deductions: [],
      payees: [
        {
          payeeId: "p-place",
          subjectType: "organization",
          subjectId: PLACE_ORG,
          displayName: "Marrow Hall",
        },
      ],
    });
    const d = presetDefaults(
      "VERSUS",
      onlyRest,
      [place, act],
      presetCandidates([place], [], [place, act]),
    );
    expect(d.remainder).toEqual({ kind: "org", id: PLACE_ORG });
    expect(d.payee).toEqual({ kind: "org", id: ACT_ORG });
  });

  it("starts a guaranteed preset from the header's guarantee while the deal has no act clause", () => {
    for (const preset of [
      "GUARANTEE",
      "GUARANTEE_PLUS_PERCENT",
      "VERSUS",
    ] as const) {
      expect(
        presetDefaults(preset, null, [place], [], 50_000).guaranteeCents,
      ).toBe(50_000);
    }
    // A preset with no fixed part has nothing to fill.
    expect(
      presetDefaults("DOOR_SPLIT", null, [place], [], 50_000).guaranteeCents,
    ).toBeUndefined();
    // The deal's own clause wins once there is one.
    expect(
      presetDefaults("VERSUS", versusRead(), [place], [], 50_000)
        .guaranteeCents,
    ).toBe(80_000);
  });

  it("keeps other payees' clauses and the costs when a preset replaces the act's clause", () => {
    const deal = presetWrite(
      {
        preset: "GUARANTEE",
        payee: { kind: "org", id: ACT_ORG },
        remainder: { kind: "org", id: PLACE_ORG },
        guaranteeCents: 90_000,
      },
      versusRead(),
    );
    expect(deal).toMatchObject({
      source: "PRESET",
      preset: {
        preset: "GUARANTEE",
        act: { kind: "org", id: ACT_ORG },
        guaranteeCents: 90_000,
      },
      remainder: { kind: "org", id: PLACE_ORG },
    });
    if (deal.source !== "PRESET") throw new Error("expected a preset write");
    expect(deal.extraClauses?.map((c) => c.id)).toEqual(["c-support"]);
    expect(deal.deductions?.map((d) => d.id)).toEqual(["d-rent", "d-mkt"]);
  });

  it("drops an earlier rental cost when Room rental brings its own", () => {
    const deal = presetWrite(
      {
        preset: "ROOM_RENTAL",
        payee: { kind: "org", id: ACT_ORG },
        remainder: { kind: "org", id: PLACE_ORG },
        rentalCents: 60_000,
        rentalMode: "RECOUPED_FROM_DOOR",
      },
      versusRead(),
    );
    if (deal.source !== "PRESET") throw new Error("expected a preset write");
    expect(deal.preset).toMatchObject({
      preset: "ROOM_RENTAL",
      rentalCents: 60_000,
      renter: { kind: "org", id: PLACE_ORG },
    });
    expect(deal.deductions?.map((d) => d.id)).toEqual(["d-mkt"]);
    expect("remainder" in deal && deal.remainder).toBeFalsy();
  });

  it("writes the versus default basis (the pool) when none is chosen", () => {
    const deal = presetWrite(
      {
        preset: "VERSUS",
        payee: { kind: "org", id: ACT_ORG },
        remainder: { kind: "org", id: PLACE_ORG },
        guaranteeCents: 80_000,
        percent: 70,
      },
      null,
    );
    if (deal.source !== "PRESET") throw new Error("expected a preset write");
    expect(deal.preset).toMatchObject({ basis: "NET_POOL" });
    expect(deal.extraClauses).toEqual([]);
  });
});

describe("plain words (NFR-003: a percent always says what it is of)", () => {
  it("says pool or ticket money for every percent", () => {
    expect(
      clauseWordsOf({
        amountType: "PERCENT",
        amountCents: null,
        percent: 10,
        basis: "NET_POOL",
        resolution: null,
      }).mainKey,
    ).toBe("deals.clausePercentPool");
    expect(
      clauseWordsOf({
        amountType: "PERCENT",
        amountCents: null,
        percent: 10,
        basis: "GROSS",
        resolution: null,
      }).mainKey,
    ).toBe("deals.clausePercentTickets");
  });

  it("splits a versus into the bold part and 'whichever is greater'", () => {
    const w = clauseWordsOf({
      amountType: "FIXED_AND_PERCENT",
      amountCents: 80_000,
      percent: 70,
      basis: "NET_POOL",
      resolution: "GREATER_OF",
    });
    expect(w).toEqual({
      mainKey: "deals.clauseVersusPool",
      tailKey: "deals.clauseVersusTail",
      amountCents: 80_000,
      percent: 70,
    });
  });

  it("calls a guarantee plus a percentage 'plus', with no tail", () => {
    const w = clauseWordsOf({
      amountType: "FIXED_AND_PERCENT",
      amountCents: 40_000,
      percent: 10,
      basis: "GROSS",
      resolution: "SUM",
    });
    expect(w.mainKey).toBe("deals.clausePlusTickets");
    expect(w.tailKey).toBeNull();
  });
});

describe("where a payee stands", () => {
  it("a party's clause comes with the terms", () => {
    expect(
      clauseAgreementOf({
        requiresConfirmation: false,
        confirmationStatus: null,
      }),
    ).toEqual({ kind: "WITH_THE_TERMS" });
  });
  it("a third party waits until they agree, and a stored PENDING reads as waiting", () => {
    expect(
      clauseAgreementOf({
        requiresConfirmation: true,
        confirmationStatus: "PENDING",
      }),
    ).toEqual({ kind: "WAITING" });
    expect(
      clauseAgreementOf({
        requiresConfirmation: true,
        confirmationStatus: null,
      }),
    ).toEqual({ kind: "WAITING" });
    expect(
      clauseAgreementOf({
        requiresConfirmation: true,
        confirmationStatus: "CONFIRMED",
      }),
    ).toEqual({ kind: "AGREED" });
    expect(
      clauseAgreementOf({
        requiresConfirmation: true,
        confirmationStatus: "DECLINED",
      }),
    ).toEqual({ kind: "DECLINED" });
  });
});

describe("calculator inputs", () => {
  const parse = (raw: string) =>
    /^\d+$/.test(raw.trim()) ? Number(raw.trim()) * 100 : null;

  it("turns typed rows into tiers", () => {
    expect(tiersFromDrafts([{ tickets: "200", price: "20" }], parse)).toEqual([
      { tickets: 200, unitBasisCents: 2_000 },
    ]);
  });

  it("asks nothing while a row is blank or unreadable (never guesses a zero)", () => {
    expect(tiersFromDrafts([{ tickets: "", price: "20" }], parse)).toBeNull();
    expect(tiersFromDrafts([{ tickets: "2x", price: "20" }], parse)).toBeNull();
    expect(tiersFromDrafts([{ tickets: "200", price: "" }], parse)).toBeNull();
    expect(tiersFromDrafts([], parse)).toBeNull();
  });
});

describe("who pays whom", () => {
  it("names the one payer and everyone they pay (the 08-07 example)", () => {
    expect(
      settleSummaryOf([
        { payeeId: "act", cents: 213_500 },
        { payeeId: "support", cents: 30_500 },
        { payeeId: "place", cents: -244_000 },
      ]),
    ).toEqual({
      kind: "ONE_PAYER",
      payerId: "place",
      payees: [
        { payeeId: "act", cents: 213_500 },
        { payeeId: "support", cents: 30_500 },
      ],
    });
  });

  it("does not pair several payers with several payees", () => {
    const s = settleSummaryOf([
      { payeeId: "a", cents: 100 },
      { payeeId: "b", cents: -50 },
      { payeeId: "c", cents: -50 },
    ]);
    expect(s.kind).toBe("EACH");
  });

  it("says nothing is owed when every balance is zero", () => {
    expect(settleSummaryOf([{ payeeId: "a", cents: 0 }])).toEqual({
      kind: "NONE",
    });
  });
});

describe("the 'Settled directly' note (A3)", () => {
  const perOrder = (read: DealRead): DealRead => ({
    ...read,
    clauses: read.clauses.map((c) => ({
      ...c,
      stage1: "PAID_PER_ORDER" as const,
    })),
  });

  it("shows when a clause on screen is settled directly", () => {
    expect(showsSettledDirectlyNote(versusRead(), true)).toBe(true);
  });

  it("does not show for costs alone when every line is paid as tickets sell", () => {
    // The A2 bug: costs off the top made the note show while the calculator
    // said "Nothing to settle directly".
    const read = perOrder(versusRead());
    expect(read.deductions.length).toBeGreaterThan(0);
    expect(showsSettledDirectlyNote(read, true)).toBe(false);
  });

  it("shows when the rest is shown and has no paid-per-order line", () => {
    const read = perOrder(versusRead());
    const noRestLine: DealRead = {
      ...read,
      clauses: read.clauses.filter((c) => c.role !== "REMAINDER_PER_ORDER"),
    };
    expect(restPaidPerOrder(noRestLine)).toBe(false);
    expect(showsSettledDirectlyNote(noRestLine, true)).toBe(true);
    // A payee seeing only their own line sees no rest row, so no note for it.
    expect(showsSettledDirectlyNote(noRestLine, false)).toBe(false);
  });

  it("reads the rest as paid per order from the server's classification", () => {
    expect(restPaidPerOrder(versusRead())).toBe(true);
    const settled: DealRead = {
      ...versusRead(),
      clauses: versusRead().clauses.map((c) =>
        c.role === "REMAINDER_PER_ORDER"
          ? { ...c, stage1: "SETTLED_DIRECTLY" as const }
          : c,
      ),
    };
    expect(restPaidPerOrder(settled)).toBe(false);
  });
});

describe("no money terms (A3)", () => {
  it("is a deal with no clause and no cost, whatever the rest", () => {
    const bare: DealRead = {
      ...versusRead(),
      clauses: versusRead().clauses.filter(
        (c) => c.role === "REMAINDER_PER_ORDER",
      ),
      deductions: [],
    };
    expect(hasNoMoneyTerms(bare)).toBe(true);
    expect(hasNoMoneyTerms(versusRead())).toBe(false);
    expect(
      hasNoMoneyTerms({ ...bare, deductions: versusRead().deductions }),
    ).toBe(false);
  });
});

describe("needsTiersReasonOf", () => {
  it("names why the calculator needs typed numbers, and nothing when it ran", () => {
    expect(needsTiersReasonOf(undefined)).toBeNull();
    expect(
      needsTiersReasonOf({
        needsTiers: true,
        reason: "NO_TICKET_TYPES",
        tiers: [],
        tiersSource: "EVENT_TICKET_TYPES",
        payees: [],
        target: { kind: "BOOKING_AGREEMENT", agreementId: PLACE_ORG },
      }),
    ).toBe("NO_TICKET_TYPES");
    expect(
      needsTiersReasonOf({
        needsTiers: true,
        reason: "NO_EVENT",
        tiers: [],
        tiersSource: "EVENT_TICKET_TYPES",
        payees: [],
        target: { kind: "BOOKING_AGREEMENT", agreementId: PLACE_ORG },
      }),
    ).toBe("NO_EVENT");
    expect(
      needsTiersReasonOf({ needsTiers: false } as Parameters<
        typeof needsTiersReasonOf
      >[0]),
    ).toBeNull();
  });
});
