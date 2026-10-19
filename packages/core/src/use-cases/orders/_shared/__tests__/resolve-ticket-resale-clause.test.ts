import { describe, expect, it, vi } from "vitest";

import type { PayoutTermsRecord } from "@th/types/repos/payout-terms";

import {
  NO_RESALE_CLAUSE,
  copyTicketResaleClause,
  resolveTicketResaleClause,
  stampTicketResaleClause,
  type TicketResaleClause,
} from "../resolve-ticket-resale-clause";

// organiser-resale-share FR-003: the clause a ticket records at its first sale.

const EVENT_ID = "event-1";
const TERMS_ID = "resale-terms-1";

function terms(overrides: Partial<PayoutTermsRecord> = {}): PayoutTermsRecord {
  return {
    id: TERMS_ID,
    kind: "RESALE",
    status: "ACTIVE",
    feeMode: null,
    feePolicyId: null,
    isDefault: false,
    settlementCurrency: "usd",
    payoutSchedule: "WEEK_OF_EVENT",
    resaleProcessingFeeConfigRef: null,
    resalePayoutReleaseDays: 7,
    version: 3,
    createdAt: new Date("2026-10-01"),
    updatedAt: new Date("2026-10-01"),
    resaleShareType: "PERCENT",
    resaleShareBps: 1000,
    resaleShareCents: null,
    resaleSharePayer: "SELLER",
    ...overrides,
  } as PayoutTermsRecord;
}

function reposWith(record: PayoutTermsRecord | null) {
  const getById = vi.fn(async () => record);
  return { repos: { payoutTerms: { getById } }, getById };
}

const TEN_PERCENT: TicketResaleClause = {
  resaleClauseType: "PERCENT",
  resaleClauseBps: 1000,
  resaleClauseCents: null,
  resaleClausePayer: "SELLER",
  resaleClauseTermsId: TERMS_ID,
  resaleClauseTermsVersion: 3,
};

describe("resolveTicketResaleClause", () => {
  it("reads a PERCENT clause with its terms id and version", async () => {
    const { repos, getById } = reposWith(terms());
    await expect(
      resolveTicketResaleClause(repos, {
        id: EVENT_ID,
        resalePayoutTermsId: TERMS_ID,
      }),
    ).resolves.toEqual(TEN_PERCENT);
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith(TERMS_ID);
  });

  it("reads a FLAT BUYER clause", async () => {
    const { repos } = reposWith(
      terms({
        resaleShareType: "FLAT",
        resaleShareBps: null,
        resaleShareCents: 800,
        resaleSharePayer: "BUYER",
        version: 1,
      }),
    );
    await expect(
      resolveTicketResaleClause(repos, {
        id: EVENT_ID,
        resalePayoutTermsId: TERMS_ID,
      }),
    ).resolves.toEqual({
      resaleClauseType: "FLAT",
      resaleClauseBps: null,
      resaleClauseCents: 800,
      resaleClausePayer: "BUYER",
      resaleClauseTermsId: TERMS_ID,
      resaleClauseTermsVersion: 1,
    });
  });

  it("records a 0% clause (zero is a valid setting, FR-001)", async () => {
    const { repos } = reposWith(terms({ resaleShareBps: 0 }));
    await expect(
      resolveTicketResaleClause(repos, {
        id: EVENT_ID,
        resalePayoutTermsId: TERMS_ID,
      }),
    ).resolves.toMatchObject({ resaleClauseType: "PERCENT", resaleClauseBps: 0 });
  });

  it("records nothing, not even the terms id, when the clause is not set", async () => {
    const { repos } = reposWith(
      terms({
        resaleShareType: null,
        resaleShareBps: null,
        resaleShareCents: null,
      }),
    );
    await expect(
      resolveTicketResaleClause(repos, {
        id: EVENT_ID,
        resalePayoutTermsId: TERMS_ID,
      }),
    ).resolves.toEqual(NO_RESALE_CLAUSE);
  });

  it("treats terms from before the clause existed (fields absent) as not set", async () => {
    const legacy = terms();
    delete legacy.resaleShareType;
    delete legacy.resaleShareBps;
    delete legacy.resaleShareCents;
    delete legacy.resaleSharePayer;
    const { repos } = reposWith(legacy);
    await expect(
      resolveTicketResaleClause(repos, {
        id: EVENT_ID,
        resalePayoutTermsId: TERMS_ID,
      }),
    ).resolves.toEqual(NO_RESALE_CLAUSE);
  });

  it("does not read terms for an event with no RESALE terms", async () => {
    const { repos, getById } = reposWith(terms());
    await expect(
      resolveTicketResaleClause(repos, {
        id: EVENT_ID,
        resalePayoutTermsId: null,
      }),
    ).resolves.toEqual(NO_RESALE_CLAUSE);
    expect(getById).not.toHaveBeenCalled();
  });

  it("refuses with INTERNAL when the event names terms that do not exist", async () => {
    const { repos } = reposWith(null);
    await expect(
      resolveTicketResaleClause(repos, {
        id: EVENT_ID,
        resalePayoutTermsId: TERMS_ID,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it.each([
    ["a percentage above the 10% limit", { resaleShareBps: 1001 }],
    ["a PERCENT clause with no bps", { resaleShareBps: null }],
    [
      "a FLAT clause with no amount",
      { resaleShareType: "FLAT" as const, resaleShareBps: null, resaleShareCents: null },
    ],
  ])("refuses with INTERNAL on %s (the CHECK makes it unreachable)", async (_label, overrides) => {
    const { repos } = reposWith(terms(overrides));
    await expect(
      resolveTicketResaleClause(repos, {
        id: EVENT_ID,
        resalePayoutTermsId: TERMS_ID,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("stampTicketResaleClause", () => {
  it("stamps each ticket with the clause and its OWN unit price as the original price", () => {
    const stamped = stampTicketResaleClause(
      [
        { kind: "ticket" as const, unitPriceCents: 4000, qty: 1, amountCents: 4000 },
        // A seat override / pay-what-you-want line: its own price.
        { kind: "ticket" as const, unitPriceCents: 6500, qty: 1, amountCents: 6500 },
        // A comp.
        { kind: "ticket" as const, unitPriceCents: 0, qty: 1, amountCents: 0 },
      ],
      TEN_PERCENT,
    );
    expect(stamped.map((i) => i.originalUnitPriceCents)).toEqual([4000, 6500, 0]);
    for (const item of stamped) expect(item).toMatchObject(TEN_PERCENT);
  });

  it("leaves non-ticket items (promo discount, platform credit, membership) untouched", () => {
    const discount = { kind: "discount" as const, unitPriceCents: -500, qty: 1, amountCents: -500 };
    const credit = { kind: "platform_credit" as const, unitPriceCents: -100, qty: 1, amountCents: -100 };
    const membership = { kind: "membership" as const, unitPriceCents: 1500, qty: 1, amountCents: 1500 };
    const stamped = stampTicketResaleClause([discount, credit, membership], TEN_PERCENT);
    expect(stamped).toEqual([discount, credit, membership]);
    for (const item of stamped) {
      expect(item).not.toHaveProperty("resaleClauseType");
      expect(item).not.toHaveProperty("originalUnitPriceCents");
    }
  });

  it("an unset clause still records the original price", () => {
    const [item] = stampTicketResaleClause(
      [{ kind: "ticket" as const, unitPriceCents: 2500, qty: 1, amountCents: 2500 }],
      NO_RESALE_CLAUSE,
    );
    expect(item).toMatchObject({
      ...NO_RESALE_CLAUSE,
      originalUnitPriceCents: 2500,
    });
  });

  it("does not mutate the input items", () => {
    const input = [{ kind: "ticket" as const, unitPriceCents: 4000, qty: 1, amountCents: 4000 }];
    stampTicketResaleClause(input, TEN_PERCENT);
    expect(input[0]).not.toHaveProperty("resaleClauseType");
  });
});

describe("copyTicketResaleClause", () => {
  it("copies the seller item's record verbatim, original price included", () => {
    expect(
      copyTicketResaleClause({
        ...TEN_PERCENT,
        originalUnitPriceCents: 4000,
      }),
    ).toEqual({ ...TEN_PERCENT, originalUnitPriceCents: 4000 });
  });

  it("copies nulls from a legacy item with no record", () => {
    expect(copyTicketResaleClause({})).toEqual({
      ...NO_RESALE_CLAUSE,
      originalUnitPriceCents: null,
    });
  });
});
