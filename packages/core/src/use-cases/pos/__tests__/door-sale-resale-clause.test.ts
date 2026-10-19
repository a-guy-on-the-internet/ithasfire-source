import { describe, expect, it } from "vitest";

import {
  GA_ID,
  VIP_ID,
  makeWorld,
  sellCard,
  sellCash,
  type Scenario,
  type World,
} from "./door-sale-world";

/**
 * organiser-resale-share FR-003 at the door: a POS card sale
 * (`startPosSale`), a cash sale and a door comp (`recordCashSale`) each write,
 * on every ticket item, the event's RESALE clause in force at the sale plus
 * the ticket's original price, reading the terms once per sale.
 */

const RESALE_TERMS_ID = "resale-terms-door";
const SCENARIO: Scenario = { admissionTaxRateBps: 0 };

type Clause = {
  resaleShareType: "PERCENT" | "FLAT" | null;
  resaleShareBps: number | null;
  resaleShareCents: number | null;
  resaleSharePayer: "SELLER" | "BUYER";
  version: number;
};

const TEN_PERCENT_SELLER: Clause = {
  resaleShareType: "PERCENT",
  resaleShareBps: 1000,
  resaleShareCents: null,
  resaleSharePayer: "SELLER",
  version: 2,
};

/** Points the world's event at RESALE terms carrying `clause`. */
function withResaleTerms(w: World, clause: Clause): void {
  (w.event as Record<string, unknown>).resalePayoutTermsId = RESALE_TERMS_ID;
  const primary = w.tx.payoutTerms.getById.getMockImplementation()!;
  w.tx.payoutTerms.getById.mockImplementation(async (id: string) =>
    id === RESALE_TERMS_ID
      ? ({ id: RESALE_TERMS_ID, kind: "RESALE", status: "ACTIVE", ...clause } as never)
      : primary(id),
  );
}

function resaleTermsReads(w: World): number {
  return w.tx.payoutTerms.getById.mock.calls.filter(
    (call: unknown[]) => call[0] === RESALE_TERMS_ID,
  ).length;
}

function ticketItems(w: World): Array<Record<string, unknown>> {
  return (w.order()!.items as Array<Record<string, unknown>>).filter(
    (item) => item.kind === "ticket",
  );
}

const expectedOriginal = (item: Record<string, unknown>) =>
  item.ticketTypeId === GA_ID ? 2500 : item.ticketTypeId === VIP_ID ? 4000 : NaN;

describe("door sales — FR-003 resale clause record", () => {
  it("a POS card sale stamps the clause and each ticket's own price", async () => {
    const w = makeWorld(SCENARIO);
    withResaleTerms(w, TEN_PERCENT_SELLER);

    await sellCard(SCENARIO, { world: w });

    const items = ticketItems(w);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item).toMatchObject({
        resaleClauseType: "PERCENT",
        resaleClauseBps: 1000,
        resaleClauseCents: null,
        resaleClausePayer: "SELLER",
        resaleClauseTermsId: RESALE_TERMS_ID,
        resaleClauseTermsVersion: 2,
        originalUnitPriceCents: expectedOriginal(item),
      });
      expect(item.originalUnitPriceCents).toBe(item.unitPriceCents);
    }
    expect(resaleTermsReads(w)).toBe(1);
  });

  it("a cash sale stamps the clause and each ticket's own price", async () => {
    const w = makeWorld(SCENARIO);
    withResaleTerms(w, {
      resaleShareType: "FLAT",
      resaleShareBps: null,
      resaleShareCents: 400,
      resaleSharePayer: "BUYER",
      version: 6,
    });

    await sellCash(w, SCENARIO, 10_000);

    const items = ticketItems(w);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item).toMatchObject({
        resaleClauseType: "FLAT",
        resaleClauseBps: null,
        resaleClauseCents: 400,
        resaleClausePayer: "BUYER",
        resaleClauseTermsId: RESALE_TERMS_ID,
        resaleClauseTermsVersion: 6,
        originalUnitPriceCents: expectedOriginal(item),
      });
    }
    expect(resaleTermsReads(w)).toBe(1);
  });

  it("a door comp stamps the clause and an original price of 0", async () => {
    const w = makeWorld({ ...SCENARIO, role: "ADMIN" });
    withResaleTerms(w, TEN_PERCENT_SELLER);

    await sellCash(w, SCENARIO, 0, { comp: true });

    const items = ticketItems(w);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item).toMatchObject({
        unitPriceCents: 0,
        resaleClauseType: "PERCENT",
        resaleClauseBps: 1000,
        resaleClauseTermsId: RESALE_TERMS_ID,
        resaleClauseTermsVersion: 2,
        originalUnitPriceCents: 0,
      });
    }
    expect(resaleTermsReads(w)).toBe(1);
  });

  it("an event whose clause is not set records no clause, but still the original price", async () => {
    const w = makeWorld(SCENARIO);
    withResaleTerms(w, {
      resaleShareType: null,
      resaleShareBps: null,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 1,
    });

    await sellCash(w, SCENARIO, 10_000);

    for (const item of ticketItems(w)) {
      expect(item).toMatchObject({
        resaleClauseType: null,
        resaleClausePayer: null,
        resaleClauseTermsId: null,
        resaleClauseTermsVersion: null,
        originalUnitPriceCents: expectedOriginal(item),
      });
    }
  });

  it("an event with no RESALE terms never reads terms for a clause", async () => {
    const w = makeWorld(SCENARIO);

    await sellCard(SCENARIO, { world: w });

    expect(resaleTermsReads(w)).toBe(0);
    expect(w.tx.payoutTerms.getById).not.toHaveBeenCalledWith(RESALE_TERMS_ID);
    for (const item of ticketItems(w)) {
      expect(item).toMatchObject({
        resaleClauseType: null,
        originalUnitPriceCents: expectedOriginal(item),
      });
    }
  });
});
