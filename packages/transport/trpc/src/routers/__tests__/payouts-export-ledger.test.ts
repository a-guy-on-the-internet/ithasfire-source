import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { payoutsRouter } from "../payouts";

// Transport coverage for the ledger CSV export. Thin-transport contract only
// — auth, the `.omit({ actorHumanId })` + `.strict()` input, the output
// schema, the deps wiring (audit + reportError) and error mapping. The
// snapshot walk, per-currency balances and all-or-nothing rules live in
// `@th/core`'s `exportPayeeLedger` and are tested there.

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const PAYEE_ID = "22222222-2222-4222-8222-222222222222";

const NOW = new Date("2026-10-15T12:00:00.000Z");

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

const ENTRY = {
  id: "ledger-1",
  idempotencyKey: "settlement-credit:order-1:payee",
  payeeId: PAYEE_ID,
  type: "SETTLEMENT_CREDIT",
  amountCents: 532,
  currency: "USD",
  sourceKind: "order_split",
  sourceId: "order-1",
  orderId: "order-1",
  settlementId: null,
  disputeId: null,
  relatedEntryId: null,
  availableAt: new Date("2026-09-20T05:00:00.000Z"),
  consumedByEntryId: null,
  description: "Ticket revenue — order 1",
  metadata: null,
  createdAt: new Date("2026-09-13T00:00:00.000Z"),
};

function makeRepos(options: { auditFails?: boolean } = {}) {
  return {
    payeeLedger: {
      listEntries: vi.fn(async () => [ENTRY]),
      listDebitsForDispute: vi.fn(async () => []),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: PAYEE_ID })),
    },
    orders: {
      getEventAttributionByIds: vi.fn(
        async () =>
          new Map([
            [
              "order-1",
              {
                orderId: "order-1",
                orderCode: null,
                kind: "TICKETING",
                eventId: "ev-1",
                eventTitle: "Roast the Host",
                eventSlug: "roast-the-host",
                eventStartsAt: null,
              },
            ],
          ]),
      ),
    },
    audit: {
      log: vi.fn(async () => {
        if (options.auditFails) throw new Error("audit write failed");
      }),
    },
  } as any;
}

const clock = { now: vi.fn(() => NOW) } as any;

describe("payouts.exportLedger", () => {
  it("is a MUTATION — it writes an audit row, so a refetch or cross-site GET must not re-run it", () => {
    expect(payoutsRouter.exportLedger._def.type).toBe("mutation");
  });

  it("rejects an unauthenticated caller", async () => {
    const { caller } = createCaller(
      { exportLedger: payoutsRouter.exportLedger },
      { actorHumanId: null, repos: makeRepos(), clock },
    );

    await expect(caller.exportLedger({ orgId: ORG_ID })).rejects.toThrow(
      /unauthorized/i,
    );
  });

  it("rejects a caller without org finance permission, before any ledger read or audit", async () => {
    const repos = makeRepos();
    const { authz, canFinanceOrg } = authzWith(false);
    const { caller } = createCaller(
      { exportLedger: payoutsRouter.exportLedger },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    await expect(caller.exportLedger({ orgId: ORG_ID })).rejects.toThrow(
      /forbidden/i,
    );
    expect(canFinanceOrg).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(repos.payeeLedger.listEntries).not.toHaveBeenCalled();
    expect(repos.audit.log).not.toHaveBeenCalled();
  });

  it("returns the rows through the output schema and writes the audit row", async () => {
    const repos = makeRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { exportLedger: payoutsRouter.exportLedger },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    const result = await caller.exportLedger({ orgId: ORG_ID });

    expect(result.payeeId).toBe(PAYEE_ID);
    expect(result.asOf).toEqual(NOW);
    expect(result.rows).toEqual([
      {
        id: "ledger-1",
        type: "SETTLEMENT_CREDIT",
        description: "Ticket revenue — order 1",
        orderId: "order-1",
        eventName: "Roast the Host",
        createdAt: ENTRY.createdAt,
        availableAt: ENTRY.availableAt,
        currency: "usd",
        amountCents: 532,
        changeCents: 532,
        balanceAfterCents: 532,
      },
    ]);
    expect(repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "payee",
        entityId: PAYEE_ID,
        action: "payee_ledger_export",
      }),
    );
  });

  it("serves the HUMAN path with no argument at all", async () => {
    const repos = makeRepos();
    const { authz, canFinanceOrg } = authzWith(true);
    const { caller } = createCaller(
      { exportLedger: payoutsRouter.exportLedger },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    await caller.exportLedger();

    expect(canFinanceOrg).not.toHaveBeenCalled();
    expect(repos.payees.getBySubject).toHaveBeenCalledWith({
      type: "HUMAN",
      id: ACTOR_ID,
    });
  });

  it("wires ctx.reportError, so a failed audit write is reported and the export still returns", async () => {
    const repos = makeRepos({ auditFails: true });
    const { authz } = authzWith(true);
    const reportError = vi.fn();
    const { caller } = createCaller(
      { exportLedger: payoutsRouter.exportLedger },
      { actorHumanId: ACTOR_ID, authz, repos, clock, reportError } as any,
    );

    const result = await caller.exportLedger({ orgId: ORG_ID });

    expect(result.rows).toHaveLength(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "exportPayeeLedger", step: "auditLog" },
      }),
    );
  });

  it("refuses an unknown input key — actorHumanId cannot be spoofed", async () => {
    const repos = makeRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { exportLedger: payoutsRouter.exportLedger },
      { actorHumanId: ACTOR_ID, authz, repos, clock },
    );

    await expect(
      caller.exportLedger({ actorHumanId: "someone-else" } as never),
    ).rejects.toThrow();
    expect(repos.payeeLedger.listEntries).not.toHaveBeenCalled();
  });
});
