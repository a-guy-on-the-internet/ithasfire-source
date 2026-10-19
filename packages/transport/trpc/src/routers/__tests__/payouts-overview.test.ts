import { describe, expect, it, vi } from "vitest";

import { fail } from "@th/errors";
import * as overviewModule from "@th/core/use-cases/payouts/get-org-payout-overview";

import { createCaller } from "./test-helpers";
import { payoutsRouter } from "../payouts";

// Transport coverage for the organiser payout overview. Thin-transport
// contract only — auth, the `.omit({ actorHumanId })` + `.strict()` input,
// the output schema and error mapping. Every figure and every degradation
// rule live in `@th/core`'s `getOrgPayoutOverview` and are tested there.
//
// Two styles, on purpose:
//   * the REAL use case with a minimal repo surface, for the paths that stop
//     early (RBAC refusal; the no-payee empty overview) — proves the wiring
//     without mocking the module away;
//   * a SPIED use case for the "whatever core returns / throws, the transport
//     passes through `toTrpcError`" contract, where the repo surface behind a
//     full overview is not the thing under test.

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const PAYEE_ID = "22222222-2222-4222-8222-222222222222";

const NOW = new Date("2026-09-16T12:00:00.000Z");

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

/** Enough repo surface for the two real-use-case paths exercised here. */
function makeRepos(opts: { payee?: boolean } = {}) {
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
      listUpcomingMaturities: vi.fn(async () => []),
      listEntries: vi.fn(async () => []),
    },
    payees: {
      getBySubject: vi.fn(async () => (opts.payee ? { id: PAYEE_ID } : null)),
      getById: vi.fn(async () => ({
        id: PAYEE_ID,
        subjectType: "ORGANIZATION",
        subjectId: ORG_ID,
        defaultCurrency: "usd",
      })),
    },
    payoutItems: {
      listHistory: vi.fn(async () => ({
        items: [],
        pageInfo: {
          cursorField: "occurredAt",
          nextCursor: null,
          limit: 5,
          hasNextPage: false,
        },
        total: 0,
      })),
    },
    orders: { getEventAttributionByIds: vi.fn(async () => new Map()) },
    feePolicies: {
      resolveEffective: vi.fn(async () => ({ payoutMinimumCents: 1_000 })),
    },
  } as any;
}

const clock = { now: vi.fn(() => NOW) } as any;

/** A fully-resolved overview, as core would return it. */
function fullOverview(): overviewModule.GetOrgPayoutOverviewOutput {
  return {
    payeeId: PAYEE_ID,
    currency: "usd",
    otherCurrencies: [],
    balanceCents: 1064,
    payableCents: 0,
    payableResolved: true,
    pendingHoldCents: 0,
    reserveCents: 0,
    payoutMinimumCents: 1_000,
    minimumResolved: true,
    belowMinimum: true,
    payoutOverdue: false,
    upcoming: [],
    upcomingTruncated: false,
    upcomingTrancheCount: 0,
    upcomingCreditCents: 0,
    upcomingExpectedCents: 0,
    upcomingResolved: true,
    attributionResolved: true,
    recentPayouts: [],
    historyResolved: true,
    nextPayoutRun: { runAt: "2026-09-17T05:00:00.000Z", night: "2026-09-16" },
    asOf: NOW,
  };
}

describe("payouts.getOverview", () => {
  it("rejects an unauthenticated caller before touching the use case", async () => {
    const spy = vi.spyOn(overviewModule, "getOrgPayoutOverview");
    const { caller } = createCaller(
      { getOverview: payoutsRouter.getOverview },
      { actorHumanId: null, repos: makeRepos(), clock },
    );

    await expect(caller.getOverview({ orgId: ORG_ID })).rejects.toThrow(
      /unauthorized/i,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("surfaces an RBAC refusal from canFinanceOrg as FORBIDDEN, before any ledger read", async () => {
    const repos = makeRepos({ payee: true });
    const { authz, canFinanceOrg } = authzWith(false);
    const { caller } = createCaller(
      { getOverview: payoutsRouter.getOverview },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    await expect(caller.getOverview({ orgId: ORG_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(canFinanceOrg).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(repos.payeeLedger.getBalance).not.toHaveBeenCalled();
    expect(repos.payees.getBySubject).not.toHaveBeenCalled();
  });

  it("returns the real use case's EMPTY overview for an org with no payee, through the output schema", async () => {
    const repos = makeRepos({ payee: false });
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { getOverview: payoutsRouter.getOverview },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    const result = await caller.getOverview({ orgId: ORG_ID });

    expect(result).toMatchObject({
      payeeId: null,
      balanceCents: 0,
      payableCents: 0,
      payableResolved: true,
      payoutMinimumCents: 1_000,
      minimumResolved: true,
      belowMinimum: null,
      payoutOverdue: null,
      upcoming: [],
      recentPayouts: [],
      historyResolved: true,
    });
    expect(result.asOf).toEqual(NOW);
    expect(repos.payeeLedger.getBalance).not.toHaveBeenCalled();
  });

  it("passes the use case's output through untouched (happy path), with the actor injected from ctx", async () => {
    const expected = fullOverview();
    const spy = vi
      .spyOn(overviewModule, "getOrgPayoutOverview")
      .mockResolvedValue(expected);
    const { authz } = authzWith(true);
    const { caller, ctx } = createCaller(
      { getOverview: payoutsRouter.getOverview },
      { actorHumanId: ACTOR_ID, authz, repos: makeRepos(), clock },
    );

    const result = await caller.getOverview({ orgId: ORG_ID });

    expect(result).toEqual(expected);
    expect(spy).toHaveBeenCalledTimes(1);
    const [deps, input] = spy.mock.calls[0]!;
    expect(input).toEqual({ orgId: ORG_ID, actorHumanId: ACTOR_ID });
    // The exact deps shape the use case declares — nothing more, nothing
    // missing, and the reporter wired through from ctx.
    expect(Object.keys(deps).sort()).toEqual(
      ["authz", "clock", "logger", "repos", "reportError"].sort(),
    );
    expect(deps.repos).toBe(ctx.repos);
    expect(deps.clock).toBe(ctx.clock);
    spy.mockRestore();
  });

  it("wires ctx.reportError through to the use case as the SAME function", async () => {
    // The key-set assertion above cannot tell a wired reporter from
    // `undefined ?? undefined`; this one can.
    const reportError = vi.fn();
    const spy = vi
      .spyOn(overviewModule, "getOrgPayoutOverview")
      .mockResolvedValue(fullOverview());
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { getOverview: payoutsRouter.getOverview },
      { actorHumanId: ACTOR_ID, authz, repos: makeRepos(), clock, reportError },
    );

    await caller.getOverview({ orgId: ORG_ID });

    const [deps] = spy.mock.calls[0]!;
    expect(deps.reportError).toBe(reportError);
    spy.mockRestore();
  });

  it("maps a use-case fail(...) through toTrpcError", async () => {
    const spy = vi
      .spyOn(overviewModule, "getOrgPayoutOverview")
      .mockImplementation(async () => fail("ORGANIZATION_NOT_FOUND"));
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { getOverview: payoutsRouter.getOverview },
      { actorHumanId: ACTOR_ID, authz, repos: makeRepos(), clock },
    );

    await expect(caller.getOverview({ orgId: ORG_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    spy.mockRestore();
  });

  it("refuses an unknown input key — actorHumanId cannot be spoofed", async () => {
    const { authz, canFinanceOrg } = authzWith(true);
    const { caller } = createCaller(
      { getOverview: payoutsRouter.getOverview },
      { actorHumanId: ACTOR_ID, authz, repos: makeRepos(), clock },
    );

    await expect(
      caller.getOverview({ orgId: ORG_ID, actorHumanId: "someone-else" } as never),
    ).rejects.toThrow();
    expect(canFinanceOrg).not.toHaveBeenCalled();
  });

  it("requires orgId — there is no human-payee form of the overview", async () => {
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { getOverview: payoutsRouter.getOverview },
      { actorHumanId: ACTOR_ID, authz, repos: makeRepos(), clock },
    );

    await expect(caller.getOverview({} as never)).rejects.toThrow();
    await expect(caller.getOverview(undefined as never)).rejects.toThrow();
  });
});
