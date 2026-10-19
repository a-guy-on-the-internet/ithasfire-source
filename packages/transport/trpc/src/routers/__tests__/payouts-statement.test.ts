import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { payoutsRouter } from "../payouts";

// Transport coverage for the organiser ledger statement. Thin-transport
// contract only — auth, the `.omit({ actorHumanId })` + `.strict()` input,
// the output schema and error mapping. The balance-vs-payable arithmetic and
// every degradation rule live in `@th/core`'s `getPayeeStatement` and are
// tested there.

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const PAYEE_ID = "22222222-2222-4222-8222-222222222222";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const SEP_20 = new Date("2026-09-20T05:00:00.000Z");

const authzWith = (allowed: boolean) => {
  const canFinanceOrg = vi.fn(async () => ({ allowed }));
  return {
    authz: {
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(),
      canFinanceOrg,
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as any,
    canFinanceOrg,
  };
};

/** The observed production shape: balance 1064, payable 0, arriving 20 Sep. */
function makeRepos() {
  return {
    payeeLedger: {
      getBalance: vi.fn(async () => ({
        payeeId: PAYEE_ID,
        currency: "usd",
        ledgerBalanceCents: 1064,
        pendingHoldCents: 0,
        reserveCents: 0,
        availableCents: 1064,
      })),
      listPayableBalances: vi.fn(async () => []),
      listUpcomingMaturities: vi.fn(async () => [
        {
          payeeId: PAYEE_ID,
          currency: "usd",
          maturesAt: SEP_20,
          creditCents: 1064,
          heldCents: 0,
          creditCount: 2,
        },
      ]),
      listEntries: vi.fn(async () => [
        {
          id: "ledger-1",
          idempotencyKey: "settlement-credit:order-1:payee",
          payeeId: PAYEE_ID,
          type: "SETTLEMENT_CREDIT",
          amountCents: 532,
          currency: "usd",
          sourceKind: "order_split",
          sourceId: "order-1",
          orderId: "order-1",
          settlementId: null,
          disputeId: null,
          relatedEntryId: null,
          availableAt: SEP_20,
          consumedByEntryId: null,
          description: "Ticket revenue — order 1",
          metadata: null,
          createdAt: new Date("2026-09-13T00:00:00.000Z"),
        },
      ]),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: PAYEE_ID })),
      getById: vi.fn(async () => ({
        id: PAYEE_ID,
        subjectType: "ORGANIZATION",
        subjectId: ORG_ID,
        stripeAccountId: "acct_1",
        status: "ACTIVE",
        payoutsEnabled: true,
        chargesEnabled: true,
        defaultCurrency: "usd",
        resaleNegativeBalanceCents: 0,
        resaleNegativeBalanceOpenedAt: null,
        resaleNegativeBalanceAgingStartsAt: null,
        resalePayoutBlockReason: null,
        resalePayoutBlockedAt: null,
      })),
    },
    feePolicies: {
      resolveEffective: vi.fn(async () => ({ payoutMinimumCents: 1_000 })),
    },
  } as any;
}

const clock = { now: vi.fn(() => NOW) } as any;

describe("payouts.getStatement", () => {
  it("rejects an unauthenticated caller", async () => {
    const { caller } = createCaller(
      { getStatement: payoutsRouter.getStatement },
      { actorHumanId: null, repos: makeRepos(), clock },
    );

    await expect(caller.getStatement({ orgId: ORG_ID })).rejects.toThrow(
      /unauthorized/i,
    );
  });

  it("rejects a caller without org finance permission, before any ledger read", async () => {
    const repos = makeRepos();
    const { authz, canFinanceOrg } = authzWith(false);
    const { caller } = createCaller(
      { getStatement: payoutsRouter.getStatement },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    await expect(caller.getStatement({ orgId: ORG_ID })).rejects.toThrow(
      /forbidden/i,
    );
    expect(canFinanceOrg).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(repos.payeeLedger.getBalance).not.toHaveBeenCalled();
    expect(repos.payeeLedger.listEntries).not.toHaveBeenCalled();
  });

  it("returns balance and payable as SEPARATE figures for a permitted caller", async () => {
    const repos = makeRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { getStatement: payoutsRouter.getStatement },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    const result = await caller.getStatement({ orgId: ORG_ID });

    expect(result).toMatchObject({
      payeeId: PAYEE_ID,
      currency: "usd",
      balanceCents: 1064,
      payableCents: 0,
      nextArrivalCents: 1064,
      arrivalResolved: true,
      payoutMinimumCents: 1_000,
      minimumResolved: true,
      hasMore: false,
      nextOffset: null,
    });
    expect(result.nextArrivalAt).toEqual(SEP_20);
    expect(result.entries).toHaveLength(1);
    expect(result.asOf).toEqual(NOW);
  });

  it("serves the HUMAN path with no argument at all", async () => {
    const repos = makeRepos();
    const { authz, canFinanceOrg } = authzWith(true);
    const { caller } = createCaller(
      { getStatement: payoutsRouter.getStatement },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    const result = await caller.getStatement();

    expect(canFinanceOrg).not.toHaveBeenCalled();
    expect(repos.payees.getBySubject).toHaveBeenCalledWith({
      type: "HUMAN",
      id: ACTOR_ID,
    });
    expect(result.balanceCents).toBe(1064);
  });

  it("refuses an unknown input key — actorHumanId cannot be spoofed", async () => {
    const repos = makeRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { getStatement: payoutsRouter.getStatement },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    await expect(
      caller.getStatement({ actorHumanId: "someone-else" } as never),
    ).rejects.toThrow();
  });
});
