import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { PayeeRecord } from "@th/ports/repos/payees";

import { getConnectStatus } from "../get-connect-status";
import {
  deriveConnectCapabilities,
  syncConnectAccount,
  syncConnectAccountBestEffort,
} from "../sync-connect-account";

const ACTOR_HUMAN_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const PAYEE_ID = "00000000-0000-4000-8000-0000000000aa";
const ACCT = "acct_live";
const OBSERVED_AT = new Date("2026-08-06T12:00:00.000Z");

function makePayee(overrides: Partial<PayeeRecord> = {}): PayeeRecord {
  return {
    id: PAYEE_ID,
    subjectType: "ORGANIZATION",
    subjectId: ORG_ID,
    stripeAccountId: ACCT,
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

function makeRepos(
  payee: PayeeRecord = makePayee(),
  outcome: string = "applied",
) {
  const syncCapabilities = vi.fn(async () => outcome);
  const repos = {
    payees: {
      syncCapabilities,
      getBySubject: vi.fn(async () => ({ id: payee.id })),
      getById: vi.fn(async () => payee),
    },
    orgs: {
      // `requireOrgMembership` reads membership through authz, not repos; the
      // deps below stub authz directly.
    },
  } as unknown as Repos;
  return { repos, syncCapabilities };
}

// ── The derivation itself ────────────────────────────────────────────────────

describe("deriveConnectCapabilities", () => {
  it("prefers account-level flags over capabilities for charges", () => {
    // The Payments page renders `charges_enabled` / `payouts_enabled`, so the
    // Payee row must be derived from the same fields. Capabilities said "not
    // yet"; the account says "yes".
    expect(
      deriveConnectCapabilities({
        stripeAccountId: ACCT,
        chargesEnabled: true,
        payoutsEnabled: true,
        capabilities: { card_payments: "pending", transfers: "active" },
      }),
    ).toEqual({ chargesEnabled: true, payoutsEnabled: true, status: "ACTIVE" });
  });

  it("does NOT let payouts_enabled override an inactive transfers capability", () => {
    // `payouts_enabled` answers "can Stripe pay this account's balance out to
    // its bank?". `transfers` answers "can WE move money to it?" — and the
    // latter is what `Payee.payoutsEnabled` gates: it is the only precondition
    // before `createTransfer` in settlements/run-batch.ts, as well as
    // the publish gate. Trusting the account-level flag alone would let a paid
    // event publish and sell, then fail at settlement with "destination account
    // needs the transfers capability" — sold inventory, no payout.
    expect(
      deriveConnectCapabilities({
        stripeAccountId: ACCT,
        chargesEnabled: true,
        payoutsEnabled: true,
        capabilities: { card_payments: "active", transfers: "pending" },
      }),
    ).toEqual({
      chargesEnabled: true,
      payoutsEnabled: false,
      status: "PENDING",
    });
  });

  it("does not invent a transfers restriction when capabilities are absent", () => {
    // A stub/e2e processor, or a payload that omits capabilities: "no
    // information" must not read as "capability inactive", or every such
    // environment would silently lose the ability to publish paid events.
    expect(
      deriveConnectCapabilities({
        stripeAccountId: ACCT,
        chargesEnabled: true,
        payoutsEnabled: true,
      }),
    ).toEqual({ chargesEnabled: true, payoutsEnabled: true, status: "ACTIVE" });
  });

  it("falls back to capabilities when account-level flags are absent", () => {
    expect(
      deriveConnectCapabilities({
        stripeAccountId: ACCT,
        capabilities: { card_payments: "active", transfers: "active" },
      }),
    ).toEqual({ chargesEnabled: true, payoutsEnabled: true, status: "ACTIVE" });

    expect(
      deriveConnectCapabilities({
        stripeAccountId: ACCT,
        capabilities: { card_payments: "active", transfers: "pending" },
      }),
    ).toEqual({
      chargesEnabled: true,
      payoutsEnabled: false,
      status: "PENDING",
    });
  });

  it("treats unknown capability statuses as not-active rather than throwing", () => {
    // Stripe ships `unrequested` / `provisioning` / `disabled`. The old Zod
    // enum rejected those outright, which dropped the whole event.
    expect(
      deriveConnectCapabilities({
        stripeAccountId: ACCT,
        capabilities: { card_payments: "unrequested", transfers: "disabled" },
      }),
    ).toEqual({
      chargesEnabled: false,
      payoutsEnabled: false,
      status: "PENDING",
    });
  });

  it("only reports ACTIVE when both charges and payouts are enabled", () => {
    expect(
      deriveConnectCapabilities({
        stripeAccountId: ACCT,
        chargesEnabled: true,
        payoutsEnabled: false,
      }).status,
    ).toBe("PENDING");
  });

  it("forceEnabled short-circuits everything (dev seed bypass)", () => {
    expect(
      deriveConnectCapabilities(
        {
          stripeAccountId: ACCT,
          chargesEnabled: false,
          payoutsEnabled: false,
          capabilities: { card_payments: "inactive", transfers: "inactive" },
        },
        true,
      ),
    ).toEqual({ chargesEnabled: true, payoutsEnabled: true, status: "ACTIVE" });
  });
});

// ── The write ────────────────────────────────────────────────────────────────

describe("syncConnectAccount", () => {
  it("passes observedAt through so the repo can order-guard the write", async () => {
    const { repos, syncCapabilities } = makeRepos();

    await syncConnectAccount(
      { repos },
      {
        account: {
          stripeAccountId: ACCT,
          chargesEnabled: true,
          payoutsEnabled: true,
          defaultCurrency: "cad",
        },
        observedAt: OBSERVED_AT,
        source: "webhook",
      },
    );

    expect(syncCapabilities).toHaveBeenCalledWith({
      stripeAccountId: ACCT,
      status: "ACTIVE",
      chargesEnabled: true,
      payoutsEnabled: true,
      defaultCurrency: "cad",
      requirements: null,
      observedAt: OBSERVED_AT,
    });
  });

  it("defaults currency to usd when the payload omits it", async () => {
    const { repos, syncCapabilities } = makeRepos();

    await syncConnectAccount(
      { repos },
      {
        account: { stripeAccountId: ACCT, chargesEnabled: true },
        observedAt: OBSERVED_AT,
        source: "webhook",
      },
    );

    expect(syncCapabilities.mock.calls[0]?.[0]).toMatchObject({
      defaultCurrency: "usd",
    });
  });
});

describe("syncConnectAccountBestEffort", () => {
  it("swallows a write failure but reports it (repo error convention)", async () => {
    const reportError = vi.fn();
    const repos = {
      payees: {
        syncCapabilities: vi.fn(async () => {
          throw new Error("db_down");
        }),
      },
    } as unknown as Repos;

    const result = await syncConnectAccountBestEffort(
      { repos, reportError },
      {
        account: { stripeAccountId: ACCT, chargesEnabled: true },
        observedAt: OBSERVED_AT,
        source: "live-read",
      },
    );

    expect(result).toBeNull();
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { area: "stripe-connect", source: "live-read" },
    });
  });

  it("a throwing reporter never changes behaviour", async () => {
    const repos = {
      payees: {
        syncCapabilities: vi.fn(async () => {
          throw new Error("db_down");
        }),
      },
    } as unknown as Repos;

    await expect(
      syncConnectAccountBestEffort(
        {
          repos,
          reportError: () => {
            throw new Error("sentry_down");
          },
        },
        {
          account: { stripeAccountId: ACCT, chargesEnabled: true },
          observedAt: OBSERVED_AT,
          source: "live-read",
        },
      ),
    ).resolves.toBeNull();
  });
});

// ── The regression the incident needed ───────────────────────────────────────

describe("getConnectStatus reconciliation", () => {
  function makeStatusDeps(options?: {
    payee?: PayeeRecord;
    stripeThrows?: boolean;
    live?: { chargesEnabled: boolean; payoutsEnabled: boolean };
    capabilities?: { card_payments?: string; transfers?: string } | null;
    outcome?: string;
  }) {
    const payee = options?.payee ?? makePayee();
    const { repos, syncCapabilities } = makeRepos(payee, options?.outcome);
    const reportError = vi.fn();
    const getConnectAccountStatus = vi.fn(async () => {
      if (options?.stripeThrows) throw new Error("stripe_unavailable");
      return {
        chargesEnabled: options?.live?.chargesEnabled ?? true,
        payoutsEnabled: options?.live?.payoutsEnabled ?? true,
        detailsSubmitted: true,
        requirements: { currentlyDue: [], eventuallyDue: [], pastDue: [] },
        capabilities: options?.capabilities ?? null,
      };
    });

    return {
      deps: {
        repos: {
          ...repos,
          authz: undefined,
        } as unknown as Repos,
        payments: { getConnectAccountStatus } as never,
        reportError,
        clock: { now: () => OBSERVED_AT },
      },
      syncCapabilities,
      reportError,
      getConnectAccountStatus,
    };
  }

  it("writes live Stripe state back onto a stale Payee row", async () => {
    // THE INCIDENT. The row says PENDING/false/false (a missed
    // `account.updated`), Stripe says the account is fully enabled, and the
    // publish gate reads the row. Before this write-back, loading the Payments
    // page a thousand times would never have healed it.
    const stale = makePayee({
      status: "PENDING",
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    const { deps, syncCapabilities } = makeStatusDeps({ payee: stale });

    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    expect(result).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    expect(syncCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeAccountId: ACCT,
        status: "ACTIVE",
        chargesEnabled: true,
        payoutsEnabled: true,
        observedAt: OBSERVED_AT,
      }),
    );
  });

  it("persists a downgrade too, not just a promotion", async () => {
    const active = makePayee({
      status: "ACTIVE",
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    const { deps, syncCapabilities } = makeStatusDeps({
      payee: active,
      live: { chargesEnabled: true, payoutsEnabled: false },
    });

    await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    expect(syncCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PENDING", payoutsEnabled: false }),
    );
  });

  it("reports the Stripe failure it swallows, and does NOT write back stale data", async () => {
    const stale = makePayee({ chargesEnabled: false, payoutsEnabled: false });
    const { deps, syncCapabilities, reportError } = makeStatusDeps({
      payee: stale,
      stripeThrows: true,
    });

    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    // Degrades to the DB row rather than failing the page…
    expect(result).toMatchObject({
      connected: true,
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    // …but the swallow is visible (logger.warn is not captured by Sentry)…
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { area: "stripe-connect", op: "get-connect-status" },
    });
    // …and a Stripe outage must never be persisted as truth.
    expect(syncCapabilities).not.toHaveBeenCalled();
  });

  it("forwards capabilities to the write-back, so the live read is not the more permissive path", async () => {
    // If this regressed, `deriveConnectCapabilities` would see no capabilities,
    // skip the transfers AND, and write payoutsEnabled: true — and because a
    // live read is always the newest observation, it would beat the webhook's
    // stricter answer every time.
    const { deps, syncCapabilities } = makeStatusDeps({
      live: { chargesEnabled: true, payoutsEnabled: true },
      capabilities: { card_payments: "active", transfers: "pending" },
    });

    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    expect(syncCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PENDING", payoutsEnabled: false }),
    );
    // …and the page reports the same thing it just persisted.
    expect(result).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: false,
    });
  });

  it("returns the derived values, so the page and the publish gate cannot disagree", async () => {
    const { deps } = makeStatusDeps({
      live: { chargesEnabled: true, payoutsEnabled: true },
      capabilities: { card_payments: "active", transfers: "active" },
    });

    await expect(
      getConnectStatus(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
      }),
    ).resolves.toMatchObject({ chargesEnabled: true, payoutsEnabled: true });
  });

  it("reports the ROW, not Stripe, when the write was skipped as RESTRICTED", async () => {
    // THE INCIDENT, second door. A deauthorized payee that re-onboards keeps
    // status RESTRICTED, so the repo refuses the write. Live Stripe says
    // "all good". If we returned the derived values the Payments page would go
    // green and the Publish CTA would appear, while the gate — which reads the
    // row — refuses. Report what the gate will actually see.
    const restricted = makePayee({
      status: "RESTRICTED",
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    const { deps } = makeStatusDeps({
      payee: restricted,
      outcome: "skipped_restricted",
      live: { chargesEnabled: true, payoutsEnabled: true },
      capabilities: { card_payments: "active", transfers: "active" },
    });

    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    expect(result).toMatchObject({
      connected: true,
      chargesEnabled: false,
      payoutsEnabled: false,
    });
  });

  it("reports the ROW when a newer observation already won the ordering guard", async () => {
    const row = makePayee({ chargesEnabled: false, payoutsEnabled: false });
    const { deps } = makeStatusDeps({
      payee: row,
      outcome: "skipped_stale",
      live: { chargesEnabled: true, payoutsEnabled: true },
      capabilities: { card_payments: "active", transfers: "active" },
    });

    await expect(
      getConnectStatus(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
      }),
    ).resolves.toMatchObject({ chargesEnabled: false, payoutsEnabled: false });
  });

  it("re-reads the row on skipped_stale, so a mid-flight webhook is reported, not the pre-read snapshot", async () => {
    // The stale window: we read the row (false/false), call Stripe, and while
    // that call is in flight an `account.updated` with a newer event.created
    // lands and flips the row to true/true. Our write then loses the ordering
    // guard (`skipped_stale`) — correct — but reporting the PRE-READ snapshot
    // would render "payouts off" on a page whose publish gate (reading the
    // row) says on: the incident's divergence, re-opened for the length of the
    // read window. The fix re-reads, exactly like the reconcile sweep does.
    const preRead = makePayee({ chargesEnabled: false, payoutsEnabled: false });
    const afterWebhook = makePayee({
      status: "ACTIVE",
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    const { deps } = makeStatusDeps({
      payee: preRead,
      outcome: "skipped_stale",
      live: { chargesEnabled: true, payoutsEnabled: true },
      capabilities: { card_payments: "active", transfers: "active" },
    });
    const getById = (
      deps.repos.payees as unknown as { getById: ReturnType<typeof vi.fn> }
    ).getById;
    getById
      .mockResolvedValueOnce(preRead) // the initial fetch
      .mockResolvedValueOnce(afterWebhook); // the post-skip re-read

    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    expect(getById).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
    });
  });

  it("does not write back when the subject has no Connect account", async () => {
    const { deps, syncCapabilities, getConnectAccountStatus } = makeStatusDeps({
      payee: makePayee({ stripeAccountId: null }),
    });

    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    expect(result.connected).toBe(false);
    expect(getConnectAccountStatus).not.toHaveBeenCalled();
    expect(syncCapabilities).not.toHaveBeenCalled();
  });

  it("forceConnectCapabilities keeps a seeded dev account enabled", async () => {
    const { deps, syncCapabilities } = makeStatusDeps({
      live: { chargesEnabled: false, payoutsEnabled: false },
    });

    await getConnectStatus(
      { ...deps, forceConnectCapabilities: true },
      { actorHumanId: ACTOR_HUMAN_ID, humanId: ACTOR_HUMAN_ID },
    );

    expect(syncCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ACTIVE", payoutsEnabled: true }),
    );
  });

  // A money screen states what Stripe reports. The override keeps the page and
  // the publish gate in step, so the derived values stay forced; Stripe's own
  // answer rides alongside so the page can say the account is not set up.
  it("reports Stripe's own values when the dev override changed the answer", async () => {
    const { deps } = makeStatusDeps({
      live: { chargesEnabled: false, payoutsEnabled: false },
    });

    const result = await getConnectStatus(
      { ...deps, forceConnectCapabilities: true },
      { actorHumanId: ACTOR_HUMAN_ID, humanId: ACTOR_HUMAN_ID },
    );

    expect(result).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      capabilityOverride: {
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
      },
    });
  });

  it("reports the override when it changed only one of the two", async () => {
    const { deps } = makeStatusDeps({
      live: { chargesEnabled: true, payoutsEnabled: false },
    });

    const result = await getConnectStatus(
      { ...deps, forceConnectCapabilities: true },
      { actorHumanId: ACTOR_HUMAN_ID, humanId: ACTOR_HUMAN_ID },
    );

    expect(result.capabilityOverride).toEqual({
      stripeChargesEnabled: true,
      stripePayoutsEnabled: false,
    });
  });

  it("no override to report when Stripe already enabled the account", async () => {
    const { deps } = makeStatusDeps({
      live: { chargesEnabled: true, payoutsEnabled: true },
    });

    const result = await getConnectStatus(
      { ...deps, forceConnectCapabilities: true },
      { actorHumanId: ACTOR_HUMAN_ID, humanId: ACTOR_HUMAN_ID },
    );

    expect(result.chargesEnabled).toBe(true);
    expect(result.capabilityOverride).toBeNull();
  });

  it("no override to report when the override is off", async () => {
    const { deps } = makeStatusDeps({
      live: { chargesEnabled: false, payoutsEnabled: false },
    });

    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    expect(result).toMatchObject({
      chargesEnabled: false,
      payoutsEnabled: false,
      capabilityOverride: null,
    });
  });

  it("Stripe unreachable: last-known row, details UNKNOWN (null, never false), no override", async () => {
    const { deps } = makeStatusDeps({
      payee: makePayee({ chargesEnabled: true, payoutsEnabled: true }),
      stripeThrows: true,
    });

    // Not forced: production's fallback.
    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    // `false` here told a finished account its onboarding was incomplete
    // whenever Stripe had an outage.
    expect(result).toMatchObject({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: null,
      capabilityOverride: null,
    });
  });

  it("forced + Stripe unreachable: a row with anything on may be the override's, so Stripe's answer is unknown", async () => {
    // An earlier forced read wrote true/true; seeded `acct_seed_*` payees
    // throw on every read, so without this dev says "fully set up" forever.
    const { deps } = makeStatusDeps({
      payee: makePayee({ chargesEnabled: true, payoutsEnabled: true }),
      stripeThrows: true,
    });

    const result = await getConnectStatus(
      { ...deps, forceConnectCapabilities: true },
      { actorHumanId: ACTOR_HUMAN_ID, humanId: ACTOR_HUMAN_ID },
    );

    expect(result).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: null,
      capabilityOverride: {
        stripeChargesEnabled: null,
        stripePayoutsEnabled: null,
      },
    });
  });

  it("forced + Stripe unreachable + row all off: nothing was turned on, no override", async () => {
    const { deps } = makeStatusDeps({
      payee: makePayee({ chargesEnabled: false, payoutsEnabled: false }),
      stripeThrows: true,
    });

    const result = await getConnectStatus(
      { ...deps, forceConnectCapabilities: true },
      { actorHumanId: ACTOR_HUMAN_ID, humanId: ACTOR_HUMAN_ID },
    );

    expect(result.capabilityOverride).toBeNull();
  });

  it("no override to report when the restriction guard, not the override, decided", async () => {
    // RESTRICTED row false/false, Stripe true/true: the write is skipped and
    // the row is reported. The override turned nothing ON.
    const { deps } = makeStatusDeps({
      payee: makePayee({
        status: "RESTRICTED",
        chargesEnabled: false,
        payoutsEnabled: false,
      }),
      live: { chargesEnabled: true, payoutsEnabled: true },
      outcome: "skipped_restricted",
    });

    const result = await getConnectStatus(
      { ...deps, forceConnectCapabilities: true },
      { actorHumanId: ACTOR_HUMAN_ID, humanId: ACTOR_HUMAN_ID },
    );

    expect(result).toMatchObject({
      chargesEnabled: false,
      payoutsEnabled: false,
      payoutsBlockedReason: "account_restricted",
      capabilityOverride: null,
    });
  });

  it("no override to report when a newer webhook, not the override, decided", async () => {
    const { deps } = makeStatusDeps({
      payee: makePayee({ chargesEnabled: false, payoutsEnabled: false }),
      live: { chargesEnabled: true, payoutsEnabled: true },
      outcome: "skipped_stale",
    });

    const result = await getConnectStatus(
      { ...deps, forceConnectCapabilities: true },
      { actorHumanId: ACTOR_HUMAN_ID, humanId: ACTOR_HUMAN_ID },
    );

    expect(result.chargesEnabled).toBe(false);
    expect(result.capabilityOverride).toBeNull();
  });

  it("no override to report when the subject has no Connect account", async () => {
    const { deps } = makeStatusDeps({
      payee: makePayee({ stripeAccountId: null }),
    });

    const result = await getConnectStatus(
      { ...deps, forceConnectCapabilities: true },
      { actorHumanId: ACTOR_HUMAN_ID, humanId: ACTOR_HUMAN_ID },
    );

    expect(result.connected).toBe(false);
    expect(result.capabilityOverride).toBeNull();
  });
});

describe("syncConnectAccount outcome reporting", () => {
  function reposWithOutcome(outcome: string) {
    return {
      payees: { syncCapabilities: vi.fn(async () => outcome) },
    } as unknown as Repos;
  }
  const input = {
    account: {
      stripeAccountId: ACCT,
      chargesEnabled: true,
      payoutsEnabled: true,
    },
    observedAt: OBSERVED_AT,
    source: "webhook" as const,
  };

  it("reports skipped_restricted to Sentry, not just the log", async () => {
    // apps/jobs has no pino->Sentry bridge, and the reconcile sweep calls this
    // from that process. logger.error alone would be invisible exactly where it
    // matters most.
    const reportError = vi.fn();
    await syncConnectAccount(
      { repos: reposWithOutcome("skipped_restricted"), reportError },
      input,
    );
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { area: "stripe-connect", op: "sync-connect-account" },
    });
  });

  it("a throwing reporter never changes the sync outcome", async () => {
    await expect(
      syncConnectAccount(
        {
          repos: reposWithOutcome("skipped_restricted"),
          reportError: () => {
            throw new Error("sentry_down");
          },
        },
        input,
      ),
    ).resolves.toMatchObject({ outcome: "skipped_restricted" });
  });

  it("escalates skipped_restricted to error level — it is NOT self-healing", async () => {
    // A deauthorized payee that re-onboards keeps status RESTRICTED, so neither
    // the webhook nor the live-read write-back can ever promote it: the exact
    // outage this work removes, reached by a different door. Nothing else would
    // surface it, and warn is not captured by Sentry.
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await syncConnectAccount(
      {
        repos: reposWithOutcome("skipped_restricted"),
        logger: logger as never,
      },
      input,
    );

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[0]).toBe(
      "stripe_connect_account_sync_skipped_restricted",
    );
    expect(result.outcome).toBe("skipped_restricted");
  });

  it("does not report a stale skip as a successful sync", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await syncConnectAccount(
      { repos: reposWithOutcome("skipped_stale"), logger: logger as never },
      input,
    );

    const messages = logger.info.mock.calls.map((c) => c[0]);
    expect(messages).toContain("stripe_connect_account_sync_skipped_stale");
    expect(messages).not.toContain("stripe_connect_account_synced");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("treats an unknown account as routine: info, no Sentry, no success log", async () => {
    // Foreign accounts are constant in dev (`stripe trigger account.updated`
    // mints a fresh one every run) and the repo deliberately no longer mints
    // placeholder rows for them. Escalating would bury real signals; logging
    // success would claim a write that never happened.
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reportError = vi.fn();
    const result = await syncConnectAccount(
      {
        repos: reposWithOutcome("skipped_unknown_account"),
        logger: logger as never,
        reportError,
      },
      input,
    );

    const messages = logger.info.mock.calls.map((c) => c[0]);
    expect(messages).toContain("stripe_connect_account_sync_unknown_account");
    expect(messages).not.toContain("stripe_connect_account_synced");
    expect(logger.error).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(result.outcome).toBe("skipped_unknown_account");
  });
});
