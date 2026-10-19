import { describe, expect, it, vi } from "vitest";

import type { PayeeLedgerEntryRecord } from "@th/ports/repos/payee-ledger";

import {
  getOwnerPayoutSummary,
  getOwnerPayoutSummaryOutputSchema,
  OWNER_PAYOUT_SUMMARY_MAX_COUNTED_ITEMS,
  type GetOwnerPayoutSummaryDeps,
} from "../get-owner-payout-summary";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PAYEE = "payee-1";

function credit(
  overrides: Partial<PayeeLedgerEntryRecord> = {},
): PayeeLedgerEntryRecord {
  return {
    id: "entry-1",
    idempotencyKey: "k1",
    payeeId: PAYEE,
    type: "SETTLEMENT_CREDIT",
    amountCents: 4_000,
    currency: "usd",
    sourceKind: "order",
    sourceId: "order-1",
    orderId: "order-1",
    settlementId: null,
    disputeId: null,
    relatedEntryId: null,
    availableAt: new Date("2026-10-04T00:00:00.000Z"),
    consumedByEntryId: null,
    description: "Ticket sales",
    metadata: null,
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
    ...overrides,
  };
}

function makeDeps(
  options: {
    allowed?: boolean;
    payeeRef?: { id: string } | null;
    payeeRow?: Record<string, unknown> | null;
    ledgerBalanceCents?: number;
    credits?: PayeeLedgerEntryRecord[];
    ledgerFail?: boolean;
  } = {},
) {
  const canFinanceOrg = vi.fn(async () => ({
    allowed: options.allowed ?? true,
  }));
  const getBySubject = vi.fn(async () =>
    options.payeeRef === undefined ? { id: PAYEE } : options.payeeRef,
  );
  const getById = vi.fn(async () =>
    options.payeeRow === undefined
      ? { id: PAYEE, defaultCurrency: "USD" }
      : options.payeeRow,
  );
  const ledgerFailure = new Error("ledger read timed out");
  const getBalance = vi.fn(async () => {
    if (options.ledgerFail) throw ledgerFailure;
    return {
      payeeId: PAYEE,
      currency: "usd",
      ledgerBalanceCents: options.ledgerBalanceCents ?? 12_345,
      pendingHoldCents: 0,
      reserveCents: 0,
    };
  });
  const listEntries = vi.fn(async () => {
    if (options.ledgerFail) throw ledgerFailure;
    return options.credits ?? [credit(), credit({ id: "entry-2" })];
  });

  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTime: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  };
  logger.child.mockReturnValue(logger);
  const reportError = vi.fn();

  const deps = {
    repos: {
      payees: { getBySubject, getById },
      payeeLedger: { getBalance, listEntries },
    },
    authz: { canFinanceOrg },
    logger,
    reportError,
  } as unknown as GetOwnerPayoutSummaryDeps;

  return {
    deps,
    canFinanceOrg,
    getBySubject,
    getBalance,
    listEntries,
    logger,
    reportError,
    ledgerFailure,
  };
}

const run = async (
  h: ReturnType<typeof makeDeps>,
  input: Record<string, unknown> = { orgId: ORG_ID },
) =>
  getOwnerPayoutSummaryOutputSchema.parse(
    await getOwnerPayoutSummary(h.deps, { actorHumanId: ACTOR, ...input }),
  );

describe("getOwnerPayoutSummary — authz", () => {
  it("refuses an actor without org finance permission", async () => {
    const h = makeDeps({ allowed: false });

    await expect(
      getOwnerPayoutSummary(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(h.getBySubject).not.toHaveBeenCalled();
  });

  it("needs no probe on the human path — the subject IS the actor", async () => {
    const h = makeDeps();

    await run(h, {});

    expect(h.canFinanceOrg).not.toHaveBeenCalled();
    expect(h.getBySubject).toHaveBeenCalledWith({ type: "HUMAN", id: ACTOR });
  });

  it("scopes the org path to that org's payee", async () => {
    const h = makeDeps();

    await run(h);

    expect(h.getBySubject).toHaveBeenCalledWith({
      type: "ORGANIZATION",
      id: ORG_ID,
    });
  });
});

describe("getOwnerPayoutSummary — the number", () => {
  it("reads the LEDGER BALANCE, not gross ticket face value", async () => {
    const h = makeDeps({ ledgerBalanceCents: 7_412 });

    const out = await run(h);

    expect(out).toMatchObject({
      pendingPayoutCents: 7_412,
      currency: "usd",
      resolved: true,
      hasPayee: true,
    });
    expect(h.getBalance).toHaveBeenCalledWith(PAYEE, "usd");
  });

  it("normalises the payee's currency before asking the ledger", async () => {
    const h = makeDeps({ payeeRow: { id: PAYEE, defaultCurrency: " USD " } });

    const out = await run(h);

    expect(out.currency).toBe("usd");
    expect(h.getBalance).toHaveBeenCalledWith(PAYEE, "usd");
  });

  it("reports a NEGATIVE balance as the debt it is, unclamped", async () => {
    const h = makeDeps({ ledgerBalanceCents: -2_500 });

    const out = await run(h);

    expect(out.pendingPayoutCents).toBe(-2_500);
  });

  it("counts UNCONSUMED settlement credits, one row over the cap to measure exactness", async () => {
    const h = makeDeps();

    const out = await run(h);

    expect(h.listEntries).toHaveBeenCalledWith(PAYEE, {
      currency: "usd",
      types: ["SETTLEMENT_CREDIT"],
      unconsumedOnly: true,
      limit: OWNER_PAYOUT_SUMMARY_MAX_COUNTED_ITEMS + 1,
    });
    expect(out.pendingItemCount).toBe(2);
    expect(out.itemCountExact).toBe(true);
  });

  it("caps the count and FLAGS it as a floor rather than rounding down silently", async () => {
    const h = makeDeps({
      credits: Array.from(
        { length: OWNER_PAYOUT_SUMMARY_MAX_COUNTED_ITEMS + 1 },
        (_, i) => credit({ id: `e${i}` }),
      ),
    });

    const out = await run(h);

    expect(out.pendingItemCount).toBe(OWNER_PAYOUT_SUMMARY_MAX_COUNTED_ITEMS);
    expect(out.itemCountExact).toBe(false);
  });
});

describe("getOwnerPayoutSummary — honest degradation", () => {
  it("an owner with NO payee is resolved-and-zero, not unknown and not an error", async () => {
    const h = makeDeps({ payeeRef: null });

    const out = await run(h);

    expect(out).toEqual({
      pendingPayoutCents: 0,
      pendingItemCount: 0,
      itemCountExact: true,
      currency: "usd",
      resolved: true,
      hasPayee: false,
    });
    expect(h.getBalance).not.toHaveBeenCalled();
  });

  it("a payee row that vanished between reads is treated as no payee, not a 500", async () => {
    const h = makeDeps({ payeeRow: null });

    const out = await run(h);

    expect(out.hasPayee).toBe(false);
    expect(out.resolved).toBe(true);
  });

  it("a FAILED ledger read is UNKNOWN — both figures null, never zero", async () => {
    const h = makeDeps({ ledgerFail: true });

    const out = await run(h);

    expect(out).toEqual({
      pendingPayoutCents: null,
      pendingItemCount: null,
      itemCountExact: false,
      currency: "usd",
      resolved: false,
      hasPayee: true,
    });
  });

  it("reports the swallowed ledger failure to Sentry, and logs at ERROR not warn", async () => {
    const h = makeDeps({ ledgerFail: true });

    await run(h);

    expect(h.logger.error).toHaveBeenCalledWith(
      "owner_payout_summary_ledger_read_failed",
      expect.objectContaining({ err: h.ledgerFailure, payeeId: PAYEE }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      h.ledgerFailure,
      expect.objectContaining({
        tags: { useCase: "getOwnerPayoutSummary", step: "readLedger" },
      }),
    );
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("a THROWING reporter never turns a degraded tile into a failed query", async () => {
    const h = makeDeps({ ledgerFail: true });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(run(h)).resolves.toMatchObject({ resolved: false });
  });

  it("a MISSING reporter never changes the result either", async () => {
    const h = makeDeps({ ledgerFail: true });
    (h.deps as { reportError?: unknown }).reportError = undefined;

    await expect(run(h)).resolves.toMatchObject({ resolved: false });
  });

  it("rejects an unknown input key (strict schema)", async () => {
    const h = makeDeps();

    await expect(
      getOwnerPayoutSummary(h.deps, {
        actorHumanId: ACTOR,
        orgId: ORG_ID,
        payeeId: PAYEE,
      }),
    ).rejects.toBeTruthy();
  });
});
