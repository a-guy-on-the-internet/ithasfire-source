import { describe, expect, it, vi } from "vitest";

import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { PayeeRecord } from "@th/ports/repos/payees";

import { reconcileConnectAccounts } from "../reconcile-connect-accounts";

const NOW = new Date("2026-08-06T22:00:00.000Z");

function payee(overrides: Partial<PayeeRecord> = {}): PayeeRecord {
  return {
    id: "payee-1",
    subjectType: "ORGANIZATION",
    subjectId: "org-1",
    stripeAccountId: "acct_1",
    status: "PENDING",
    payoutsEnabled: false,
    chargesEnabled: false,
    defaultCurrency: "usd",
    resaleNegativeBalanceCents: 0,
    resaleNegativeBalanceOpenedAt: null,
    resaleNegativeBalanceAgingStartsAt: null,
    resalePayoutBlockReason: null,
    resalePayoutBlockedAt: null,
    ...overrides,
  };
}

const LIVE_ENABLED = {
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  requirements: { currentlyDue: [], eventuallyDue: [], pastDue: [] },
  capabilities: { card_payments: "active", transfers: "active" },
};

function makeDeps(options?: {
  payees?: PayeeRecord[];
  live?: unknown;
  getStatus?: (input: { accountId: string }) => Promise<unknown>;
  restrictedCount?: number;
  restrictedCountThrows?: boolean;
  syncOutcome?: string;
  currentById?: (id: string) => PayeeRecord | null;
}) {
  const rows = options?.payees ?? [payee()];
  const syncCapabilities = vi.fn(async () => options?.syncOutcome ?? "applied");
  const listForCapabilityReconcile = vi.fn(async () => rows);
  const countRestrictedWithStripeAccount = vi.fn(async () => {
    if (options?.restrictedCountThrows) throw new Error("count_failed");
    return options?.restrictedCount ?? 0;
  });
  const getConnectAccountStatus = vi.fn(
    options?.getStatus ?? (async () => options?.live ?? LIVE_ENABLED),
  );
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reportError = vi.fn();

  return {
    deps: {
      repos: {
        payees: {
          listForCapabilityReconcile,
          countRestrictedWithStripeAccount,
          syncCapabilities,
          // Re-read immediately before the drift comparison, so the batch
          // snapshot can't be minutes stale. Defaults to the same row.
          getById: vi.fn(
            async (id: string) =>
              options?.currentById?.(id) ??
              rows.find((r) => r.id === id) ??
              null,
          ),
        },
      } as unknown as Repos,
      payments: { getConnectAccountStatus } as unknown as PaymentProcessorPort,
      clock: { now: () => NOW },
      logger: logger as never,
      reportError,
    },
    syncCapabilities,
    listForCapabilityReconcile,
    getConnectAccountStatus,
    logger,
    reportError,
  };
}

describe("reconcileConnectAccounts", () => {
  it("heals a row the webhook lost, and counts it as drift", async () => {
    // The incident: `account.updated` never landed, so the row says the org
    // can't be paid while Stripe says it can. Nothing but this job (or a
    // page load that happens to trigger the live-read write-back) fixes it.
    const { deps, syncCapabilities } = makeDeps({
      payees: [payee({ chargesEnabled: false, payoutsEnabled: false })],
    });

    const result = await reconcileConnectAccounts(deps);

    expect(result).toMatchObject({
      scanned: 1,
      drifted: 1,
      healedToPayable: 1,
      unchanged: 0,
      failed: 0,
    });
    expect(syncCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeAccountId: "acct_1",
        status: "ACTIVE",
        payoutsEnabled: true,
        observedAt: NOW,
      }),
    );
  });

  it("stamps observedAt BEFORE reading Stripe, so a concurrent webhook still wins", async () => {
    // The read-then-write race. If `observedAt` were taken after the Stripe
    // read, a genuine `account.updated` for a change that happens DURING our
    // read carries an earlier `event.created` than our stamp — so the ordering
    // guard would let this sweep's now-stale snapshot overwrite it. Stamping
    // first means the fresher event wins and we just miss the row this run.
    const startMs = Date.parse("2026-08-06T22:00:00.000Z");
    let current = startMs;
    // Wall clock, not a fixed tick list: the use case reads the clock several
    // times per row (budget check, stamp) and a list would make this assertion
    // depend on that call count rather than on the ordering it's testing.
    const clock = { now: () => new Date(current) };

    const { deps, syncCapabilities } = makeDeps({
      getStatus: async () => {
        current += 5_000; // time passes inside the read — the danger window
        return LIVE_ENABLED;
      },
    });

    await reconcileConnectAccounts({ ...deps, clock });

    expect(syncCapabilities.mock.calls[0]?.[0].observedAt).toEqual(
      new Date(startMs),
    );
  });

  it("reports zero drift when the webhook has been doing its job", async () => {
    const { deps, syncCapabilities } = makeDeps({
      payees: [
        payee({ status: "ACTIVE", chargesEnabled: true, payoutsEnabled: true }),
      ],
    });

    const result = await reconcileConnectAccounts(deps);

    expect(result).toMatchObject({ scanned: 1, unchanged: 1, drifted: 0 });
    // Still written: the write stamps `capabilitiesSyncedAt`, which is the
    // cursor that stops this row being re-read on every single run.
    expect(syncCapabilities).toHaveBeenCalledTimes(1);
  });

  it("counts a demotion as drift and as demotedFromPayable, NOT as healed", async () => {
    // The other direction: we believed an account was payable and it isn't.
    // This one is on a clock — `settlements.run-batch` runs 100 minutes after
    // this job in the same timezone and will SKIP them at the eligibility
    // gate, delaying (never losing) the payout until the capability is fixed.
    const { deps, logger } = makeDeps({
      payees: [
        payee({ status: "ACTIVE", chargesEnabled: true, payoutsEnabled: true }),
      ],
      live: {
        ...LIVE_ENABLED,
        payoutsEnabled: false,
        capabilities: { card_payments: "active", transfers: "pending" },
      },
    });

    const result = await reconcileConnectAccounts(deps);

    expect(result).toMatchObject({
      drifted: 1,
      healedToPayable: 0,
      demotedFromPayable: 1,
    });
    // error level, not info: this used to be a per-row info line that paged
    // nobody while a payout failed 100 minutes later.
    expect(logger.error).toHaveBeenCalledWith(
      "stripe_connect_reconcile_demoted_payable_payees",
      expect.objectContaining({ demotedFromPayable: 1 }),
    );
  });

  it("escalates BOTH directions when one run heals one payee and demotes another", async () => {
    // The branches must not be `if/else`: a run that does both would otherwise
    // report only whichever came first, and the two need different responders.
    const { deps, logger } = makeDeps({
      payees: [
        payee({ id: "heal-me", stripeAccountId: "acct_heal" }),
        payee({
          id: "demote-me",
          stripeAccountId: "acct_demote",
          status: "ACTIVE",
          chargesEnabled: true,
          payoutsEnabled: true,
        }),
      ],
      getStatus: async ({ accountId }) =>
        accountId === "acct_demote"
          ? {
              ...LIVE_ENABLED,
              payoutsEnabled: false,
              capabilities: { card_payments: "active", transfers: "pending" },
            }
          : LIVE_ENABLED,
    });

    const result = await reconcileConnectAccounts(deps);

    expect(result).toMatchObject({
      drifted: 2,
      healedToPayable: 1,
      demotedFromPayable: 1,
    });
    const escalated = logger.error.mock.calls.map((c) => c[0]);
    expect(escalated).toContain(
      "stripe_connect_reconcile_healed_blocked_payees",
    );
    expect(escalated).toContain(
      "stripe_connect_reconcile_demoted_payable_payees",
    );
  });

  it("does not escalate a demotion that the repo refused to write", async () => {
    // `skipped_stale` means the row was NOT changed, so nothing is newly
    // unpayable and paging would be a phantom incident.
    const { deps, logger } = makeDeps({
      payees: [
        payee({ status: "ACTIVE", chargesEnabled: true, payoutsEnabled: true }),
      ],
      live: {
        ...LIVE_ENABLED,
        payoutsEnabled: false,
        capabilities: { card_payments: "active", transfers: "pending" },
      },
      syncOutcome: "skipped_stale",
    });

    const result = await reconcileConnectAccounts(deps);

    expect(result).toMatchObject({ demotedFromPayable: 0, skipped: 1 });
    expect(logger.error).not.toHaveBeenCalledWith(
      "stripe_connect_reconcile_demoted_payable_payees",
      expect.anything(),
    );
  });

  it("honours the transfers capability, exactly like the webhook path", async () => {
    // If this sweep dropped `capabilities` it would be the MORE permissive
    // path, and — being the newest observation every night — it would beat the
    // webhook's stricter answer and quietly re-enable payouts to an account
    // that cannot receive a transfer.
    const { deps, syncCapabilities } = makeDeps({
      live: {
        ...LIVE_ENABLED,
        payoutsEnabled: true,
        capabilities: { card_payments: "active", transfers: "pending" },
      },
    });

    await reconcileConnectAccounts(deps);

    expect(syncCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PENDING", payoutsEnabled: false }),
    );
  });

  it("one bad account never aborts the sweep", async () => {
    const rows = [
      payee({ id: "p1", stripeAccountId: "acct_1" }),
      payee({ id: "p2", stripeAccountId: "acct_bad" }),
      payee({ id: "p3", stripeAccountId: "acct_3" }),
    ];
    const { deps, syncCapabilities, reportError } = makeDeps({
      payees: rows,
      getStatus: async ({ accountId }) => {
        if (accountId === "acct_bad") throw new Error("no_such_account");
        return LIVE_ENABLED;
      },
    });

    const result = await reconcileConnectAccounts(deps);

    expect(result).toMatchObject({ scanned: 3, failed: 1, drifted: 2 });
    // The other two still got written.
    expect(syncCapabilities).toHaveBeenCalledTimes(2);
    // And the failure is visible, not swallowed (repo error convention).
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { op: "reconcile-connect-accounts" },
    });
  });

  it("a throwing reporter never changes behaviour", async () => {
    const { deps } = makeDeps({
      getStatus: async () => {
        throw new Error("stripe_down");
      },
    });

    await expect(
      reconcileConnectAccounts({
        ...deps,
        reportError: () => {
          throw new Error("sentry_down");
        },
      }),
    ).resolves.toMatchObject({ failed: 1 });
  });

  it("surfaces RESTRICTED-with-account as a count, not per-row noise", async () => {
    // These cannot be healed — re-onboarding does not clear RESTRICTED — so
    // they must be visible without a long-departed org paging someone nightly.
    const { deps } = makeDeps({ restrictedCount: 3 });

    const result = await reconcileConnectAccounts(deps);

    expect(result.restrictedWithAccount).toBe(3);
  });

  it("still returns a result when the RESTRICTED count fails", async () => {
    const { deps, reportError } = makeDeps({ restrictedCountThrows: true });

    const result = await reconcileConnectAccounts(deps);

    expect(result.restrictedWithAccount).toBe(0);
    expect(result.scanned).toBe(1);
    expect(reportError).toHaveBeenCalled();
  });

  it("escalates to error level when it healed a blocked payee", async () => {
    // A successful run here is not "all good" — it means an org WAS blocked
    // and the webhook is the thing that needs fixing.
    const { deps, logger } = makeDeps({
      payees: [payee({ chargesEnabled: false, payoutsEnabled: false })],
    });

    await reconcileConnectAccounts(deps);

    expect(logger.error).toHaveBeenCalledWith(
      "stripe_connect_reconcile_healed_blocked_payees",
      expect.objectContaining({ healedToPayable: 1 }),
    );
  });

  it("stays at info level on a clean run", async () => {
    const { deps, logger } = makeDeps({
      payees: [
        payee({ status: "ACTIVE", chargesEnabled: true, payoutsEnabled: true }),
      ],
    });

    await reconcileConnectAccounts(deps);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "stripe_connect_reconcile_completed",
      expect.objectContaining({ drifted: 0 }),
    );
  });

  it("does NOT count a refused write as a heal", async () => {
    // The phantom-incident case. The row is listed at 22:20:00, an
    // `account.application.deauthorized` lands at 22:20:03 and flips it to
    // RESTRICTED, and our write at 22:20:05 is refused by the repo guard.
    // Counting the pre-write comparison anyway would page on-call with
    // "we restored payouts for 1 payee" having restored nothing.
    const { deps, logger } = makeDeps({
      payees: [payee({ chargesEnabled: false, payoutsEnabled: false })],
      syncOutcome: "skipped_restricted",
    });

    const result = await reconcileConnectAccounts(deps);

    expect(result).toMatchObject({
      scanned: 1,
      drifted: 0,
      healedToPayable: 0,
      skipped: 1,
    });
    expect(logger.error).not.toHaveBeenCalledWith(
      "stripe_connect_reconcile_healed_blocked_payees",
      expect.anything(),
    );
  });

  it("counters always add up to scanned", async () => {
    const { deps } = makeDeps({
      payees: [
        payee({ id: "ok" }),
        payee({ id: "no-account", stripeAccountId: null }),
      ],
    });

    const r = await reconcileConnectAccounts(deps);

    expect(r.unchanged + r.drifted + r.failed + r.skipped).toBe(r.scanned);
  });

  it("stops on the time budget instead of being cut off mid-run by the scheduler", async () => {
    // Cloud Scheduler's default attempt deadline is 180s. A run truncated by
    // the scheduler loses everything after the loop — including the alert that
    // says an organizer was blocked. Bounding ourselves means we always reach
    // our own reporting.
    let current = Date.parse("2026-08-06T22:20:00.000Z");
    const clock = { now: () => new Date(current) };
    const { deps, getConnectAccountStatus } = makeDeps({
      payees: [payee({ id: "a" }), payee({ id: "b" }), payee({ id: "c" })],
      getStatus: async () => {
        current += 60_000; // each read burns a minute
        return LIVE_ENABLED;
      },
    });

    const result = await reconcileConnectAccounts(
      { ...deps, clock },
      { limit: 200, maxDurationMs: 90_000, perAccountTimeoutMs: 20_000 },
    );

    expect(result.truncated).toBe(true);
    // Two reads fit inside 90s; the third is not attempted.
    expect(getConnectAccountStatus).toHaveBeenCalledTimes(2);
  });

  it("latches per-account reporting so a global Stripe failure isn't a flood", async () => {
    // An expired key or a Stripe outage fails every row. One Sentry event per
    // row buries the signal it exists to be.
    const rows = Array.from({ length: 20 }, (_, i) => payee({ id: `p${i}` }));
    const { deps, reportError } = makeDeps({
      payees: rows,
      getStatus: async () => {
        throw new Error("stripe_unavailable");
      },
    });

    const result = await reconcileConnectAccounts(deps);

    expect(result.failed).toBe(20);
    // 3 samples + 1 summary, not 20.
    expect(reportError).toHaveBeenCalledTimes(4);
    expect(reportError.mock.calls[3]?.[1]?.extra).toMatchObject({ failed: 20 });
  });

  it("counts restricted payees even when the run is truncated", async () => {
    // Counted before the loop, so a short run still reports the population
    // that nothing can heal.
    let current = Date.parse("2026-08-06T22:20:00.000Z");
    const clock = { now: () => new Date(current) };
    const { deps } = makeDeps({
      payees: [payee({ id: "a" }), payee({ id: "b" })],
      restrictedCount: 4,
      getStatus: async () => {
        current += 60_000;
        return LIVE_ENABLED;
      },
    });

    const result = await reconcileConnectAccounts(
      { ...deps, clock },
      { limit: 200, maxDurationMs: 30_000, perAccountTimeoutMs: 20_000 },
    );

    expect(result.truncated).toBe(true);
    expect(result.restrictedWithAccount).toBe(4);
  });

  it("does not claim to have measured drift when capabilities are forced", async () => {
    // With the dev override the Stripe read is discarded, so "drift" would
    // just mean "not already true/true" — and would fire a false incident.
    const { deps, logger } = makeDeps({
      payees: [payee({ chargesEnabled: false, payoutsEnabled: false })],
    });

    const result = await reconcileConnectAccounts({
      ...deps,
      forceConnectCapabilities: true,
    });

    expect(result).toMatchObject({ drifted: 0, healedToPayable: 0 });
    expect(logger.info).toHaveBeenCalledWith(
      "stripe_connect_reconcile_completed_forced",
      expect.anything(),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("compares against a FRESH read, so a webhook that arrived on time isn't reported as lost", async () => {
    // The last rows of a 200-row batch are compared against a snapshot up to
    // two minutes old. A healthy `account.updated` landing in that window would
    // otherwise make us compare against the pre-webhook state and page on-call
    // with "lost webhook detected" for a webhook that was never lost.
    const listed = payee({ chargesEnabled: false, payoutsEnabled: false });
    const { deps, logger } = makeDeps({
      payees: [listed],
      // By the time we get to it, the webhook has already fixed the row.
      currentById: () =>
        payee({ status: "ACTIVE", chargesEnabled: true, payoutsEnabled: true }),
    });

    const result = await reconcileConnectAccounts(deps);

    expect(result).toMatchObject({ drifted: 0, healedToPayable: 0 });
    expect(logger.error).not.toHaveBeenCalledWith(
      "stripe_connect_reconcile_healed_blocked_payees",
      expect.anything(),
    );
  });

  it("bounds each Stripe read so one hung call can't blow the scheduler deadline", async () => {
    // The wall-clock budget is only checked between rows, so an unbounded
    // in-flight call is the one thing that can still overshoot.
    const { deps, reportError } = makeDeps({
      getStatus: () => new Promise(() => {}), // never settles
    });

    const result = await reconcileConnectAccounts(deps, {
      limit: 1,
      maxDurationMs: 120_000,
      perAccountTimeoutMs: 1_000,
    });

    expect(result).toMatchObject({ failed: 1, scanned: 1 });
    expect(reportError).toHaveBeenCalled();
  }, 10_000);

  it("reports scanned as rows PROCESSED, with listed carrying the batch size", async () => {
    let current = Date.parse("2026-08-06T22:20:00.000Z");
    const clock = { now: () => new Date(current) };
    const { deps } = makeDeps({
      payees: [payee({ id: "a" }), payee({ id: "b" }), payee({ id: "c" })],
      getStatus: async () => {
        current += 60_000;
        return LIVE_ENABLED;
      },
    });

    const r = await reconcileConnectAccounts(
      { ...deps, clock },
      { limit: 200, maxDurationMs: 90_000, perAccountTimeoutMs: 20_000 },
    );

    expect(r.truncated).toBe(true);
    expect(r.listed).toBe(3);
    // The invariant must hold on a TRUNCATED run too — that is the case where
    // reporting the batch size as "scanned" would most mislead.
    expect(r.unchanged + r.drifted + r.failed + r.skipped).toBe(r.scanned);
    expect(r.scanned).toBeLessThan(r.listed);
  });

  it("passes the batch limit through and defaults it", async () => {
    const { deps, listForCapabilityReconcile } = makeDeps();

    await reconcileConnectAccounts(deps, { limit: 50 });
    expect(listForCapabilityReconcile).toHaveBeenCalledWith({ limit: 50 });

    await reconcileConnectAccounts(deps);
    expect(listForCapabilityReconcile).toHaveBeenLastCalledWith({ limit: 200 });
  });

  it("skips a row with no Stripe account instead of calling Stripe", async () => {
    const { deps, getConnectAccountStatus } = makeDeps({
      payees: [payee({ stripeAccountId: null })],
    });

    const result = await reconcileConnectAccounts(deps);

    expect(getConnectAccountStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, drifted: 0, failed: 0 });
  });

  it("reads Stripe sequentially, so the sweep can't exhaust the rate limit", async () => {
    // A parallel sweep is the kind of thing that takes checkout down at 22:00.
    let inFlight = 0;
    let maxInFlight = 0;
    const { deps } = makeDeps({
      payees: [payee({ id: "a" }), payee({ id: "b" }), payee({ id: "c" })],
      getStatus: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return LIVE_ENABLED;
      },
    });

    await reconcileConnectAccounts(deps);

    expect(maxInFlight).toBe(1);
  });
});
