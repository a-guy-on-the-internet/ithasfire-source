import { describe, expect, it, vi } from "vitest";

import { makeFeePoliciesRepo } from "../fee-policies";
import {
  makePayoutTermsRepo,
  PER_ORDER_PAYOUT_LINE_WHERE,
} from "../payout-terms";
import type { PrismaClientOrTx } from "../types";

/**
 * PURE unit tests (a fake Prisma client, no database) for the batch reads the
 * all-in listing price uses. They pin the query SHAPE — one query per call,
 * the per-order line fence, the `resolveEffective` ordering — and the
 * in-memory bucketing. The real-SQL behaviour belongs to the integration
 * suites, which need a database.
 */

const policyRow = (
  id: string,
  scopeId: string | null,
  version = 1,
): Record<string, unknown> => ({
  id,
  scopeType: "ORG",
  scopeId,
  status: "ACTIVE",
  version,
  effectiveFrom: new Date("2026-01-01"),
  effectiveTo: null,
  buyerFeePct: 0.0333,
  maxFeeCents: 50,
  minFeeCents: 0,
  maxPlatformFeeCents: null,
  platformFixedCents: 0,
  feeMode: "PASS_THROUGH",
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0.0025,
  payoutFixedCents: 25,
  monthlyPayoutCents: 200,
  payoutMinimumCents: 1000,
  connectAccountFeeCents: 0,
});

describe("feePolicies.resolveEffectiveForScopes", () => {
  it("one query with resolveEffective's filter + ordering; first row per scope wins", async () => {
    const findMany = vi.fn(async () => [
      // Rows arrive best-first (effectiveFrom desc, version desc).
      policyRow("org-a-v2", "org-a", 2),
      policyRow("org-a-v1", "org-a", 1),
      policyRow("org-b-v1", "org-b", 1),
    ]);
    const repo = makeFeePoliciesRepo({
      feePolicy: { findMany },
    } as unknown as PrismaClientOrTx);
    const at = new Date("2026-10-02");

    const result = await repo.resolveEffectiveForScopes({
      scopeType: "ORG",
      scopeIds: ["org-a", "org-b", "org-a", "org-c"],
      at,
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        scopeType: "ORG",
        scopeId: { in: ["org-a", "org-b", "org-c"] },
        status: "ACTIVE",
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    });
    expect([...result.entries()].map(([k, v]) => [k, v.id])).toEqual([
      ["org-a", "org-a-v2"],
      ["org-b", "org-b-v1"],
    ]);
  });

  it("no scope ids ⇒ no query", async () => {
    const findMany = vi.fn();
    const repo = makeFeePoliciesRepo({
      feePolicy: { findMany },
    } as unknown as PrismaClientOrTx);
    const result = await repo.resolveEffectiveForScopes({
      scopeType: "EVENT",
      scopeIds: [],
      at: new Date(),
    });
    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("feePolicies.getByIds", () => {
  it("one query, keyed by id", async () => {
    const findMany = vi.fn(async () => [policyRow("p1", "org-a")]);
    const repo = makeFeePoliciesRepo({
      feePolicy: { findMany },
    } as unknown as PrismaClientOrTx);
    const result = await repo.getByIds(["p1", "p1", "missing"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1", "missing"] } },
    });
    expect([...result.keys()]).toEqual(["p1"]);
  });
});

const termsRow = (id: string) => ({
  id,
  kind: "PRIMARY",
  status: "ACTIVE",
  feeMode: null,
  feePolicyId: "p1",
  isDefault: false,
  settlementCurrency: "usd",
  payoutSchedule: "WEEK_OF_EVENT",
  resaleProcessingFeeConfigRef: null,
  resalePayoutReleaseDays: null,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("payoutTerms.listByEventIds", () => {
  it("two queries for any number of events; primary before resale; unknown ids map to []", async () => {
    const eventFindMany = vi.fn(async () => [
      { id: "e1", payoutTermsId: "t1", resalePayoutTermsId: "r1" },
      { id: "e2", payoutTermsId: "t1", resalePayoutTermsId: null },
      { id: "e3", payoutTermsId: null, resalePayoutTermsId: null },
    ]);
    // Deliberately returned in the "wrong" order: the result must follow the
    // event's pointers, not the query's row order.
    const termsFindMany = vi.fn(async () => [termsRow("r1"), termsRow("t1")]);
    const repo = makePayoutTermsRepo({
      event: { findMany: eventFindMany },
      payoutTerms: { findMany: termsFindMany },
    } as unknown as PrismaClientOrTx);

    const result = await repo.listByEventIds(["e1", "e2", "e3", "gone"]);

    expect(eventFindMany).toHaveBeenCalledTimes(1);
    expect(termsFindMany).toHaveBeenCalledTimes(1);
    expect(termsFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["t1", "r1"] } },
    });
    expect(
      Object.fromEntries(
        [...result.entries()].map(([k, v]) => [k, v.map((t) => t.id)]),
      ),
    ).toEqual({ e1: ["t1", "r1"], e2: ["t1"], e3: [], gone: [] });
  });
});

describe("payoutTerms.listLinesByTermsIds", () => {
  it("one query, carrying the per-order line fence and listLines' ordering", async () => {
    const line = (id: string, payoutTermsId: string) => ({
      id,
      payoutTermsId,
      payeeId: "payee",
      ticketTypeId: null,
      percent: 50,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
      requiresConfirmation: false,
      confirmationStatus: null,
      confirmedAt: null,
      counterPercentBps: null,
      counterNote: null,
      // The fence columns: a per-order line, as the where-clause selects.
      ...PER_ORDER_PAYOUT_LINE_WHERE,
    });
    const findMany = vi.fn(async () => [
      line("l1", "t1"),
      line("l2", "t2"),
      line("l3", "t1"),
    ]);
    const repo = makePayoutTermsRepo({
      payoutTermsLine: { findMany },
    } as unknown as PrismaClientOrTx);

    const result = await repo.listLinesByTermsIds(["t1", "t2", "t3"]);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        payoutTermsId: { in: ["t1", "t2", "t3"] },
        ...PER_ORDER_PAYOUT_LINE_WHERE,
      },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
    expect(
      Object.fromEntries(
        [...result.entries()].map(([k, v]) => [k, v.map((l) => l.id)]),
      ),
    ).toEqual({ t1: ["l1", "l3"], t2: ["l2"], t3: [] });
  });
});
