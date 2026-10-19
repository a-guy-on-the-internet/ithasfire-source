import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { getCashTillReport } from "./get-cash-till-report";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";

const EMPTY_SUMMARY = {
  truncated: false,
  paidSaleCount: 0,
  cashCollectedCents: 0,
  taxCents: 0,
  platformFeeOwedCents: 0,
  organiserKeepsCents: 0,
  compSaleCount: 0,
  compTicketCount: 0,
  freeWithCodeSaleCount: 0,
  freeWithCodeTicketCount: 0,
  paidTicketCount: 0,
  refundedSaleCount: 0,
  refundedCents: 0,
  recentSales: [],
};

function makeDeps(opts?: {
  event?: unknown;
  membership?: { role: string } | null;
  summary?: Partial<typeof EMPTY_SUMMARY> & {
    recentSales?: Array<Record<string, unknown>>;
  };
}) {
  const summarizeCashTillForEvent = vi.fn(async () => ({
    ...EMPTY_SUMMARY,
    ...opts?.summary,
  }));

  const repos = {
    events: {
      getById: vi.fn(async () =>
        opts?.event === undefined
          ? { id: EVENT_ID, orgId: ORG_ID, currency: "usd" }
          : opts.event,
      ),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        opts?.membership === undefined
          ? { orgId: ORG_ID, humanId: ACTOR, role: "SCANNER" as const }
          : opts.membership,
      ),
    },
    orders: { summarizeCashTillForEvent },
  } as unknown as Repos;

  return { repos, summarizeCashTillForEvent };
}

describe("getCashTillReport", () => {
  it("returns the drawer totals for the event", async () => {
    const { repos, summarizeCashTillForEvent } = makeDeps({
      summary: {
        paidSaleCount: 12,
        cashCollectedCents: 42_500,
        compSaleCount: 3,
        compTicketCount: 4,
        paidTicketCount: 17,
        refundedSaleCount: 1,
        refundedCents: 2500,
        // FR-009: the split of the cash collected (sum of the three).
        taxCents: 3_400,
        platformFeeOwedCents: 3_100,
        organiserKeepsCents: 36_000,
      },
    });

    const result = await getCashTillReport(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );

    expect(result.cashCollectedCents).toBe(42_500);
    expect(result.paidSaleCount).toBe(12);
    expect(result.compSaleCount).toBe(3);
    expect(result.compTicketCount).toBe(4);
    expect(result.refundedCents).toBe(2500);
    expect(result.taxCents).toBe(3_400);
    expect(result.platformFeeOwedCents).toBe(3_100);
    expect(result.organiserKeepsCents).toBe(36_000);
    expect(result.currency).toBe("usd");
    expect(summarizeCashTillForEvent).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      // Default tail size — a door wants the last handful, not the night.
      recentLimit: 20,
    });
  });

  it("reports free-with-a-code sales apart from comps, and each sale's code", async () => {
    const occurredAt = new Date("2026-04-26T20:00:00Z");
    const { repos } = makeDeps({
      summary: {
        compSaleCount: 1,
        compTicketCount: 1,
        freeWithCodeSaleCount: 2,
        freeWithCodeTicketCount: 3,
        recentSales: [
          {
            orderId: "00000000-0000-4000-8000-0000000000f1",
            shortId: "A1",
            amountCents: 0,
            ticketCount: 2,
            isComp: false,
            promoCode: "FREEALL",
            isRefunded: false,
            occurredAt,
          },
          {
            orderId: "00000000-0000-4000-8000-0000000000f2",
            shortId: "A2",
            amountCents: 0,
            ticketCount: 1,
            isComp: true,
            promoCode: null,
            isRefunded: false,
            occurredAt,
          },
        ],
      },
    });

    const result = await getCashTillReport(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );

    expect(result.compSaleCount).toBe(1);
    expect(result.compTicketCount).toBe(1);
    expect(result.freeWithCodeSaleCount).toBe(2);
    expect(result.freeWithCodeTicketCount).toBe(3);
    expect(
      result.recentSales.map((r) => [r.promoCode, r.isComp]),
    ).toEqual([
      ["FREEALL", false],
      [null, true],
    ]);
  });

  it("passes an explicit recentLimit through", async () => {
    const { repos, summarizeCashTillForEvent } = makeDeps();

    await getCashTillReport(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, eventId: EVENT_ID, recentLimit: 5 },
    );

    expect(summarizeCashTillForEvent).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      recentLimit: 5,
    });
  });

  it("reads zero cleanly for a door that has taken nothing", async () => {
    const { repos } = makeDeps();

    const result = await getCashTillReport(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );

    expect(result.cashCollectedCents).toBe(0);
    expect(result.recentSales).toEqual([]);
  });

  it("rejects an unknown event", async () => {
    const { repos } = makeDeps({ event: null });

    await expect(
      getCashTillReport(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects a personal (non-org) event", async () => {
    const { repos } = makeDeps({
      event: { id: EVENT_ID, orgId: null, currency: "usd" },
    });

    await expect(
      getCashTillReport(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ORG_OWNED" });
  });

  it("refuses a caller with no role on the org — and does not read the till first", async () => {
    const { repos, summarizeCashTillForEvent } = makeDeps({ membership: null });

    await expect(
      getCashTillReport(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    // The authz gate must run BEFORE the read, or a refusal still leaks
    // takings through timing / logs.
    expect(summarizeCashTillForEvent).not.toHaveBeenCalled();
  });

  it("allows a SCANNER — whoever can take the money can count it", async () => {
    const { repos } = makeDeps({ membership: { role: "SCANNER" } });

    await expect(
      getCashTillReport(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).resolves.toMatchObject({ eventId: EVENT_ID });
  });
});
