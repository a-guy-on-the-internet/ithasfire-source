import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { grantVolunteerReward } from "./grant-volunteer-reward";
import type { GrantVolunteerRewardDeps } from "./grant-volunteer-reward";

// ── Constants ────────────────────────────────────────────────────────────────

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ASK_ID = "00000000-0000-4000-8000-000000000002";
const ROLE_ID = "00000000-0000-4000-8000-000000000003";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000004";
const REWARD_ID = "00000000-0000-4000-8000-000000000005";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000006";
const SIGNUP_ID_2 = "00000000-0000-4000-8000-000000000007";
const HUMAN_ID = "00000000-0000-4000-8000-000000000008";
const GUEST_HUMAN_ID = "00000000-0000-4000-8000-000000000009";
const NOW = new Date("2026-07-02T12:00:00.000Z");

const FACE_VALUE_CENTS = 5000;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseTicketType = {
  id: TICKET_TYPE_ID,
  name: "General Admission",
  priceCents: FACE_VALUE_CENTS,
  capacity: 100,
  status: "ACTIVE" as const,
  seatSectionId: null,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
};

const baseAsk = {
  id: ASK_ID,
  subjectType: "EVENT" as const,
  subjectId: EVENT_ID,
  orgId: "00000000-0000-4000-8000-0000000000aa",
  title: "Door crew",
  description: null,
  status: "OPEN" as const,
  cadence: "ONE_TIME" as const,
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

function makeReward(overrides: Record<string, unknown> = {}) {
  return {
    id: REWARD_ID,
    askId: ASK_ID,
    roleId: null as string | null,
    ticketTypeId: TICKET_TYPE_ID,
    trigger: "ON_CHECK_IN" as const,
    maxGrants: null as number | null,
    grantsUsed: 0,
    active: true,
    ...overrides,
  };
}

function makeSignup(overrides: Record<string, unknown> = {}) {
  return {
    id: SIGNUP_ID,
    eventId: EVENT_ID,
    askId: ASK_ID,
    roleId: ROLE_ID,
    shiftId: null,
    groupId: null,
    humanId: HUMAN_ID as string | null,
    contactEmail: "vol@example.com",
    contactName: "Vol Unteer",
    contactPhone: null,
    smsOptIn: false,
    status: "CHECKED_IN" as const,
    hoursWorked: null,
    reviewerHumanId: null,
    reviewedAt: null,
    checkedInAt: NOW,
    waiverAcceptedAt: null,
    notes: null,
    answers: {},
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ── In-memory idempotency ────────────────────────────────────────────────────

/**
 * Models the SHIPPED adapters, including the part that used to be wrong here:
 * `fail()` WRITES a failed marker with its own retention (15 min by default)
 * and `begin()` refuses to re-claim until that retention expires. Treating a
 * failed key as instantly re-claimable made the BUDGET_EXHAUSTED release test
 * pass against a 15-minute lockout.
 */
function makeIdempotency() {
  const store = new Map<
    string,
    { status: "pending" | "done" | "failed"; result?: unknown; expiresAt: number }
  >();
  let nowMs = 0;
  const live = (key: string) => {
    const e = store.get(key);
    return e && e.expiresAt > nowMs ? e : undefined;
  };
  return {
    store,
    /** Advance the double's virtual clock, in milliseconds. */
    advance: (ms: number) => {
      nowMs += ms;
    },
    begin: vi.fn(async (key: string, ttlSec = 60) => {
      if (live(key)) return false;
      store.set(key, { status: "pending", expiresAt: nowMs + ttlSec * 1000 });
      return true;
    }),
    get: vi.fn(async (key: string) => {
      const e = live(key);
      return e && e.status === "done" ? (e.result as any) : null;
    }),
    commit: vi.fn(async (key: string, result: unknown, keepSec = 3 * 86400) => {
      store.set(key, {
        status: "done",
        result,
        expiresAt: nowMs + keepSec * 1000,
      });
    }),
    fail: vi.fn(async (key: string, _error?: string, keepSec = 15 * 60) => {
      store.set(key, { status: "failed", expiresAt: nowMs + keepSec * 1000 });
    }),
    run: vi.fn(),
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

function makeHarness(opts: {
  reward?: Record<string, unknown>;
  signup?: Record<string, unknown>;
  idempotency?: ReturnType<typeof makeIdempotency>;
  /** Geocoded venue coords for the ticket-email map (default: none). */
  eventCoords?: { lat: number; lng: number };
  /** Self-hosted tileserver base URL threaded onto grant deps. */
  tileServerUrl?: string;
} = {}) {
  const reward = makeReward(opts.reward);
  const signup = makeSignup(opts.signup);

  // Shared mutable state across tx + top-level reads.
  const grantsById = new Map<string, any>();
  const grantByKey = new Map<string, any>();
  const ordersById = new Map<string, any>();
  const ticketsByOrder = new Map<string, any[]>();

  const createGrant = vi.fn(async (input: any) => {
    const key = `${input.rewardId}:${input.signupId}`;
    if (grantByKey.has(key)) {
      throw { code: "duplicate_grant", message: "duplicate_grant" };
    }
    const grant = {
      id: crypto.randomUUID(),
      rewardId: input.rewardId,
      signupId: input.signupId,
      humanId: input.humanId ?? null,
      contactEmail: input.contactEmail,
      status: "GRANTED",
      compOrderId: input.compOrderId ?? null,
      ticketId: input.ticketId ?? null,
      faceValueCents: input.faceValueCents,
      grantedAt: NOW,
      redeemedAt: null,
      revokedAt: null,
      revokeReason: null,
    };
    grantsById.set(grant.id, grant);
    grantByKey.set(key, grant);
    return grant;
  });

  const incrementGrantsUsed = vi.fn(async () => {
    reward.grantsUsed += 1;
  });

  const getGrantByRewardAndSignup = vi.fn(
    async (rewardId: string, signupId: string) =>
      grantByKey.get(`${rewardId}:${signupId}`) ?? null,
  );

  const txRepos: Partial<TxRepos> = {
    volunteering: {
      getRewardForUpdate: vi.fn(async () => ({ ...reward })),
      getSignup: vi.fn(async () => signup),
      getGrantByRewardAndSignup,
      getAsk: vi.fn(async () => baseAsk),
      createGrant,
      incrementGrantsUsed,
    } as any,
    events: {
      listTicketTypes: vi.fn(async () => [baseTicketType]),
      // `createCompOrder` reads the event for its resale clause (FR-003);
      // no RESALE terms, so the comp records no clause.
      getById: vi.fn(async () => ({ id: EVENT_ID, resalePayoutTermsId: null })),
    } as any,
    humans: {
      ensureGuestHuman: vi.fn(async () => ({
        humanId: GUEST_HUMAN_ID,
        created: true,
      })),
      update: vi.fn(async (id: string, updates: any) => ({ id, ...updates })),
    } as any,
    tickets: {
      countIssuedForTicketType: vi.fn(async () => 0),
      countCapacityConsumingForTicketType: vi.fn(async () => 0),
      countForOrderTicketType: vi.fn(async () => 0),
      getByOrderItemId: vi.fn(async () => null),
      create: vi.fn(async (input: any) => {
        const ticket = { id: crypto.randomUUID(), status: "VALID", ...input };
        const list = ticketsByOrder.get(input.orderId) ?? [];
        list.push(ticket);
        ticketsByOrder.set(input.orderId, list);
        return ticket;
      }),
      listByOrderId: vi.fn(async (orderId: string) =>
        ticketsByOrder.get(orderId) ?? [],
      ),
      // Same active set as the adapter (VALID | SCANNED | LISTED).
      hasActiveTicketForEvent: vi.fn(async (eventId: string, humanId: string) =>
        [...ticketsByOrder.values()]
          .flat()
          .some(
            (t: any) =>
              t.eventId === eventId &&
              t.ownerHumanId === humanId &&
              ["VALID", "SCANNED", "LISTED"].includes(t.status),
          ),
      ),
    } as any,
    orders: {
      createPending: vi.fn(async (input: any) => {
        ordersById.set(input.id, {
          id: input.id,
          eventId: input.eventId,
          buyerHumanId: input.buyerHumanId,
          amountGrossCents: 0,
          feesPlatformCents: 0,
          taxAmountCents: 0,
          currency: "usd",
          feePolicySnapshot: {},
          status: "PENDING",
          source: "COMP",
          items: input.items.map((it: any, i: number) => ({
            id: `${input.id}-item-${i}`,
            orderId: input.id,
            kind: it.kind,
            ticketTypeId: it.ticketTypeId,
            qty: it.qty,
            unitPriceCents: it.unitPriceCents,
            amountCents: it.amountCents,
            meta: {},
            status: "active",
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
          })),
        });
        return { id: input.id };
      }),
      markSucceeded: vi.fn(async (id: string) => {
        const o = ordersById.get(id);
        if (o) o.status = "SUCCEEDED";
      }),
      getById: vi.fn(async (id: string) => ordersById.get(id) ?? null),
    } as any,
    seats: { updateStatuses: vi.fn(async () => undefined) } as any,
    audit: { log: vi.fn(async () => undefined) } as any,
  };

  const mailer = { send: vi.fn(async () => ({ id: "msg" })) };

  const repos = {
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as TxRepos),
    ),
    volunteering: { getGrantByRewardAndSignup },
    orders: { getById: vi.fn(async (id: string) => ordersById.get(id) ?? null) },
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: "Vol Unteer" },
        // A real account has a verified email (B2: `isLoginableBuyer`
        // also requires it).
        identity: { email: "vol@example.com", emailVerified: true },
      })),
      // `sendTicketIssuedEmail` now derives an /auth/complete claim link for
      // any recipient who cannot sign in, using `isLoginableBuyer` — i.e.
      // "has at least one AuthAccount". The default harness models a REAL
      // account, so return one; `isLoginableBuyer` is fail-safe FALSE, so
      // omitting this method entirely would silently produce a claim link and
      // make the "already has an account" case look broken.
      //
      // Note this is a DIFFERENT signal from the harness's `signup.humanId`:
      // a linked Human can still be a shadow with no AuthAccount rows, in
      // which case a claim link is exactly right.
      listAuthAccounts: vi.fn(async () => [
        { id: "acct_1", providerId: "credential" },
      ]),
    },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        title: "Summer Fest",
        placeId: null,
        // EXACT-location event: the ticket email is free to render the venue
        // map (a non-EXACT event would suppress it behind the reveal gate).
        locationMode: "EXACT",
        locality: null,
        region: null,
        addressRevealAt: null,
        addressText: null,
        locationLabel: null,
        lat: opts.eventCoords?.lat ?? null,
        lng: opts.eventCoords?.lng ?? null,
        startsAt: new Date("2026-07-10T18:00:00Z"),
        timezone: "America/Chicago",
      })),
    },
    places: { getById: vi.fn(async () => null) },
    tickets: {
      listByOrderId: vi.fn(async (orderId: string) =>
        ticketsByOrder.get(orderId) ?? [],
      ),
      // Same active set as the adapter (VALID | SCANNED | LISTED).
      hasActiveTicketForEvent: vi.fn(async (eventId: string, humanId: string) =>
        [...ticketsByOrder.values()]
          .flat()
          .some(
            (t: any) =>
              t.eventId === eventId &&
              t.ownerHumanId === humanId &&
              ["VALID", "SCANNED", "LISTED"].includes(t.status),
          ),
      ),
    },
    seats: { findByIdsForUpdate: vi.fn(async () => []) },
  } as unknown as Repos;

  const idempotency = opts.idempotency ?? makeIdempotency();

  const deps: GrantVolunteerRewardDeps = {
    repos,
    clock: { now: () => NOW },
    idempotency: idempotency as any,
    mailer: mailer as any,
    publicAppUrl: "https://app.test",
    supportUrl: "https://support.test",
    ...(opts.tileServerUrl ? { tileServerUrl: opts.tileServerUrl } : {}),
  };

  return {
    deps,
    reward,
    signup,
    mailer,
    idempotency,
    txRepos,
    grantsById,
    createGrant,
    incrementGrantsUsed,
  };
}

const validInput = {
  signupId: SIGNUP_ID,
  rewardId: REWARD_ID,
  trigger: "ON_CHECK_IN" as const,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("grantVolunteerReward", () => {
  it("issues a $0 comp order + ticket, snapshots face value, and delivers the ticket email", async () => {
    const h = makeHarness();

    const result = await grantVolunteerReward(h.deps, validInput);

    expect(result.ok).toBe(true);
    expect(result.grantId).toBeTruthy();
    expect(result.skipped).toBeUndefined();

    // $0 COMP order minted through the existing path.
    expect((h.txRepos.orders as any).createPending).toHaveBeenCalledWith(
      expect.objectContaining({ source: "COMP", amountGrossCents: 0 }),
    );
    expect((h.txRepos.orders as any).markSucceeded).toHaveBeenCalled();

    // Grant carries the face-value snapshot + budget bumped.
    expect(h.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        rewardId: REWARD_ID,
        signupId: SIGNUP_ID,
        humanId: HUMAN_ID,
        contactEmail: "vol@example.com",
        faceValueCents: FACE_VALUE_CENTS,
      }),
    );
    expect(h.incrementGrantsUsed).toHaveBeenCalledWith(REWARD_ID);
    expect(h.reward.grantsUsed).toBe(1);

    // Delivery via the ticket.issued render/send path.
    expect(h.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.objectContaining({ key: "ticket.issued" }),
      }),
    );

    // Comp mint uses the system actor — no admin RBAC read at all.
    expect((h.txRepos.volunteering as any).getRewardForUpdate).toHaveBeenCalled();
  });

  it("renders the venue map in the comp email when a tileserver URL is threaded through", async () => {
    const h = makeHarness({
      eventCoords: { lat: 30.2672, lng: -97.7431 },
      tileServerUrl: "https://tiles.test",
    });

    const result = await grantVolunteerReward(h.deps, validInput);
    expect(result.ok).toBe(true);

    // Map parity with purchased-ticket emails: the static tile URL is composed
    // from the venue coords and reaches the ticket.issued render.
    expect(h.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.objectContaining({
          key: "ticket.issued",
          variables: expect.objectContaining({
            mapImageUrl:
              "https://tiles.test/styles/streets/static/-97.7431,30.2672,14/600x200.png",
          }),
        }),
      }),
    );
  });

  it("adds an /auth/complete claim link to the comp email for shadow recipients", async () => {
    // Shadow signup: no linked Human yet.
    const h = makeHarness({ signup: { humanId: null } });

    const result = await grantVolunteerReward(h.deps, validInput);
    expect(result.ok).toBe(true);

    expect(h.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.objectContaining({
          key: "ticket.issued",
          variables: expect.objectContaining({
            accountCompletionUrl:
              "https://app.test/auth/complete?email=vol%40example.com&src=volunteer-comp",
          }),
        }),
      }),
    );
  });

  it("does NOT add a claim link when the recipient already has an account", async () => {
    // Default harness signup carries humanId (a real account).
    const h = makeHarness();

    const result = await grantVolunteerReward(h.deps, validInput);
    expect(result.ok).toBe(true);

    const sent = h.mailer.send.mock.calls[0]?.[0] as {
      template: { variables: Record<string, unknown> };
    };
    expect(sent.template.variables.accountCompletionUrl).toBeUndefined();
  });

  it("omits the map when no tileserver URL is threaded (the gap this fixes)", async () => {
    // Same geocoded event, but no tileServerUrl on deps — the pre-fix state
    // where comp emails shipped without a venue map.
    const h = makeHarness({ eventCoords: { lat: 30.2672, lng: -97.7431 } });

    const result = await grantVolunteerReward(h.deps, validInput);
    expect(result.ok).toBe(true);

    const sent = h.mailer.send.mock.calls[0]?.[0] as {
      template: { variables: Record<string, unknown> };
    };
    expect(sent.template.variables.mapImageUrl).toBeUndefined();
  });

  it("resolves a shadow recipient via ensureGuestHuman and leaves grant.humanId null", async () => {
    const h = makeHarness({ signup: { humanId: null } });

    const result = await grantVolunteerReward(h.deps, validInput);

    expect(result.ok).toBe(true);
    expect((h.txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: "vol@example.com",
    });
    expect((h.txRepos.humans as any).update).toHaveBeenCalledWith(
      GUEST_HUMAN_ID,
      { name: "Vol Unteer" },
    );
    expect(h.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: null }),
    );
  });

  it("leaves a NEW shadow recipient unnamed when the signup has no contactName", async () => {
    const h = makeHarness({ signup: { humanId: null, contactName: null } });

    await grantVolunteerReward(h.deps, validInput);

    expect((h.txRepos.humans as any).ensureGuestHuman).toHaveBeenCalled();
    expect((h.txRepos.humans as any).update).not.toHaveBeenCalled();
  });

  it("a humanId-null signup whose email already has an account: comp goes to that account, no claim link, shadow=false", async () => {
    const h = makeHarness({ signup: { humanId: null } });
    (h.txRepos.humans as any).ensureGuestHuman.mockResolvedValueOnce({
      humanId: GUEST_HUMAN_ID,
      created: false,
    });

    await grantVolunteerReward(h.deps, validInput);

    expect((h.txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "volunteer_reward_granted",
        data: expect.objectContaining({
          recipientHumanId: GUEST_HUMAN_ID,
          shadow: false,
          resolvedByEmail: true,
        }),
      }),
    );
    expect(h.mailer.send).toHaveBeenCalled();
    expect(JSON.stringify(h.mailer.send.mock.calls)).not.toContain(
      "/auth/complete",
    );
  });

  it("never renames an EXISTING account whose email the shadow signup used", async () => {
    const h = makeHarness({ signup: { humanId: null } });
    (h.txRepos.humans as any).ensureGuestHuman.mockResolvedValueOnce({
      humanId: GUEST_HUMAN_ID,
      created: false,
    });

    await grantVolunteerReward(h.deps, validInput);

    expect((h.txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: "vol@example.com",
    });
    expect((h.txRepos.humans as any).update).not.toHaveBeenCalled();
  });

  it("double-fire under the same idempotency key issues exactly one comp", async () => {
    const h = makeHarness();

    const first = await grantVolunteerReward(h.deps, validInput);
    const second = await grantVolunteerReward(h.deps, validInput);

    expect(second.grantId).toBe(first.grantId);
    expect(h.createGrant).toHaveBeenCalledTimes(1);
    expect(h.incrementGrantsUsed).toHaveBeenCalledTimes(1);
    expect(h.reward.grantsUsed).toBe(1);
  });

  it("skips ALREADY_GRANTED when a live grant exists (DB backstop, cold idempotency)", async () => {
    const h = makeHarness();
    // First grant primes the grant row.
    const first = await grantVolunteerReward(h.deps, validInput);

    // Simulate a cold cache (fresh idempotency) — the DB pre-read must catch it.
    h.deps.idempotency = makeIdempotency() as any;

    const second = await grantVolunteerReward(h.deps, validInput);
    expect(second.skipped).toBe("ALREADY_GRANTED");
    expect(second.grantId).toBe(first.grantId);
    expect(h.createGrant).toHaveBeenCalledTimes(1);
  });

  it("skips BUDGET_EXHAUSTED without erroring and never overshoots the cap", async () => {
    // maxGrants = 1: the first signup consumes the only slot; the second is
    // skipped. Sequential firing against the shared reward row models the
    // FOR-UPDATE serialization (true-concurrent proof lives in the B1+B2
    // adapter lock test).
    const h = makeHarness({ reward: { maxGrants: 1 } });

    const first = await grantVolunteerReward(h.deps, {
      signupId: SIGNUP_ID,
      rewardId: REWARD_ID,
      trigger: "ON_CHECK_IN",
    });
    expect(first.skipped).toBeUndefined();
    expect(h.reward.grantsUsed).toBe(1);

    // Second signup — same reward, budget now full.
    (h.txRepos.volunteering as any).getSignup = vi.fn(async () =>
      makeSignup({ id: SIGNUP_ID_2 }),
    );

    const second = await grantVolunteerReward(h.deps, {
      signupId: SIGNUP_ID_2,
      rewardId: REWARD_ID,
      trigger: "ON_CHECK_IN",
    });

    expect(second.ok).toBe(true);
    expect(second.grantId).toBeNull();
    expect(second.skipped).toBe("BUDGET_EXHAUSTED");
    // Cap never exceeded, and no second comp minted.
    expect(h.reward.grantsUsed).toBe(1);
    expect(h.createGrant).toHaveBeenCalledTimes(1);
  });

  it("releases the idempotency lock on BUDGET_EXHAUSTED so a freed slot can retry", async () => {
    const idem = makeIdempotency();
    const h = makeHarness({ reward: { maxGrants: 0 }, idempotency: idem });

    const result = await grantVolunteerReward(h.deps, validInput);
    expect(result.skipped).toBe("BUDGET_EXHAUSTED");

    const key = `volunteer:reward:grant:${REWARD_ID}:${SIGNUP_ID}`;
    // The third argument is load-bearing: `fail()` HOLDS the key for 15
    // minutes at the adapters' default, so omitting it would lock this
    // (reward, signup) pair out of the very retry the skip exists to allow.
    expect(idem.fail).toHaveBeenCalledWith(key, "BUDGET_EXHAUSTED", 1);
    expect(idem.commit).not.toHaveBeenCalled();

    // Actually perform that retry: cap raised (a revoke freed a slot), same
    // key, one second later.
    idem.advance(1000);
    h.reward.maxGrants = 1;
    const retried = await grantVolunteerReward(h.deps, validInput);
    expect(retried.skipped).toBeUndefined();
    expect(retried.grantId).toEqual(expect.any(String));
  });

  it("skips INACTIVE rewards", async () => {
    const h = makeHarness({ reward: { active: false } });

    const result = await grantVolunteerReward(h.deps, validInput);
    expect(result.skipped).toBe("INACTIVE");
    expect(h.createGrant).not.toHaveBeenCalled();
  });

  it("skips REWARD_NOT_FOUND when the locked reward row is gone", async () => {
    const h = makeHarness();
    (h.txRepos.volunteering as any).getRewardForUpdate = vi.fn(
      async () => null,
    );

    const result = await grantVolunteerReward(h.deps, validInput);
    expect(result.skipped).toBe("REWARD_NOT_FOUND");
    expect(h.createGrant).not.toHaveBeenCalled();
  });

  it("does not fail the grant when delivery throws (email is post-commit)", async () => {
    const h = makeHarness();
    h.mailer.send = vi.fn(async (): Promise<{ id: string }> => {
      throw new Error("smtp down");
    });

    const result = await grantVolunteerReward(h.deps, validInput);
    expect(result.ok).toBe(true);
    expect(result.grantId).toBeTruthy();
    expect(h.reward.grantsUsed).toBe(1);
  });

  // ── Swallowed-failure reporting (CLAUDE.md error-reporting convention) ────
  //
  // Both branches below CATCH and return `{ ok: true }`. Without a reporter
  // they are invisible: the duplicate_grant race emitted nothing at all, and a
  // failed comp email only ever reached a log line. Same shape as the search
  // use cases' reporter tests.
  describe("swallowed-failure reporting", () => {
    /** Force the in-tx insert to lose the race an already-committed grant won. */
    function forceDuplicateGrantRace(h: ReturnType<typeof makeHarness>) {
      const raced = {
        id: "11111111-1111-4111-8111-111111111111",
        rewardId: REWARD_ID,
        signupId: SIGNUP_ID,
      };
      const duplicate = { code: "duplicate_grant", message: "duplicate_grant" };
      (h.txRepos.volunteering as any).createGrant = vi.fn(async () => {
        throw duplicate;
      });
      // The top-level pre-read must MISS (otherwise we short-circuit before
      // ever entering the transaction); the post-catch re-read finds the row
      // the winning transaction wrote.
      let call = 0;
      const lookup = vi.fn(async () => (call++ === 0 ? null : raced));
      (h.deps.repos as any).volunteering.getGrantByRewardAndSignup = lookup;
      (h.txRepos.volunteering as any).getGrantByRewardAndSignup = vi.fn(
        async () => null,
      );
      return { raced, duplicate };
    }

    it("reports the duplicate_grant race it swallows as ALREADY_GRANTED", async () => {
      const h = makeHarness();
      const { raced, duplicate } = forceDuplicateGrantRace(h);
      const reportError = vi.fn();
      h.deps.reportError = reportError;

      const result = await grantVolunteerReward(h.deps, validInput);

      // Caller still sees a success — that is the swallow being reported.
      expect(result).toEqual({
        ok: true,
        grantId: raced.id,
        skipped: "ALREADY_GRANTED",
      });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(duplicate, {
        tags: { useCase: "grantVolunteerReward", reason: "duplicate_grant" },
        extra: {
          rewardId: REWARD_ID,
          signupId: SIGNUP_ID,
          trigger: "ON_CHECK_IN",
          existingGrantId: raced.id,
        },
      });
    });

    it("still returns ALREADY_GRANTED when reportError is not wired", async () => {
      const h = makeHarness();
      const { raced } = forceDuplicateGrantRace(h);

      await expect(grantVolunteerReward(h.deps, validInput)).resolves.toEqual({
        ok: true,
        grantId: raced.id,
        skipped: "ALREADY_GRANTED",
      });
    });

    it("a throwing reporter never changes the duplicate_grant outcome", async () => {
      const h = makeHarness();
      const { raced } = forceDuplicateGrantRace(h);
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      h.deps.reportError = reportError;

      await expect(grantVolunteerReward(h.deps, validInput)).resolves.toEqual({
        ok: true,
        grantId: raced.id,
        skipped: "ALREADY_GRANTED",
      });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("reports a failed comp email without failing the durable grant", async () => {
      const h = makeHarness();
      const smtpDown = new Error("smtp down");
      h.mailer.send = vi.fn(async (): Promise<{ id: string }> => {
        throw smtpDown;
      });
      const reportError = vi.fn();
      h.deps.reportError = reportError;

      const result = await grantVolunteerReward(h.deps, validInput);

      expect(result.ok).toBe(true);
      expect(result.grantId).toBeTruthy();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        smtpDown,
        expect.objectContaining({
          tags: { useCase: "grantVolunteerReward", reason: "email_failed" },
        }),
      );
    });

    it("a throwing reporter never breaks the post-commit email swallow", async () => {
      const h = makeHarness();
      h.mailer.send = vi.fn(async (): Promise<{ id: string }> => {
        throw new Error("smtp down");
      });
      h.deps.reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });

      const result = await grantVolunteerReward(h.deps, validInput);
      expect(result.ok).toBe(true);
      expect(result.grantId).toBeTruthy();
    });

    it("does not report on the ordinary success path", async () => {
      const h = makeHarness();
      const reportError = vi.fn();
      h.deps.reportError = reportError;

      const result = await grantVolunteerReward(h.deps, validInput);

      expect(result.skipped).toBeUndefined();
      expect(reportError).not.toHaveBeenCalled();
    });
  });
});
