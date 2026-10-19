import { describe, expect, it, vi } from "vitest";

import type { MembershipRecord } from "@th/ports/repos/memberships";
import type { MembershipTierRecord } from "@th/ports/repos/membership-tiers";

import { sendRenewalNotice } from "../send-renewal-notice";

const TIER_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_HUMAN_ID = "55555555-5555-4555-8555-555555555555";
const MEMBERSHIP_ID = "66666666-6666-4666-8666-666666666666";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const PERIOD_END = new Date("2026-09-10T12:00:00.000Z");
const RENEWAL_AT = new Date("2026-09-10T12:00:00.000Z");

/** $10.00 tier at Nashville's 9.75% → $10.98 charged. */
const AMOUNT_DUE = 1098;

describe("sendRenewalNotice", () => {
  it("emails the member the tier, amount, date, OWNER name and cancel link", async () => {
    const ctx = makeCtx();

    const result = await ctx.run(noticeInput());

    expect(result).toMatchObject({
      ok: true,
      sent: true,
      reason: null,
      membershipId: MEMBERSHIP_ID,
    });

    expect(ctx.mailer.send).toHaveBeenCalledTimes(1);
    const sent = ctx.mailer.send.mock.calls[0]![0];
    expect(sent.to).toEqual({ to: "member@example.com", name: "Merri Member" });
    expect(sent.template).toMatchObject({
      key: "membership.renewal_notice",
      variables: {
        tierName: "Sustaining Member",
        // The ORG's name — what the card statement will show. Statement-
        // descriptor congruence is the whole point of naming the owner.
        ownerName: "DRKMTTR Collective",
        amountFormatted: "$10.98",
        renewalDateISO: RENEWAL_AT.toISOString(),
        // No owner zone exists, so the platform default (never the server's).
        timezone: "America/Chicago",
        cancelUrl: "https://ithasfire.example/account/memberships",
      },
    });
    // Provider-side dedupe key: per-channel `:email` suffix, NEVER the bare
    // use-case key — the mailer adapter claims its key on the same idempotency
    // store, so a shared key deadlocks into `idempotency_conflict`.
    expect(sent.idempotencyKey).toBe("renewal_notice:evt_upcoming_1:email");
  });

  it("builds the cancel link from publicAppUrl with the trailing slash trimmed", async () => {
    const ctx = makeCtx({ publicAppUrl: "https://ithasfire.example/" });

    await ctx.run(noticeInput());

    const sent = ctx.mailer.send.mock.calls[0]![0];
    expect(sent.template.variables.cancelUrl).toBe(
      "https://ithasfire.example/account/memberships",
    );
  });

  it("names a HUMAN owner for a human-owned tier", async () => {
    const ctx = makeCtx({
      tier: buildTier({ ownerOrgId: null, ownerHumanId: OWNER_HUMAN_ID }),
    });

    await ctx.run(noticeInput());

    const sent = ctx.mailer.send.mock.calls[0]![0];
    expect(sent.template.variables.ownerName).toBe("Otis Owner");
  });

  it("is idempotent on replay — the mailer is called exactly once", async () => {
    const ctx = makeCtx();

    const first = await ctx.run(noticeInput());
    const second = await ctx.run(noticeInput());

    expect(ctx.mailer.send).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("no-ops an untracked subscription without throwing", async () => {
    // The platform account carries subscriptions we did not create;
    // `invoice.upcoming` fires for all of them. Same not-ours reasoning as
    // the invoice.payment_succeeded handler.
    const ctx = makeCtx({ membership: null });

    const result = await ctx.run(noticeInput());

    expect(result).toEqual({
      ok: true,
      sent: false,
      reason: "not_ours",
      membershipId: null,
    });
    expect(ctx.mailer.send).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
    expect(ctx.deps.logger.info).toHaveBeenCalledWith(
      "sendRenewalNotice.skipped_untracked_subscription",
      expect.objectContaining({ stripeSubscriptionId: "sub_1" }),
    );
  });

  it("a mailer THROW propagates — the notice is required, so the webhook must DLQ and retry", async () => {
    const ctx = makeCtx();
    ctx.mailer.send.mockRejectedValueOnce(new Error("smtp down"));

    // Wrapped by `asKnownError` (same as record-membership-invoice-paid):
    // the root cause rides on `cause`, the code marks a dependency failure.
    await expect(ctx.run(noticeInput())).rejects.toMatchObject({
      code: "dependency_failed",
      cause: expect.objectContaining({ message: "smtp down" }),
    });
    expect(ctx.audit.log).not.toHaveBeenCalled();

    // The idempotency key was released, so a redelivery RETRIES the send
    // rather than replaying the failure.
    const retried = await ctx.run(noticeInput());
    expect(retried).toMatchObject({ ok: true, sent: true });
    expect(ctx.mailer.send).toHaveBeenCalledTimes(2);
  });

  it("an audit failure AFTER a successful send is swallowed + reported, the claim stays committed, and a replay does not re-send", async () => {
    // The email has left. Throwing here would release the claim and the DLQ
    // replay minutes later would email the member twice (the mailer's own
    // `:email` key only lives 120 s).
    const ctx = makeCtx();
    const reportError = vi.fn();
    (ctx.deps as { reportError?: unknown }).reportError = reportError;
    ctx.audit.log.mockRejectedValueOnce(new Error("audit db down"));

    const first = await ctx.run(noticeInput());

    expect(first).toMatchObject({ ok: true, sent: true });
    expect(ctx.mailer.send).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "audit db down" }),
      expect.objectContaining({
        tags: { useCase: "sendRenewalNotice", stage: "audit_after_send" },
        extra: expect.objectContaining({ stripeEventId: noticeInput().stripeEventId }),
      }),
    );
    expect(ctx.deps.logger.error).toHaveBeenCalledWith(
      "sendRenewalNotice.audit_failed_after_send",
      expect.objectContaining({ error: "audit db down" }),
    );
    const idem = (ctx.deps as unknown as { idempotency: Record<string, ReturnType<typeof vi.fn>> })
      .idempotency;
    expect(idem.commit).toHaveBeenCalledTimes(1);
    expect(idem.fail).not.toHaveBeenCalled();
    expect(idem.release).not.toHaveBeenCalled();

    // Replay of the same event: cached response, mailer untouched.
    const replay = await ctx.run(noticeInput());
    expect(replay).toMatchObject({ ok: true, sent: true });
    expect(ctx.mailer.send).toHaveBeenCalledTimes(1);
  });

  it("a mailer failure RESULT throws too — same outcome as a throw", async () => {
    const ctx = makeCtx();
    ctx.mailer.send.mockResolvedValueOnce({
      result: { success: false, errorCode: "rate_limited" },
    });

    await expect(ctx.run(noticeInput())).rejects.toMatchObject({
      code: "EMAIL_DELIVERY_FAILED",
    });
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("refuses a tier that no longer exists", async () => {
    const ctx = makeCtx({ tier: null });

    await expect(ctx.run(noticeInput())).rejects.toMatchObject({
      code: "MEMBERSHIP_TIER_NOT_FOUND",
    });
    expect(ctx.mailer.send).not.toHaveBeenCalled();
  });

  it("writes the audit row that backs a future dispute response", async () => {
    const ctx = makeCtx();

    await ctx.run(noticeInput());

    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "membership",
        entityId: MEMBERSHIP_ID,
        action: "membership_renewal_notice_sent",
        data: expect.objectContaining({
          stripeEventId: "evt_upcoming_1",
          amountDueCents: AMOUNT_DUE,
          nextPaymentAttempt: RENEWAL_AT.toISOString(),
          cancelUrl: "https://ithasfire.example/account/memberships",
        }),
        at: NOW,
      }),
    );
  });

  it("rejects a conflicting replay of the same event id", async () => {
    const ctx = makeCtx();

    await ctx.run(noticeInput());

    await expect(
      ctx.run(noticeInput({ stripeSubscriptionId: "sub_other" })),
    ).rejects.toMatchObject({ code: "STRIPE_EVENT_CONFLICT" });
  });
});

// ── Harness ────────────────────────────────────────────────────────────────

function noticeInput(overrides: Record<string, unknown> = {}) {
  return {
    stripeSubscriptionId: "sub_1",
    amountDueCents: AMOUNT_DUE,
    currency: "usd",
    nextPaymentAttempt: RENEWAL_AT,
    periodStart: NOW,
    periodEnd: PERIOD_END,
    stripeEventId: "evt_upcoming_1",
    ...overrides,
  };
}

function buildTier(
  overrides: Partial<MembershipTierRecord> = {},
): MembershipTierRecord {
  return {
    id: TIER_ID,
    ownerOrgId: ORG_ID,
    ownerHumanId: null,
    name: "Sustaining Member",
    description: null,
    priceCents: 1000,
    currency: "usd",
    interval: "MONTH",
    stripeProductId: "prod_1",
    stripePriceId: "price_1",
    status: "ACTIVE",
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildMembership(
  overrides: Partial<MembershipRecord> = {},
): MembershipRecord {
  return {
    id: MEMBERSHIP_ID,
    tierId: TIER_ID,
    memberHumanId: MEMBER_ID,
    stripeSubscriptionId: "sub_1",
    stripeCustomerId: "cus_1",
    status: "active",
    taxJurisdictionId: "jur_1",
    billingPostalCode: "37206",
    billingCountryCode: "US",
    currentPeriodStart: NOW,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** In-memory IdempotencyPort with real begin/commit/fail semantics. */
function makeIdempotency() {
  const claimed = new Set<string>();
  const committed = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => committed.get(key) ?? null),
    begin: vi.fn(async (key: string) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
    commit: vi.fn(async (key: string, result: unknown) => {
      committed.set(key, result);
    }),
    fail: vi.fn(async (key: string) => {
      claimed.delete(key);
    }),
    // Transient failures now RELEASE (owner-checked) instead of `fail`; the
    // fake mirrors the real adapters: a matching release frees the key.
    release: vi.fn(async (key: string, _ownerToken: string) => {
      claimed.delete(key);
      return true;
    }),
    run: vi.fn(),
    purgeExpired: vi.fn(async () => 0),
  };
}

function makeCtx(
  options: {
    tier?: MembershipTierRecord | null;
    membership?: MembershipRecord | null;
    publicAppUrl?: string;
  } = {},
) {
  const membership =
    options.membership === undefined ? buildMembership() : options.membership;
  const tier = options.tier === undefined ? buildTier() : options.tier;

  const memberships = {
    findByStripeSubscriptionId: vi.fn(async () => membership),
  };
  const membershipTiers = { findById: vi.fn(async () => tier) };
  const humans = {
    getByIdWithIdentity: vi.fn(async (id: string) => {
      if (id === MEMBER_ID) {
        return {
          human: { id: MEMBER_ID, name: "Merri Member" },
          identity: {
            authUserId: "au_member",
            email: "member@example.com",
            emailVerified: true,
            phone: null,
            phoneVerified: false,
            username: "merri",
            displayUsername: "merri",
            image: null,
          },
        };
      }
      if (id === OWNER_HUMAN_ID) {
        return {
          human: { id: OWNER_HUMAN_ID, name: "Otis Owner" },
          identity: {
            authUserId: "au_owner",
            email: "owner@example.com",
            emailVerified: true,
            phone: null,
            phoneVerified: false,
            username: "otis",
            displayUsername: "otis",
            image: null,
          },
        };
      }
      return null;
    }),
  };
  const organizations = {
    getById: vi.fn(async () => ({
      id: ORG_ID,
      name: "DRKMTTR Collective",
      slug: "drkmttr",
      status: "ACTIVE",
    })),
  };
  const audit = { log: vi.fn(async () => {}) };

  const mailer = {
    send: vi.fn(async () => ({ result: { success: true, id: "msg_1" } })),
    sendBatch: vi.fn(),
    health: vi.fn(),
  };

  const deps = {
    repos: {
      memberships,
      membershipTiers,
      humans,
      organizations,
      audit,
    } as never,
    idempotency: makeIdempotency() as never,
    mailer: mailer as never,
    clock: { now: () => NOW },
    publicAppUrl: options.publicAppUrl ?? "https://ithasfire.example",
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };

  return {
    memberships,
    membershipTiers,
    humans,
    organizations,
    audit,
    mailer,
    deps: deps as never as Parameters<typeof sendRenewalNotice>[0] & {
      logger: { info: ReturnType<typeof vi.fn> };
    },
    run: (input: unknown) => sendRenewalNotice(deps as never, input),
  };
}
