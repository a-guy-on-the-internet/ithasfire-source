import { describe, it, expect, vi } from "vitest";

import { notifyPayoutCompleted } from "../notify-payout-completed";

const PAYEE_ID = "10000000-0000-4000-8000-000000000001";
const PAYOUT_ID = "20000000-0000-4000-8000-000000000002";
const PAYOUT_ITEM_ID = "30000000-0000-4000-8000-000000000003";
const ORG_ID = "40000000-0000-4000-8000-000000000004";
const HUMAN_ID = "50000000-0000-4000-8000-000000000005";
const ORDER_1 = "60000000-0000-4000-8000-000000000001";
const ORDER_2 = "60000000-0000-4000-8000-000000000002";
const EVENT_1 = "70000000-0000-4000-8000-000000000001";

const NOW = new Date("2026-09-20T05:00:03.000Z");

const BASE_ARGS = {
  payeeId: PAYEE_ID,
  payoutId: PAYOUT_ID,
  payoutItemId: PAYOUT_ITEM_ID,
  amountCents: 12_500,
  currency: "usd",
  settlementCount: 2,
  appBaseUrl: "https://ithasfire.com/",
  credits: [
    { entryId: "c1", orderId: ORDER_1, amountCents: 7_500 },
    { entryId: "c2", orderId: ORDER_2, amountCents: 5_000 },
  ],
  recoveredDebtCents: 0,
  connectAccountFeeCents: 0,
  reserveHeldCents: 0,
  reserveReleasedCents: 0,
} as const;

function makeMember(humanId: string, role: string) {
  return {
    humanId,
    name: null,
    email: null,
    role,
    joinedAt: new Date(),
  };
}

/**
 * A repos fake with every enrichment read wired to a happy default. Tests
 * override the one read they care about.
 */
function makeRepos(
  overrides: {
    payee?: Record<string, unknown> | null;
    members?: ReturnType<typeof makeMember>[];
    getBalance?: (...args: unknown[]) => Promise<unknown>;
    getOrg?: () => Promise<unknown>;
    getOrder?: (id: string) => Promise<unknown>;
    getEvent?: (id: string) => Promise<unknown>;
  } = {},
) {
  const payee =
    overrides.payee === undefined
      ? {
          id: PAYEE_ID,
          subjectType: "ORGANIZATION",
          subjectId: ORG_ID,
          stripeAccountId: "acct_123",
        }
      : overrides.payee;
  const members = overrides.members ?? [makeMember(HUMAN_ID, "OWNER")];

  const repos: any = {
    payees: { getById: vi.fn(async () => payee) },
    organizations: {
      getById: vi.fn(
        overrides.getOrg ??
          (async () => ({
            id: ORG_ID,
            name: "Ithas Fire",
            slug: "ithas-fire",
          })),
      ),
      listMembers: vi.fn(async () => ({ items: members, total: members.length })),
    },
    orders: {
      getById: vi.fn(
        overrides.getOrder ??
          (async (id: string) => ({
            id,
            eventId: id === ORDER_1 ? EVENT_1 : null,
            items: id === ORDER_1 ? [{}, {}, {}] : [{}],
          })),
      ),
    },
    events: {
      getById: vi.fn(
        overrides.getEvent ??
          (async (id: string) => ({
            id,
            title: "Launch Party",
            startsAt: new Date("2026-09-18T01:00:00.000Z"),
            timezone: "America/Chicago",
          })),
      ),
    },
    payeeLedger: {
      getBalance: vi.fn(
        overrides.getBalance ??
          (async () => ({
            payeeId: PAYEE_ID,
            currency: "usd",
            ledgerBalanceCents: 4_200,
            pendingHoldCents: 0,
          })),
      ),
      listUpcomingMaturities: vi.fn(async () => [
        {
          payeeId: PAYEE_ID,
          currency: "usd",
          maturesAt: new Date("2026-09-27T05:00:00.000Z"),
          amountCents: 4_200,
        },
        // A later tranche — must NOT win over the earlier one.
        {
          payeeId: PAYEE_ID,
          currency: "usd",
          maturesAt: new Date("2026-10-04T05:00:00.000Z"),
          amountCents: 100,
        },
      ]),
    },
  };
  return repos;
}

function makePayments(delayDays: number | null = 2) {
  return {
    getConnectAccountStatus: vi.fn(async () => ({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirements: { currentlyDue: [], eventuallyDue: [], pastDue: [] },
      payoutSchedule:
        delayDays === null ? null : { interval: "daily", delayDays },
    })),
  };
}

const clock = { now: () => NOW };

describe("notifyPayoutCompleted", () => {
  it("resolves an ORGANIZATION payee to OWNER/ADMIN/FINANCE members and notifies each", async () => {
    const ownerId = HUMAN_ID;
    const adminId = "50000000-0000-4000-8000-00000000000a";
    const financeId = "50000000-0000-4000-8000-00000000000b";
    const memberId = "50000000-0000-4000-8000-00000000000c"; // excluded

    const repos = makeRepos({
      members: [
        makeMember(ownerId, "OWNER"),
        makeMember(adminId, "ADMIN"),
        makeMember(financeId, "FINANCE"),
        makeMember(memberId, "MEMBER"),
      ],
    });

    const notify = vi.fn(async () => ({ ok: true }) as any);

    await notifyPayoutCompleted({ repos, notify, clock }, BASE_ARGS);

    expect(repos.payees.getById).toHaveBeenCalledWith(PAYEE_ID);
    expect(repos.organizations.listMembers).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
    );

    // MEMBER excluded; the three privileged roles each get one notify call.
    expect(notify).toHaveBeenCalledTimes(3);
    const notifiedHumanIds = notify.mock.calls.map((c) => c[0].humanId).sort();
    expect(notifiedHumanIds).toEqual([ownerId, adminId, financeId].sort());

    for (const call of notify.mock.calls) {
      const input = call[0];
      expect(input.variant).toBe("settlement.payout-completed");
      expect(input.idempotencyKey).toBe(
        `payout-completed:${PAYOUT_ITEM_ID}:${input.humanId}`,
      );
      expect(input.payload).toMatchObject({
        payeeId: PAYEE_ID,
        payoutId: PAYOUT_ID,
        payoutItemId: PAYOUT_ITEM_ID,
        amountCents: 12_500,
        currency: "usd",
        settlementCount: 2,
      });
    }

    // Enrichment is computed ONCE per payout item, not once per recipient.
    expect(repos.organizations.getById).toHaveBeenCalledTimes(1);
    expect(repos.payeeLedger.getBalance).toHaveBeenCalledTimes(1);
  });

  it("(a) ORGANIZATION payee: links to /admin/<slug>/payouts and names the org", async () => {
    const repos = makeRepos();
    const notify = vi.fn(async () => ({ ok: true }) as any);

    await notifyPayoutCompleted({ repos, notify, clock }, BASE_ARGS);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].payload).toMatchObject({
      orgName: "Ithas Fire",
      // Trailing slash on appBaseUrl is normalised; the link is the org's
      // admin payouts page — never the resale seller page.
      payoutsUrl: "https://ithasfire.com/admin/ithas-fire/payouts",
    });
  });

  it("(b) HUMAN payee: notifies the human once with no org name and no link", async () => {
    const repos = makeRepos({
      payee: {
        id: PAYEE_ID,
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
        stripeAccountId: null,
      },
    });
    const notify = vi.fn(async () => ({ ok: true }) as any);

    await notifyPayoutCompleted({ repos, notify, clock }, BASE_ARGS);

    expect(repos.organizations.listMembers).not.toHaveBeenCalled();
    expect(repos.organizations.getById).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    const input = notify.mock.calls[0]![0];
    expect(input.humanId).toBe(HUMAN_ID);
    expect(input.variant).toBe("settlement.payout-completed");
    expect(input.idempotencyKey).toBe(
      `payout-completed:${PAYOUT_ITEM_ID}:${HUMAN_ID}`,
    );
    expect(input.payload.orgName).toBeNull();
    // The renderer schema types payoutsUrl as an optional URL, not nullable:
    // absent means "no button", so the key must not be present at all.
    expect("payoutsUrl" in input.payload).toBe(false);
  });

  it("omits the link when no appBaseUrl is configured, even for an org", async () => {
    const repos = makeRepos();
    const notify = vi.fn(async () => ({ ok: true }) as any);

    await notifyPayoutCompleted(
      { repos, notify, clock },
      { ...BASE_ARGS, appBaseUrl: null },
    );

    const payload = notify.mock.calls[0]![0].payload;
    expect(payload.orgName).toBe("Ithas Fire");
    expect("payoutsUrl" in payload).toBe(false);
  });

  it("(c) lines resolve event title, date, timezone and ticket count from orders + events", async () => {
    const repos = makeRepos();
    const notify = vi.fn(async () => ({ ok: true }) as any);
    const payments = makePayments(2);

    await notifyPayoutCompleted(
      { repos, notify, clock, payments },
      { ...BASE_ARGS, payoutDateIso: "2026-09-20T05:00:00.000Z" },
    );

    const payload = notify.mock.calls[0]![0].payload;
    expect(payload).toMatchObject({
      payoutDateIso: "2026-09-20T05:00:00.000Z",
      displayTimezone: "America/Chicago",
      lines: [
        {
          eventTitle: "Launch Party",
          eventStartsAtIso: "2026-09-18T01:00:00.000Z",
          eventTimezone: "America/Chicago",
          ticketCount: 3,
          amountCents: 7_500,
          orderId: ORDER_1,
        },
        // A membership order: no event, but the ticket count and amount
        // still land.
        {
          eventTitle: null,
          eventStartsAtIso: null,
          eventTimezone: null,
          ticketCount: 1,
          amountCents: 5_000,
          orderId: ORDER_2,
        },
      ],
      recoveredDebtCents: 0,
      connectAccountFeeCents: 0,
      reserveHeldCents: 0,
      reserveReleasedCents: 0,
      // Nothing dropped by the line cap.
      otherSalesCount: 0,
      otherSalesCents: 0,
      balanceAfterCents: 4_200,
      // The earliest maturity for this payee/currency, not the last row.
      nextPayableAtIso: "2026-09-27T05:00:00.000Z",
      bankDelayDays: 2,
      stripeDashboardUrl: "https://connect.stripe.com/express_login",
    });
    expect(repos.orders.getById).toHaveBeenCalledTimes(2);
    expect(repos.events.getById).toHaveBeenCalledTimes(1);
    expect(repos.events.getById).toHaveBeenCalledWith(EVENT_1);
    expect(payments.getConnectAccountStatus).toHaveBeenCalledWith({
      accountId: "acct_123",
    });
    expect(repos.payeeLedger.listUpcomingMaturities).toHaveBeenCalledWith(
      NOW,
      [PAYEE_ID],
      expect.objectContaining({ statementTimeoutMs: expect.any(Number) }),
    );
  });

  it("dedupes order and event lookups across credits that share them", async () => {
    const repos = makeRepos();
    const notify = vi.fn(async () => ({ ok: true }) as any);

    await notifyPayoutCompleted(
      { repos, notify, clock },
      {
        ...BASE_ARGS,
        credits: [
          { entryId: "c1", orderId: ORDER_1, amountCents: 100 },
          { entryId: "c2", orderId: ORDER_1, amountCents: 200 },
          { entryId: "c3", orderId: null, amountCents: 300 },
        ],
      },
    );

    expect(repos.orders.getById).toHaveBeenCalledTimes(1);
    expect(repos.events.getById).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0].payload;
    expect(payload.lines).toHaveLength(3);
    expect(payload.lines[2]).toEqual({
      eventTitle: null,
      eventStartsAtIso: null,
      eventTimezone: null,
      ticketCount: null,
      amountCents: 300,
      orderId: null,
    });
  });

  it("caps at 25 lines keeping the largest, in feed order, and bounds the reads", async () => {
    const repos = makeRepos();
    const notify = vi.fn(async () => ({ ok: true }) as any);
    // 30 credits, amounts 1..30 in feed order; the smallest five (1..5)
    // must be the ones dropped.
    const credits = Array.from({ length: 30 }, (_, i) => ({
      entryId: `c${i + 1}`,
      orderId: `80000000-0000-4000-8000-0000000000${String(i + 10)}`,
      amountCents: i + 1,
    }));

    await notifyPayoutCompleted(
      { repos, notify, clock },
      { ...BASE_ARGS, credits, settlementCount: 30 },
    );

    const payload = notify.mock.calls[0]![0].payload;
    expect(payload.lines).toHaveLength(25);
    expect(payload.lines.map((l: { amountCents: number }) => l.amountCents)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 6),
    );
    expect(payload.settlementCount).toBe(30);
    // The five dropped credits ($1..$5) are carried as one total so the
    // statement's sales still sum to the payable.
    expect(payload.otherSalesCount).toBe(5);
    expect(payload.otherSalesCents).toBe(15);
    expect(repos.orders.getById).toHaveBeenCalledTimes(25);
  });

  it("forwards reserveReleasedCents and the withholdings verbatim", async () => {
    const repos = makeRepos();
    const notify = vi.fn(async () => ({ ok: true }) as any);

    await notifyPayoutCompleted(
      { repos, notify, clock },
      {
        ...BASE_ARGS,
        connectAccountFeeCents: 136,
        reserveHeldCents: 500,
        reserveReleasedCents: 2_000,
      },
    );

    expect(notify.mock.calls[0]![0].payload).toMatchObject({
      recoveredDebtCents: 0,
      connectAccountFeeCents: 136,
      reserveHeldCents: 500,
      reserveReleasedCents: 2_000,
    });
  });

  it("(a′) a throwing organizations.getById degrades orgName + payoutsUrl to null, still notifies, reports", async () => {
    const boom = new Error("org read failed");
    const repos = makeRepos({
      getOrg: async () => {
        throw boom;
      },
    });
    const notify = vi.fn(async () => ({ ok: true }) as any);
    const reportError = vi.fn();

    await notifyPayoutCompleted({ repos, notify, clock, reportError }, BASE_ARGS);

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0].payload;
    expect(payload.orgName).toBeNull();
    expect("payoutsUrl" in payload).toBe(false);
    expect(payload.lines).toHaveLength(2);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "notifyPayoutCompleted", read: "organization" },
      extra: { payeeId: PAYEE_ID, payoutItemId: PAYOUT_ITEM_ID },
    });
  });

  it("(c′) a throwing orders.getById for one credit degrades that line only; the sibling survives; one report", async () => {
    const boom = new Error("order read failed");
    const repos = makeRepos({
      getOrder: async (id: string) => {
        if (id === ORDER_2) throw boom;
        return { id, eventId: EVENT_1, items: [{}, {}, {}] };
      },
    });
    const notify = vi.fn(async () => ({ ok: true }) as any);
    const reportError = vi.fn();

    await notifyPayoutCompleted({ repos, notify, clock, reportError }, BASE_ARGS);

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0].payload;
    expect(payload.lines).toEqual([
      {
        eventTitle: "Launch Party",
        eventStartsAtIso: "2026-09-18T01:00:00.000Z",
        eventTimezone: "America/Chicago",
        ticketCount: 3,
        amountCents: 7_500,
        orderId: ORDER_1,
      },
      {
        eventTitle: null,
        eventStartsAtIso: null,
        eventTimezone: null,
        ticketCount: null,
        amountCents: 5_000,
        orderId: ORDER_2,
      },
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "notifyPayoutCompleted", read: "order" },
      extra: { payeeId: PAYEE_ID, payoutItemId: PAYOUT_ITEM_ID },
    });
  });

  it("probes event timezones: an unknown zone is dropped from the line, display falls back to UTC, and is reported once", async () => {
    const repos = makeRepos({
      getEvent: async (id: string) => ({
        id,
        title: "Launch Party",
        startsAt: new Date("2026-09-18T01:00:00.000Z"),
        timezone: "Mars/Olympus_Mons",
      }),
    });
    const notify = vi.fn(async () => ({ ok: true }) as any);
    const reportError = vi.fn();

    await notifyPayoutCompleted({ repos, notify, clock, reportError }, BASE_ARGS);

    const payload = notify.mock.calls[0]![0].payload;
    expect(payload.lines[0]).toMatchObject({
      eventTitle: "Launch Party",
      eventStartsAtIso: "2026-09-18T01:00:00.000Z",
      eventTimezone: null,
    });
    expect(payload.displayTimezone).toBe("UTC");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(RangeError), {
      tags: { useCase: "notifyPayoutCompleted", read: "timezone" },
      extra: { payeeId: PAYEE_ID, payoutItemId: PAYOUT_ITEM_ID },
    });
  });

  it("bounds order lookups to 5 in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const repos = makeRepos({
      getOrder: async (id: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return { id, eventId: null, items: [{}] };
      },
    });
    const notify = vi.fn(async () => ({ ok: true }) as any);
    const credits = Array.from({ length: 20 }, (_, i) => ({
      entryId: `c${i}`,
      orderId: `80000000-0000-4000-8000-0000000000${String(i + 10)}`,
      amountCents: 100,
    }));

    await notifyPayoutCompleted(
      { repos, notify, clock },
      { ...BASE_ARGS, credits, settlementCount: 20 },
    );

    expect(repos.orders.getById).toHaveBeenCalledTimes(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("enrichment timeout: a hung read degrades to the minimal payload, still notifies, and reports", async () => {
    vi.useFakeTimers();
    try {
      const repos = makeRepos({
        // Never resolves — the coarse deadline is the only way out.
        getOrder: () => new Promise(() => {}),
      });
      const notify = vi.fn(async () => ({ ok: true }) as any);
      const reportError = vi.fn();
      const logger: any = { error: vi.fn(), warn: vi.fn() };

      const run = notifyPayoutCompleted(
        { repos, notify, clock, reportError, logger },
        BASE_ARGS,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await run;

      expect(notify).toHaveBeenCalledTimes(1);
      const payload = notify.mock.calls[0]![0].payload;
      expect(payload).toMatchObject({
        amountCents: 12_500,
        orgName: null,
        displayTimezone: "UTC",
        lines: [],
        // Every credit is carried as "other sales" so the statement still
        // reconciles to what was paid.
        otherSalesCount: 2,
        otherSalesCents: 12_500,
        balanceAfterCents: null,
        nextPayableAtIso: null,
        bankDelayDays: null,
        reserveReleasedCents: 0,
      });
      expect("payoutsUrl" in payload).toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "notifyPayoutCompleted.enrichment_timeout",
        }),
        {
          tags: { useCase: "notifyPayoutCompleted", read: "enrichment_timeout" },
          extra: { payeeId: PAYEE_ID, payoutItemId: PAYOUT_ITEM_ID },
        },
      );
      expect(logger.error).toHaveBeenCalledWith(
        "notifyPayoutCompleted.enrichment_timeout",
        expect.objectContaining({ payoutItemId: PAYOUT_ITEM_ID }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("(d) a throwing getBalance degrades balanceAfterCents to null, still notifies, and reports once", async () => {
    const boom = new Error("ledger read timed out");
    const repos = makeRepos({
      getBalance: async () => {
        throw boom;
      },
    });
    const notify = vi.fn(async () => ({ ok: true }) as any);
    const reportError = vi.fn();
    const logger: any = { error: vi.fn(), warn: vi.fn() };

    await notifyPayoutCompleted(
      { repos, notify, clock, reportError, logger },
      BASE_ARGS,
    );

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0].payload;
    expect(payload.balanceAfterCents).toBeNull();
    // No balance → no forecast attempted either.
    expect(payload.nextPayableAtIso).toBeNull();
    expect(repos.payeeLedger.listUpcomingMaturities).not.toHaveBeenCalled();
    // The rest of the enrichment survived the one failed read.
    expect(payload.orgName).toBe("Ithas Fire");
    expect(payload.lines).toHaveLength(2);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "notifyPayoutCompleted", read: "balance" },
      extra: { payeeId: PAYEE_ID, payoutItemId: PAYOUT_ITEM_ID },
    });
    // error, not warn: warn is not captured by Sentry.
    expect(logger.error).toHaveBeenCalledWith(
      "notifyPayoutCompleted.enrichment_read_failed",
      expect.objectContaining({ read: "balance", payoutItemId: PAYOUT_ITEM_ID }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("(e) a throwing getConnectAccountStatus degrades bankDelayDays to null, still notifies, and reports", async () => {
    const boom = new Error("stripe 503");
    const repos = makeRepos();
    const notify = vi.fn(async () => ({ ok: true }) as any);
    const reportError = vi.fn();
    const payments = {
      getConnectAccountStatus: vi.fn(async () => {
        throw boom;
      }),
    };

    await notifyPayoutCompleted(
      { repos, notify, clock, payments, reportError },
      BASE_ARGS,
    );

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0].payload;
    expect(payload.bankDelayDays).toBeNull();
    expect(payload.balanceAfterCents).toBe(4_200);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "notifyPayoutCompleted", read: "connect_account" },
      extra: { payeeId: PAYEE_ID, payoutItemId: PAYOUT_ITEM_ID },
    });
  });

  it("says nothing about bank timing when payments is not wired or the account has no schedule", async () => {
    const notify = vi.fn(async () => ({ ok: true }) as any);

    await notifyPayoutCompleted(
      { repos: makeRepos(), notify, clock },
      BASE_ARGS,
    );
    expect(notify.mock.calls[0]![0].payload.bankDelayDays).toBeNull();

    notify.mockClear();
    await notifyPayoutCompleted(
      { repos: makeRepos(), notify, clock, payments: makePayments(null) },
      BASE_ARGS,
    );
    expect(notify.mock.calls[0]![0].payload.bankDelayDays).toBeNull();
  });

  it("a throwing reporter never blocks the email", async () => {
    const repos = makeRepos({
      getBalance: async () => {
        throw new Error("ledger down");
      },
    });
    const notify = vi.fn(async () => ({ ok: true }) as any);
    const reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });

    await expect(
      notifyPayoutCompleted({ repos, notify, clock, reportError }, BASE_ARGS),
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("forwards kind only when explicitly set", async () => {
    const repos = makeRepos({
      payee: {
        id: PAYEE_ID,
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
        stripeAccountId: null,
      },
    });
    const notify = vi.fn(async () => ({ ok: true }) as any);

    // Fully-withheld payout: the renderer switches to applied-to-balance copy.
    await notifyPayoutCompleted(
      { repos, notify, clock },
      { ...BASE_ARGS, kind: "applied_to_balance" },
    );
    expect(notify.mock.calls[0]![0].payload).toMatchObject({
      kind: "applied_to_balance",
    });

    // Default path: no `kind` property at all.
    notify.mockClear();
    await notifyPayoutCompleted({ repos, notify, clock }, BASE_ARGS);
    expect("kind" in notify.mock.calls[0]![0].payload).toBe(false);
  });

  it("does nothing when the payee cannot be found", async () => {
    const repos = makeRepos({ payee: null });
    const notify = vi.fn(async () => ({ ok: true }) as any);

    await notifyPayoutCompleted({ repos, notify, clock }, BASE_ARGS);

    expect(notify).not.toHaveBeenCalled();
    expect(repos.payeeLedger.getBalance).not.toHaveBeenCalled();
  });

  it("swallows a per-recipient notify failure, reports it, and still notifies the rest", async () => {
    const ownerId = HUMAN_ID;
    const adminId = "50000000-0000-4000-8000-00000000000a";
    const repos = makeRepos({
      members: [makeMember(ownerId, "OWNER"), makeMember(adminId, "ADMIN")],
    });

    const boom = new Error("boom");
    const notify = vi
      .fn()
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce({ ok: true } as any);
    const logger: any = { error: vi.fn(), warn: vi.fn() };
    const reportError = vi.fn();

    await expect(
      notifyPayoutCompleted(
        { repos, notify, logger, clock, reportError },
        BASE_ARGS,
      ),
    ).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "notifyPayoutCompleted.recipient_notify_failed",
      expect.objectContaining({ payoutItemId: PAYOUT_ITEM_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "notifyPayoutCompleted", step: "recipient_notify" },
      extra: {
        payeeId: PAYEE_ID,
        payoutItemId: PAYOUT_ITEM_ID,
        humanId: ownerId,
      },
    });
  });
});
