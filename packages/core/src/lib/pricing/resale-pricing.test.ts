import { describe, expect, it } from "vitest";

import {
  checkResaleAskWithinCap,
  computeResaleSchedule,
  computeResaleShare,
  highestAskWithinCapCents,
  RESALE_SHARE_MAX_ASK_CENTS,
  resaleShareClauseSchema,
  type ResaleShareClause,
} from "./resale-pricing";
import { effectiveResaleCapCents } from "./effective-resale-cap";

const EVENT = {
  startsAt: new Date("2026-06-01T19:00:00Z"),
  endsAt: new Date("2026-06-01T23:00:00Z"),
  resalePayoutReleaseDaysOverride: null,
};

const PAYOUT_TERMS = { resalePayoutReleaseDays: 7 };

describe("computeResaleSchedule", () => {
  it("uses the event payout-release override when present and the terms default otherwise", () => {
    const byDefault = computeResaleSchedule({
      event: EVENT,
      payoutTerms: PAYOUT_TERMS,
    });
    const overridden = computeResaleSchedule({
      event: { ...EVENT, resalePayoutReleaseDaysOverride: 3 },
      payoutTerms: PAYOUT_TERMS,
    });

    expect(byDefault.saleCutoffAt.toISOString()).toBe(
      EVENT.startsAt.toISOString(),
    );
    expect(byDefault.payoutReleaseAt.toISOString()).toBe(
      "2026-06-08T23:00:00.000Z",
    );
    expect(overridden.payoutReleaseAt.toISOString()).toBe(
      "2026-06-04T23:00:00.000Z",
    );
  });

  it.each([
    { label: "terms 0 days", termsDays: 0, override: null },
    { label: "terms 1 day", termsDays: 1, override: null },
    { label: "event override 2 days", termsDays: 7, override: 2 },
  ])(
    "never releases before the claim window closes (endsAt + 3d) — $label",
    ({ termsDays, override }) => {
      const schedule = computeResaleSchedule({
        event: { ...EVENT, resalePayoutReleaseDaysOverride: override },
        payoutTerms: { resalePayoutReleaseDays: termsDays },
      });

      // EVENT.endsAt 2026-06-01T23:00Z + RESALE_CLAIM_WINDOW_DAYS (3).
      expect(schedule.payoutReleaseAt.toISOString()).toBe(
        "2026-06-04T23:00:00.000Z",
      );
    },
  );
});

// ── Organiser resale share (organiser-resale-share spec, FR-002 / FR-005) ──

const pct = (bps: number, payer: "SELLER" | "BUYER" = "SELLER") =>
  ({ type: "PERCENT", bps, payer }) as const;
const flat = (cents: number, payer: "SELLER" | "BUYER" = "SELLER") =>
  ({ type: "FLAT", cents, payer }) as const;

function expectCode(fn: () => unknown, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toMatchObject({ code });
}

describe("computeResaleShare: spec acceptance", () => {
  it("$40 original, 10% SELLER, resold at $50: share $5, seller $45, basis $50", () => {
    expect(computeResaleShare({ askCents: 5000, clause: pct(1000) })).toEqual({
      askCents: 5000,
      shareCents: 500,
      shareHeld: false,
      heldFromCents: null,
      sellerReceivesCents: 4500,
      basisCents: 5000,
      payer: "SELLER",
    });
  });

  it("the same ticket resold at $70 keeps its recorded 10% clause: $7", () => {
    // The organiser's later change to 5% is not an input: pricing reads the
    // clause the ticket recorded at its first sale (FR-003).
    const share = computeResaleShare({ askCents: 7000, clause: pct(1000) });
    expect(share.shareCents).toBe(700);
    expect(share.sellerReceivesCents).toBe(6300);
    expect(share.basisCents).toBe(7000);
  });

  it("FLAT $8 on a $50 ask is held to $5 and says so", () => {
    expect(computeResaleShare({ askCents: 5000, clause: flat(800) })).toEqual({
      askCents: 5000,
      shareCents: 500,
      shareHeld: true,
      heldFromCents: 800,
      sellerReceivesCents: 4500,
      basisCents: 5000,
      payer: "SELLER",
    });
  });

  it("BUYER clause on a ticket capped at $40: a $40 ask ($4 share) is refused", () => {
    const capCents = effectiveResaleCapCents({
      ticketTypeResaleCapCents: 4000,
      ticketUnitPriceCents: 4000,
    });
    const result = checkResaleAskWithinCap({
      askCents: 4000,
      clause: pct(1000, "BUYER"),
      capCents,
    });
    expect(result).toEqual({
      ok: false,
      basisCents: 4400,
      capCents: 4000,
      // Exact search, not the spec's rounded "$36": 3637 + floor(363.7) = 4000.
      highestFittingAskCents: 3637,
    });
  });

  it("the offered $36.37 fits to the cent and $36.38 does not", () => {
    const clause = pct(1000, "BUYER");
    expect(
      checkResaleAskWithinCap({ askCents: 3637, clause, capCents: 4000 }),
    ).toEqual({ ok: true, basisCents: 4000 });
    expect(
      checkResaleAskWithinCap({ askCents: 3638, clause, capCents: 4000 }),
    ).toMatchObject({ ok: false, basisCents: 4001 });
    // The spec's $36 also fits, it is just not the highest.
    expect(
      checkResaleAskWithinCap({ askCents: 3600, clause, capCents: 4000 }).ok,
    ).toBe(true);
  });
});

describe("computeResaleShare: rules", () => {
  it("BUYER payer: buyer pays ask + share, seller receives the whole ask", () => {
    expect(
      computeResaleShare({ askCents: 5000, clause: pct(1000, "BUYER") }),
    ).toMatchObject({
      shareCents: 500,
      sellerReceivesCents: 5000,
      basisCents: 5500,
      payer: "BUYER",
    });
  });

  it("FLAT under the limit is paid in full, by either payer", () => {
    expect(
      computeResaleShare({ askCents: 5000, clause: flat(300) }),
    ).toMatchObject({
      shareCents: 300,
      shareHeld: false,
      heldFromCents: null,
      sellerReceivesCents: 4700,
      basisCents: 5000,
    });
    expect(
      computeResaleShare({ askCents: 5000, clause: flat(300, "BUYER") }),
    ).toMatchObject({
      shareCents: 300,
      sellerReceivesCents: 5000,
      basisCents: 5300,
    });
  });

  it("FLAT exactly at the limit is not held", () => {
    expect(
      computeResaleShare({ askCents: 5000, clause: flat(500) }),
    ).toMatchObject({ shareCents: 500, shareHeld: false, heldFromCents: null });
  });

  it("FLAT one cent over the limit is held", () => {
    expect(
      computeResaleShare({ askCents: 5000, clause: flat(501) }),
    ).toMatchObject({ shareCents: 500, shareHeld: true, heldFromCents: 501 });
  });

  it("FLAT 1 cent", () => {
    expect(computeResaleShare({ askCents: 10, clause: flat(1) })).toMatchObject(
      { shareCents: 1, shareHeld: false, sellerReceivesCents: 9 },
    );
    expect(computeResaleShare({ askCents: 9, clause: flat(1) })).toMatchObject({
      shareCents: 0,
      shareHeld: true,
      heldFromCents: 1,
      sellerReceivesCents: 9,
    });
  });

  it("PERCENT 0 takes nothing", () => {
    expect(
      computeResaleShare({ askCents: 5000, clause: pct(0, "BUYER") }),
    ).toMatchObject({
      shareCents: 0,
      sellerReceivesCents: 5000,
      basisCents: 5000,
    });
  });

  it("PERCENT 1000 is exactly the limit", () => {
    expect(
      computeResaleShare({ askCents: 3333, clause: pct(1000) }),
    ).toMatchObject({
      shareCents: 333,
      sellerReceivesCents: 3000,
      basisCents: 3333,
    });
  });

  it.each([
    // [ask, clause, share]
    [0, pct(1000), 0],
    [0, flat(800), 0],
    [1, pct(1000), 0],
    [1, flat(1), 0],
    [9, pct(1000), 0],
    [9, flat(800), 0],
    [10, pct(1000), 1],
    [3333, pct(250), 83], // 83.325 floors
    [3333, flat(800), 333],
    [3333, pct(999), 332], // 332.9667 floors
    [RESALE_SHARE_MAX_ASK_CENTS, pct(1000), 214_748_364],
  ] as const)("ask %i → share as expected", (askCents, clause, share) => {
    const r = computeResaleShare({ askCents, clause });
    expect(r.shareCents).toBe(share);
    expect(r.sellerReceivesCents + r.shareCents).toBe(r.basisCents);
  });

  it("a held FLAT on ask 0 holds it to 0 and reports the hold", () => {
    expect(
      computeResaleShare({ askCents: 0, clause: flat(800, "BUYER") }),
    ).toEqual({
      askCents: 0,
      shareCents: 0,
      shareHeld: true,
      heldFromCents: 800,
      sellerReceivesCents: 0,
      basisCents: 0,
      payer: "BUYER",
    });
  });
});

describe("computeResaleShare: the invariant, over many asks", () => {
  const clauses: ResaleShareClause[] = [
    pct(0),
    pct(1),
    pct(333),
    pct(999),
    pct(1000),
    flat(1),
    flat(99),
    flat(800),
    flat(12_345),
  ];
  const asks: number[] = [];
  for (let a = 0; a <= 2_000; a += 1) asks.push(a);
  for (let a = 2_001; a <= 200_000; a += 997) asks.push(a);
  asks.push(RESALE_SHARE_MAX_ASK_CENTS - 1, RESALE_SHARE_MAX_ASK_CENTS);

  it("seller + share = basis, 0 ≤ share ≤ floor(ask/10), basis strictly rising, for both payers", () => {
    let checked = 0;
    let refusedTooLarge = 0;
    for (const base of clauses) {
      for (const payer of ["SELLER", "BUYER"] as const) {
        const clause = { ...base, payer };
        for (const askCents of asks) {
          // A BUYER ask near the Int bound has a basis past it: refused as
          // user input, never returned.
          const ceiling = askCents + Math.floor(askCents / 10);
          if (payer === "BUYER" && ceiling > RESALE_SHARE_MAX_ASK_CENTS) {
            let caught: unknown;
            try {
              const r = computeResaleShare({ askCents, clause });
              // A held FLAT may still fit; then it must be within the bound.
              expect(r.basisCents).toBeLessThanOrEqual(
                RESALE_SHARE_MAX_ASK_CENTS,
              );
              continue;
            } catch (err) {
              caught = err;
            }
            expect(caught).toMatchObject({
              code: "INVALID_INPUT",
              meta: { reason: "resale_total_too_large" },
            });
            refusedTooLarge += 1;
            continue;
          }
          const r = computeResaleShare({ askCents, clause });
          // The search's premise: basis(a + 1) > basis(a).
          if (askCents < RESALE_SHARE_MAX_ASK_CENTS) {
            const next = computeResaleShare({ askCents: askCents + 1, clause });
            expect(next.basisCents).toBeGreaterThan(r.basisCents);
          }
          expect(r.sellerReceivesCents + r.shareCents).toBe(r.basisCents);
          expect(r.shareCents).toBeGreaterThanOrEqual(0);
          expect(r.shareCents).toBeLessThanOrEqual(Math.floor(askCents / 10));
          expect(Number.isInteger(r.shareCents)).toBe(true);
          if (payer === "SELLER") {
            expect(r.basisCents).toBe(askCents);
          } else {
            expect(r.sellerReceivesCents).toBe(askCents);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(30_000);
    expect(refusedTooLarge).toBeGreaterThan(0);
  });
});

describe("computeResaleShare: refusals", () => {
  it("refuses a missing clause", () => {
    expectCode(
      () => computeResaleShare({ askCents: 5000, clause: null }),
      "RESALE_TERMS_MISSING",
    );
    expectCode(
      () => computeResaleShare({ askCents: 5000, clause: undefined }),
      "RESALE_TERMS_MISSING",
    );
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    RESALE_SHARE_MAX_ASK_CENTS + 1,
  ])("refuses ask %s", (askCents) => {
    expectCode(
      () => computeResaleShare({ askCents, clause: pct(1000) }),
      "INVALID_INPUT",
    );
  });

  it.each([
    ["bps above 10%", { type: "PERCENT", bps: 1001, payer: "SELLER" }],
    ["negative bps", { type: "PERCENT", bps: -1, payer: "SELLER" }],
    ["fractional bps", { type: "PERCENT", bps: 2.5, payer: "SELLER" }],
    ["FLAT 0", { type: "FLAT", cents: 0, payer: "SELLER" }],
    ["negative FLAT", { type: "FLAT", cents: -100, payer: "SELLER" }],
    ["fractional FLAT", { type: "FLAT", cents: 1.5, payer: "SELLER" }],
    [
      "PERCENT with cents",
      { type: "PERCENT", bps: 500, cents: 100, payer: "SELLER" },
    ],
    ["FLAT with bps", { type: "FLAT", cents: 100, bps: 500, payer: "SELLER" }],
    ["unknown payer", { type: "PERCENT", bps: 500, payer: "PLATFORM" }],
    ["missing payer", { type: "PERCENT", bps: 500 }],
    ["unknown type", { type: "MARKUP", bps: 500, payer: "SELLER" }],
  ])("refuses a clause with %s", (_label, clause) => {
    expectCode(
      () =>
        computeResaleShare({
          askCents: 5000,
          clause: clause as unknown as ResaleShareClause,
        }),
      "INVALID_INPUT",
    );
  });
});

describe("resaleShareClauseSchema", () => {
  it("accepts every shape the DB CHECK allows", () => {
    for (const clause of [
      pct(0),
      pct(1000),
      pct(500, "BUYER"),
      flat(1),
      flat(800, "BUYER"),
      { type: "PERCENT", bps: 500, cents: null, payer: "SELLER" },
      { type: "FLAT", cents: 800, bps: null, payer: "BUYER" },
    ]) {
      expect(resaleShareClauseSchema.safeParse(clause).success).toBe(true);
    }
  });

  it("rejects FLAT 0 and bps above 1000", () => {
    expect(
      resaleShareClauseSchema.safeParse({
        type: "FLAT",
        cents: 0,
        payer: "SELLER",
      }).success,
    ).toBe(false);
    expect(
      resaleShareClauseSchema.safeParse({
        type: "PERCENT",
        bps: 1001,
        payer: "SELLER",
      }).success,
    ).toBe(false);
  });
});

describe("checkResaleAskWithinCap / highestAskWithinCapCents", () => {
  it("no cap is always ok", () => {
    expect(
      checkResaleAskWithinCap({
        askCents: 1_000_000,
        clause: pct(1000, "BUYER"),
        capCents: null,
      }),
    ).toEqual({ ok: true, basisCents: 1_100_000 });
  });

  it("SELLER payer compares the ask alone and offers the cap itself", () => {
    expect(
      checkResaleAskWithinCap({
        askCents: 4000,
        clause: pct(1000),
        capCents: 4000,
      }),
    ).toEqual({ ok: true, basisCents: 4000 });
    expect(
      checkResaleAskWithinCap({
        askCents: 4001,
        clause: pct(1000),
        capCents: 4000,
      }),
    ).toEqual({
      ok: false,
      basisCents: 4001,
      capCents: 4000,
      highestFittingAskCents: 4000,
    });
  });

  it("BUYER FLAT: the 10% limit is part of the search", () => {
    // FLAT $8 on a $40 cap: below $80 the share is held to 10%, so the answer
    // is the same 3637 as the 10% percentage, not 4000 − 800 = 3200.
    expect(
      highestAskWithinCapCents({ clause: flat(800, "BUYER"), capCents: 4000 }),
    ).toBe(3637);
    // FLAT $1 on a $40 cap: 3900 + 100 = 4000 fits, 3901 + 100 does not.
    expect(
      highestAskWithinCapCents({ clause: flat(100, "BUYER"), capCents: 4000 }),
    ).toBe(3900);
  });

  it("a cap of 0 offers 0; a negative cap offers nothing", () => {
    expect(
      highestAskWithinCapCents({ clause: pct(1000, "BUYER"), capCents: 0 }),
    ).toBe(0);
    expect(
      highestAskWithinCapCents({ clause: pct(1000, "BUYER"), capCents: -1 }),
    ).toBeNull();
  });

  it("matches a brute-force scan for every cap up to $30 and several clauses", () => {
    const clauses: ResaleShareClause[] = [
      pct(0, "BUYER"),
      pct(1, "BUYER"),
      pct(333, "BUYER"),
      pct(1000, "BUYER"),
      flat(1, "BUYER"),
      flat(37, "BUYER"),
      flat(800, "BUYER"),
      pct(1000, "SELLER"),
      flat(800, "SELLER"),
    ];
    for (const clause of clauses) {
      let best = 0;
      for (let capCents = 0; capCents <= 3000; capCents += 1) {
        // basis is monotone, so the brute-force best only moves forward.
        while (
          computeResaleShare({ askCents: best + 1, clause }).basisCents <=
          capCents
        ) {
          best += 1;
        }
        const found = highestAskWithinCapCents({ clause, capCents });
        expect(found).toBe(best);
        // found fits, found + 1 does not.
        expect(
          computeResaleShare({ askCents: found!, clause }).basisCents,
        ).toBeLessThanOrEqual(capCents);
        expect(
          computeResaleShare({ askCents: found! + 1, clause }).basisCents,
        ).toBeGreaterThan(capCents);
      }
    }
  });

  it("refuses a BUYER basis past the Int bound with the highest ask that fits", () => {
    let caught: unknown;
    try {
      computeResaleShare({
        askCents: 2_000_000_000,
        clause: pct(1000, "BUYER"),
      });
    } catch (err) {
      caught = err;
    }
    const highest = highestAskWithinCapCents({
      clause: pct(1000, "BUYER"),
      capCents: null,
    });
    expect(caught).toMatchObject({
      code: "INVALID_INPUT",
      meta: {
        reason: "resale_total_too_large",
        askCents: 2_000_000_000,
        basisCents: 2_200_000_000,
        maxBasisCents: RESALE_SHARE_MAX_ASK_CENTS,
        highestFittingAskCents: highest,
      },
    });
    // The same ask through the cap check, with no cap: still refused.
    expectCode(
      () =>
        checkResaleAskWithinCap({
          askCents: 2_000_000_000,
          clause: pct(1000, "BUYER"),
          capCents: null,
        }),
      "INVALID_INPUT",
    );
    // SELLER at the same ask is fine: the basis is the ask.
    expect(
      computeResaleShare({ askCents: 2_000_000_000, clause: pct(1000) })
        .basisCents,
    ).toBe(2_000_000_000);
  });

  it("with a huge or null cap, never offers an ask whose basis passes the Int bound", () => {
    for (const clause of [
      pct(1000, "BUYER"),
      pct(1, "BUYER"),
      flat(800, "BUYER"),
      flat(RESALE_SHARE_MAX_ASK_CENTS, "BUYER"),
      pct(1000, "SELLER"),
    ]) {
      for (const capCents of [
        null,
        RESALE_SHARE_MAX_ASK_CENTS,
        RESALE_SHARE_MAX_ASK_CENTS + 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const found = highestAskWithinCapCents({ clause, capCents });
        expect(found).not.toBeNull();
        // Accepted by computeResaleShare (it refuses a basis past the bound)…
        const r = computeResaleShare({ askCents: found!, clause });
        expect(r.basisCents).toBeLessThanOrEqual(RESALE_SHARE_MAX_ASK_CENTS);
        // …and the highest such: one cent more is refused or out of range.
        expectCode(
          () => computeResaleShare({ askCents: found! + 1, clause }),
          "INVALID_INPUT",
        );
      }
    }
    // 10% BUYER under the Int bound alone: 1952257861 + 195225786 =
    // 2147483647 exactly (found by a scan, not a closed form).
    const found = highestAskWithinCapCents({
      clause: pct(1000, "BUYER"),
      capCents: null,
    })!;
    expect(found).toBe(1_952_257_861);
    expect(found + Math.floor(found / 10)).toBeLessThanOrEqual(
      RESALE_SHARE_MAX_ASK_CENTS,
    );
    expect(found + 1 + Math.floor((found + 1) / 10)).toBeGreaterThan(
      RESALE_SHARE_MAX_ASK_CENTS,
    );
  });

  it("refuses a missing clause before comparing to the cap", () => {
    expectCode(
      () =>
        checkResaleAskWithinCap({
          askCents: 100,
          clause: null,
          capCents: 4000,
        }),
      "RESALE_TERMS_MISSING",
    );
  });
});
