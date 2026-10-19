import { describe, expect, it, vi, type Mock } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { LoggerPort } from "@th/ports/logger";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type {
  PayoutTermsLineRecord,
  PayoutTermsRecord,
} from "@th/ports/repos/payout-terms";
import type { TxRepos } from "@th/ports/repos";

import {
  aggregateItems,
  buildFeePolicySnapshot,
  computeOrderAmounts,
  loadPayoutTermsContext,
  type TicketTypeSummary,
} from "../checkout-helpers";

/**
 * `loadPayoutTermsContext` is THE fee-policy read for every order path —
 * createCheckout's routing probe, the paid path, updateOrderItems AND
 * claimFreeTickets.
 *
 * The cold branch under test exists because `publishEvent` no longer requires a
 * fee policy for a FREE event: such an event PUBLISHES with nothing pinned onto
 * its primary terms, and then sells $0 tickets through `claimFreeTickets`. If
 * this function hard-failed on the missing pin, the fix for the organizer's
 * publish outage would simply have relocated the outage to the buyer.
 */

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const TERMS_ID = "00000000-0000-4000-8000-0000000000t1";
const NOW = new Date("2026-01-01T00:00:00.000Z");

function buildFeePolicy(overrides: Partial<FeePolicyRecord> = {}) {
  return {
    id: "fee-policy-global",
    scopeType: "GLOBAL",
    scopeId: null,
    status: "ACTIVE",
    version: 3,
    effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
    effectiveTo: null,
    buyerFeePct: 450,
    maxFeeCents: null,
    minFeeCents: 100,
    platformFixedCents: 0,
    feeMode: "PASS_THROUGH",
    processsorFeePct: 290,
    processorFixedCents: 30,
    payoutPct: 9200,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
    ...overrides,
  } as FeePolicyRecord;
}

function buildTerms(overrides: Partial<PayoutTermsRecord> = {}) {
  return {
    id: TERMS_ID,
    kind: "PRIMARY",
    status: "ACTIVE",
    feeMode: "PASS_THROUGH",
    feePolicyId: null,
    isDefault: false,
    settlementCurrency: "usd",
    payoutSchedule: "WEEK_OF_EVENT",
    resaleProcessingFeeConfigRef: null,
    resalePayoutReleaseDays: 0,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as PayoutTermsRecord;
}

const LINE = {
  id: "line-1",
  payoutTermsId: TERMS_ID,
  payeeId: "payee-1",
  ticketTypeId: null,
  percent: 100,
  floorCents: 0,
  capPercent: null,
  priority: 0,
  rounding: "FLOOR",
  requiresConfirmation: false,
  confirmationStatus: null,
  confirmedAt: null,
  counterPercentBps: null,
  counterNote: null,
} as PayoutTermsLineRecord;

type FakeOptions = {
  terms?: PayoutTermsRecord;
  lines?: PayoutTermsLineRecord[];
  /** Row returned by `feePolicies.getById` for a pinned id. */
  pinned?: FeePolicyRecord | null;
  /** Row returned by the scope walk, keyed by scope. */
  scoped?: Partial<Record<"EVENT" | "ORG" | "GLOBAL", FeePolicyRecord | null>>;
  orgId?: string | null;
};

/** The shared fake, narrowed so `.error` is addressable as a spy. */
function makeLogger() {
  return createTestLogger() as LoggerPort & { error: Mock };
}

function makeTx(options: FakeOptions = {}) {
  const mocks = {
    listByEvent: vi.fn(async () => [options.terms ?? buildTerms()]),
    listLines: vi.fn(async () => options.lines ?? [LINE]),
    getById: vi.fn(async () => options.pinned ?? null),
    resolveEffective: vi.fn(
      async ({ scopeType }: { scopeType: "EVENT" | "ORG" | "GLOBAL" }) =>
        options.scoped?.[scopeType] ?? null,
    ),
    eventsGetById: vi.fn(async () => ({
      id: EVENT_ID,
      orgId: options.orgId === undefined ? ORG_ID : options.orgId,
    })),
  };

  const tx = {
    payoutTerms: {
      listByEvent: mocks.listByEvent,
      listLines: mocks.listLines,
    },
    feePolicies: {
      getById: mocks.getById,
      resolveEffective: mocks.resolveEffective,
    },
    events: { getById: mocks.eventsGetById },
  } as unknown as TxRepos;

  return { tx, mocks };
}

describe("loadPayoutTermsContext", () => {
  it("uses the PINNED policy without touching the scope walk (hot path)", async () => {
    const pinned = buildFeePolicy({ id: "pinned-policy", scopeType: "EVENT" });
    const { tx, mocks } = makeTx({
      terms: buildTerms({ feePolicyId: "pinned-policy" }),
      pinned,
    });

    const ctx = await loadPayoutTermsContext(tx, EVENT_ID, NOW, {});

    expect(ctx.feePolicy).toEqual(pinned);
    expect(mocks.resolveEffective).not.toHaveBeenCalled();
    expect(mocks.eventsGetById).not.toHaveBeenCalled();
  });

  it("SELF-HEALS an unpinned row by re-running the EVENT → ORG → GLOBAL walk", async () => {
    // The free-event-published-before-any-policy-existed case. Once ops adds a
    // GLOBAL policy the free claim path works again with no data repair.
    const globalPolicy = buildFeePolicy();
    const { tx, mocks } = makeTx({ scoped: { GLOBAL: globalPolicy } });

    const ctx = await loadPayoutTermsContext(tx, EVENT_ID, NOW, {});

    expect(ctx.feePolicy).toEqual(globalPolicy);
    expect(mocks.resolveEffective).toHaveBeenCalledTimes(3);
    expect(mocks.resolveEffective).toHaveBeenNthCalledWith(1, {
      scopeType: "EVENT",
      scopeId: EVENT_ID,
      at: NOW,
    });
    expect(mocks.resolveEffective).toHaveBeenNthCalledWith(2, {
      scopeType: "ORG",
      scopeId: ORG_ID,
      at: NOW,
    });
    expect(mocks.resolveEffective).toHaveBeenNthCalledWith(3, {
      scopeType: "GLOBAL",
      scopeId: null,
      at: NOW,
    });
  });

  it("skips the ORG scope for a human-owned event", async () => {
    const { tx, mocks } = makeTx({
      orgId: null,
      scoped: { GLOBAL: buildFeePolicy() },
    });

    await loadPayoutTermsContext(tx, EVENT_ID, NOW, {});

    expect(mocks.resolveEffective).toHaveBeenCalledTimes(2);
    expect(
      mocks.resolveEffective.mock.calls.map(
        ([arg]) => (arg as { scopeType: string }).scopeType,
      ),
    ).toEqual(["EVENT", "GLOBAL"]);
  });

  it("throws AGREEMENT_MISSING_FEE_POLICY when unpinned and nothing resolves", async () => {
    const { tx } = makeTx({ scoped: {} });

    await expect(
      loadPayoutTermsContext(tx, EVENT_ID, NOW, {}),
    ).rejects.toMatchObject({ code: "AGREEMENT_MISSING_FEE_POLICY" });
  });

  describe("a DANGLING pin is a fault, never a heal", () => {
    // A pin exists so an agreement keeps the economics it was signed under.
    // Substituting a different VERSION because the pinned row vanished would be
    // a silent mispricing on a money path, so the re-resolve must NOT cover
    // this case — behaviour stays exactly as it was before the free-event work.

    it("throws FEE_POLICY_NOT_FOUND without attempting a re-resolve", async () => {
      const { tx, mocks } = makeTx({
        terms: buildTerms({ feePolicyId: "deleted-policy" }),
        pinned: null,
        // A GLOBAL policy IS available — the point is that it must not be used.
        scoped: { GLOBAL: buildFeePolicy() },
      });

      await expect(
        loadPayoutTermsContext(tx, EVENT_ID, NOW, {}),
      ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });

      expect(mocks.resolveEffective).not.toHaveBeenCalled();
    });

    it("reports the dangling pin as a data-integrity fault", async () => {
      const reportError = vi.fn();
      const logger = makeLogger();
      const { tx } = makeTx({
        terms: buildTerms({ feePolicyId: "deleted-policy" }),
        pinned: null,
      });

      await expect(
        loadPayoutTermsContext(tx, EVENT_ID, NOW, { logger, reportError }),
      ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ fault: "dangling_pin" }),
          extra: expect.objectContaining({
            payoutTermsId: TERMS_ID,
            feePolicyId: "deleted-policy",
          }),
        }),
      );
      expect(logger.error).toHaveBeenCalled();
    });

    it("a throwing reporter does not change the thrown code", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const { tx } = makeTx({
        terms: buildTerms({ feePolicyId: "deleted-policy" }),
        pinned: null,
      });

      await expect(
        loadPayoutTermsContext(tx, EVENT_ID, NOW, { reportError }),
      ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });
    });
  });

  describe("the cold-path scope walk rethrows a repo failure", () => {
    // The walk used to swallow a per-scope repo failure and continue. Inside
    // `repos.tx` that could only ever fabricate a `null` (Postgres aborts the
    // session on the first failed statement, so ORG/GLOBAL failed too), and
    // the buyer was then told AGREEMENT_MISSING_FEE_POLICY — a CONFIGURATION
    // cause — for a transient DB fault. The fault now propagates, and is still
    // reported against the scope that broke.

    it("rethrows a per-scope repo failure instead of healing via GLOBAL", async () => {
      const boom = new Error("connection terminated unexpectedly");
      const reportError = vi.fn();
      const logger = makeLogger();
      const { tx, mocks } = makeTx({ scoped: { GLOBAL: buildFeePolicy() } });
      mocks.resolveEffective.mockRejectedValueOnce(boom);

      await expect(
        loadPayoutTermsContext(tx, EVENT_ID, NOW, { logger, reportError }),
      ).rejects.toBe(boom);

      // The walk stopped at the failing scope; ORG and GLOBAL were never read.
      expect(mocks.resolveEffective).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: expect.objectContaining({
            resolver: "resolveScopedFeePolicy",
            scopeType: "EVENT",
            source: "loadPayoutTermsContext",
          }),
        }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        "fee_policy_resolution_failed",
        expect.objectContaining({ err: boom }),
      );
    });

    it("surfaces the repo error, never AGREEMENT_MISSING_FEE_POLICY, when the fault is a DB fault", async () => {
      const boom = new Error("connection terminated unexpectedly");
      const reportError = vi.fn();
      const { tx, mocks } = makeTx({ scoped: {} });
      mocks.resolveEffective.mockRejectedValueOnce(boom);

      const outcome = await loadPayoutTermsContext(tx, EVENT_ID, NOW, {
        reportError,
      }).then(
        () => "resolved",
        (err: unknown) => err,
      );

      expect(outcome).toBe(boom);
      expect(outcome).not.toMatchObject({ code: "AGREEMENT_MISSING_FEE_POLICY" });
      expect(reportError).toHaveBeenCalledWith(boom, expect.anything());
    });

    it("a throwing reporter never replaces the real error", async () => {
      const boom = new Error("boom");
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const { tx, mocks } = makeTx({ scoped: { GLOBAL: buildFeePolicy() } });
      mocks.resolveEffective.mockRejectedValueOnce(boom);

      await expect(
        loadPayoutTermsContext(tx, EVENT_ID, NOW, { reportError }),
      ).rejects.toBe(boom);
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not report when the walk resolves cleanly", async () => {
      const reportError = vi.fn();
      const { tx } = makeTx({ scoped: { GLOBAL: buildFeePolicy() } });

      await loadPayoutTermsContext(tx, EVENT_ID, NOW, { reportError });

      expect(reportError).not.toHaveBeenCalled();
    });
  });

  it("still throws PRIMARY_AGREEMENT_MISSING before any fee-policy work", async () => {
    const { tx, mocks } = makeTx({
      terms: buildTerms({ status: "PENDING" }),
    });

    await expect(
      loadPayoutTermsContext(tx, EVENT_ID, NOW, {}),
    ).rejects.toMatchObject({ code: "PRIMARY_AGREEMENT_MISSING" });
    expect(mocks.resolveEffective).not.toHaveBeenCalled();
  });

  it("still throws AGREEMENT_MISSING_LINES when a policy resolves but lines are empty", async () => {
    const { tx } = makeTx({
      lines: [],
      scoped: { GLOBAL: buildFeePolicy() },
    });

    await expect(
      loadPayoutTermsContext(tx, EVENT_ID, NOW, {}),
    ).rejects.toMatchObject({ code: "AGREEMENT_MISSING_LINES" });
  });
});

/**
 * THE checkout cold path, end to end, after ABSORB was removed
 * (docs/decisions/absorb-removed.md). Unpinned, modeless terms (booking terms
 * finalized onto a live event, say) re-resolve EVENT → ORG → GLOBAL here; a
 * legacy ABSORB row found by that walk used to price the sale ABSORB. The walk
 * still returns the row (its RATES apply), but the sale is fees-on-top and the
 * order records that.
 */
describe("checkout cold path — a resolved ABSORB policy never prices a sale ABSORB", () => {
  const TT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ticketTypes = new Map<string, TicketTypeSummary>([
    [
      TT_ID,
      {
        id: TT_ID,
        priceCents: 2000,
        pricingMode: "FIXED",
        minimumCents: null,
        seatSectionId: null,
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      } as TicketTypeSummary,
    ],
  ]);
  const absorbOrgPolicy = buildFeePolicy({
    id: "org-absorb",
    scopeType: "ORG",
    scopeId: ORG_ID,
    feeMode: "ABSORB",
    buyerFeePct: 0.05,
    minFeeCents: 0,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
  });

  it.each([
    ["modeless", null],
    ["saying ABSORB themselves", "ABSORB"],
  ] as const)(
    "unpinned terms %s + an ACTIVE ORG ABSORB policy: fees on top",
    async (_label, termsMode) => {
      const { tx } = makeTx({
        terms: buildTerms({ feeMode: termsMode, feePolicyId: null }),
        scoped: { ORG: absorbOrgPolicy, GLOBAL: buildFeePolicy() },
      });

      const ctx = await loadPayoutTermsContext(tx, EVENT_ID, NOW, {});
      // The walk still finds the legacy row: its rates price the sale.
      expect(ctx.feePolicy.id).toBe("org-absorb");

      const computation = computeOrderAmounts(
        aggregateItems([{ ticketTypeId: TT_ID, qty: 2 }] as never),
        ticketTypes,
        ctx,
        { now: NOW },
      );

      expect(computation.effectiveFeeMode).toBe("PASS_THROUGH");
      // 5% of 2000 = 100c per ticket, charged to the buyer on top of face.
      expect(computation.feesPlatformCents).toBe(200);
      expect(computation.buyerFeesCents).toBe(200);
      expect(computation.paymentIntentAmountCents).toBe(4000 + 200);
      for (const item of computation.items) {
        const meta = item.meta as Record<string, unknown>;
        expect(meta.effectiveFeeMode).toBe("PASS_THROUGH");
        expect(meta.buyerTotalCents).toBe(2100);
      }
      // The snapshot the order page reads the mode back from.
      expect(buildFeePolicySnapshot(ctx, NOW)).toMatchObject({
        feePolicyId: "org-absorb",
        feeMode: "PASS_THROUGH",
      });
      // And the credit rule settlement reads back (`computeAgreementBasis`):
      // every snapshot this builder makes marks the sale FULL_PRICE (owner
      // ruling 2026-10-11, platform-fee-charged-once spec FR-001).
      expect(buildFeePolicySnapshot(ctx, NOW).organiserCredit).toBe(
        "FULL_PRICE",
      );
    },
  );
});
