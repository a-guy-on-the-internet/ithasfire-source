import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MembershipStandingRecord } from "@th/ports/repos/membership-standings";
import type { MembershipDisputeExposureRow } from "@th/ports/repos/disputes";
import type { MembershipOwnerTierStats } from "@th/ports/repos/membership-tiers";

import {
  getMembershipStandingOverview,
  overrideMembershipStanding,
  suspendMembershipStanding,
} from "../membership-standing-admin";
import { startMembership } from "../start-membership";
import { computeMembershipReserve } from "../../settlements/membership-reserve";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_OWNER_ID = "22222222-2222-4222-8222-222222222222";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-08-10T12:00:00.000Z");

// ─────────────────────────────────────────────────────────────────────────────
// Harness: an in-memory standings store shared by the admin use cases AND
// startMembership, so "suspend blocks signup" is exercised through the real
// enforcement site rather than asserted on a mock.
// ─────────────────────────────────────────────────────────────────────────────

type HarnessOptions = {
  staff?: boolean;
  tierStats?: MembershipOwnerTierStats[];
  exposure?: MembershipDisputeExposureRow[];
};

function makeHarness(options: HarnessOptions = {}) {
  const staff = options.staff ?? true;
  const standings = new Map<string, MembershipStandingRecord>();
  const auditEntries: Array<{
    entity: string;
    entityId?: string | null;
    action: string;
    data?: unknown;
  }> = [];

  const keyOf = (i: {
    ownerOrgId?: string | null;
    ownerHumanId?: string | null;
  }) => (i.ownerOrgId ? `ORG:${i.ownerOrgId}` : `HUMAN:${i.ownerHumanId}`);

  const membershipStandings = {
    findForOwner: vi.fn(
      async (i: { ownerOrgId?: string | null; ownerHumanId?: string | null }) =>
        standings.get(keyOf(i)) ?? null,
    ),
    upsertForOwner: vi.fn(
      async (i: {
        ownerOrgId?: string | null;
        ownerHumanId?: string | null;
        suspended?: boolean;
        suspendedAt?: Date | null;
        suspendedReason?: string | null;
        reserveBps?: number;
        reserveReleaseDays?: number;
        overriddenBy?: string | null;
        overrideReason?: string | null;
      }) => {
        const key = keyOf(i);
        const existing = standings.get(key);
        const row: MembershipStandingRecord = {
          id: existing?.id ?? `standing-${key}`,
          ownerOrgId: i.ownerOrgId ?? null,
          ownerHumanId: i.ownerHumanId ?? null,
          suspended: i.suspended ?? existing?.suspended ?? false,
          suspendedAt:
            i.suspendedAt !== undefined
              ? i.suspendedAt
              : (existing?.suspendedAt ?? null),
          suspendedReason:
            i.suspendedReason !== undefined
              ? i.suspendedReason
              : (existing?.suspendedReason ?? null),
          reserveBps: i.reserveBps ?? existing?.reserveBps ?? 0,
          reserveReleaseDays:
            i.reserveReleaseDays ?? existing?.reserveReleaseDays ?? 90,
          overriddenBy:
            i.overriddenBy !== undefined
              ? i.overriddenBy
              : (existing?.overriddenBy ?? null),
          overrideReason:
            i.overrideReason !== undefined
              ? i.overrideReason
              : (existing?.overrideReason ?? null),
          createdAt: existing?.createdAt ?? NOW,
          updatedAt: NOW,
        };
        standings.set(key, row);
        return row;
      },
    ),
    listAll: vi.fn(async () => [...standings.values()]),
  };

  const audit = {
    log: vi.fn(async (entry: (typeof auditEntries)[number]) => {
      auditEntries.push(entry);
    }),
  };

  const repos = {
    membershipStandings,
    membershipTiers: {
      listOwnersWithTiers: vi.fn(async () => options.tierStats ?? []),
    },
    disputes: {
      listMembershipExposureByOwner: vi.fn(async () => options.exposure ?? []),
    },
    humans: {
      getById: vi.fn(async (id: string) =>
        id === HUMAN_OWNER_ID ? { id, name: "Sole Artist" } : null,
      ),
      getByIds: vi.fn(async (ids: string[]) =>
        ids
          .filter((id) => id === HUMAN_OWNER_ID)
          .map((id) => ({ id, name: "Sole Artist" })),
      ),
    },
    organizations: {
      getById: vi.fn(async (id: string) =>
        id === ORG_ID ? { id, name: "DRKMTTR", slug: "drkmttr" } : null,
      ),
      getByIds: vi.fn(async (ids: string[]) =>
        ids
          .filter((id) => id === ORG_ID)
          .map((id) => ({ id, name: "DRKMTTR", slug: "drkmttr" })),
      ),
    },
    audit,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ membershipStandings, audit }),
    ),
  };

  const hasStaffRole = vi.fn(async () => ({ allowed: staff }));

  return {
    standings,
    auditEntries,
    membershipStandings,
    repos,
    hasStaffRole,
    deps: {
      repos: repos as unknown as Repos,
      authz: { hasStaffRole } as never,
      clock: { now: () => NOW },
      logger: undefined,
      reportError: vi.fn(),
    },
  };
}

/**
 * startMembership deps wired to the SAME standings store, so the admin
 * mutations are verified against the real enforcement site. The payees repo
 * answers "not ready", so a signup that clears the standing gate fails with
 * PAYEE_NOT_READY — a sentinel proving the request travelled PAST the
 * suspension check.
 */
function makeStartMembershipDeps(harness: ReturnType<typeof makeHarness>) {
  return {
    repos: {
      membershipTiers: {
        findById: vi.fn(async () => ({
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
        })),
      },
      membershipStandings: harness.membershipStandings,
      memberships: {
        findForMemberAndTier: vi.fn(async () => null),
      },
      payees: {
        getBySubject: vi.fn(async () => null),
        getById: vi.fn(async () => null),
      },
    } as unknown as Repos,
    membershipBilling: {} as never,
    taxRateLookup: {} as never,
    clock: { now: () => NOW },
  };
}

function baseSignupInput() {
  return {
    tierId: TIER_ID,
    memberHumanId: MEMBER_ID,
    billingCountryCode: "US",
    billingPostalCode: "37206",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suspend / unsuspend
// ─────────────────────────────────────────────────────────────────────────────

describe("suspendMembershipStanding", () => {
  it("suspend blocks startMembership end-to-end; unsuspend restores it", async () => {
    const harness = makeHarness();
    const signupDeps = makeStartMembershipDeps(harness);

    // Before any intervention the signup travels past the standing gate
    // (and fails at the payee-readiness sentinel instead).
    await expect(
      startMembership(signupDeps, baseSignupInput()),
    ).rejects.toMatchObject({ code: "PAYEE_NOT_READY" });

    await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspend: true,
      reason: "Dispute losses over threshold",
    });

    await expect(
      startMembership(signupDeps, baseSignupInput()),
    ).rejects.toMatchObject({ code: "MEMBERSHIPS_SUSPENDED" });

    await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspend: false,
      reason: "Resolved with owner",
    });

    // Past the standing gate again — suspension is lifted.
    await expect(
      startMembership(signupDeps, baseSignupInput()),
    ).rejects.toMatchObject({ code: "PAYEE_NOT_READY" });
  });

  it("stamps suspension fields WITHOUT the manual-override marker, and audits inside the tx", async () => {
    const harness = makeHarness();

    const { standing } = await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspend: true,
      reason: "Card-testing pattern",
    });

    expect(standing).toMatchObject({
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspended: true,
      suspendedAt: NOW,
      suspendedReason: "Card-testing pattern",
      // The reserve-pin marker belongs to overrideMembershipStanding ONLY.
      // Stamping it here would pin a fresh row's default reserveBps=0 onto
      // the highest-risk payee (see the regression test below).
      overriddenBy: null,
      overrideReason: null,
    });

    expect(harness.repos.tx).toHaveBeenCalledTimes(1);
    expect(harness.auditEntries).toEqual([
      expect.objectContaining({
        entity: "membership_standing",
        action: "suspended",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          ownerType: "ORG",
          ownerId: ORG_ID,
          reason: "Card-testing pattern",
          previousSuspended: false,
        }),
      }),
    ]);
  });

  it("unsuspend clears suspension fields, audits 'unsuspended', and leaves the marker unstamped", async () => {
    const harness = makeHarness();
    await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: HUMAN_OWNER_ID,
      suspend: true,
      reason: "Initial suspension",
    });

    const { standing } = await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: HUMAN_OWNER_ID,
      suspend: false,
      reason: "False positive",
    });

    expect(standing).toMatchObject({
      suspended: false,
      suspendedAt: null,
      suspendedReason: null,
      overriddenBy: null,
      overrideReason: null,
    });
    expect(harness.auditEntries[1]).toMatchObject({
      entity: "membership_standing",
      action: "unsuspended",
      data: expect.objectContaining({ previousSuspended: true }),
    });
  });

  it("REGRESSION: suspending a fresh owner does not pin their reserve to the row default 0%", async () => {
    // The bug: suspend used to stamp `overriddenBy`, and a NEWLY created
    // standing row defaults reserveBps=0 — so the seasoning curve's
    // manual-pin-always-wins rule dropped the suspended (highest-risk)
    // payee's reserve from 1000bps to 0.
    const harness = makeHarness();

    const { standing } = await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspend: true,
      reason: "Dispute losses over threshold",
    });
    expect(standing.overriddenBy).toBeNull();

    const decision = computeMembershipReserve({
      now: NOW,
      standing: {
        reserveBps: standing.reserveBps,
        reserveReleaseDays: standing.reserveReleaseDays,
        overriddenBy: standing.overriddenBy,
      },
      latestLostDisputeAt: null,
      firstMembershipPayoutAt: null,
      firstTicketingPayoutAt: null,
    });
    // Still the new-payee curve, not a manual 0% pin.
    expect(decision).toMatchObject({ basis: "new", reserveBps: 1000 });

    // Unsuspend must not stamp it either.
    const lifted = await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspend: false,
      reason: "Resolved with owner",
    });
    expect(lifted.standing.overriddenBy).toBeNull();

    // A REAL reserve override still pins — the marker path is intact.
    const overridden = await overrideMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      reserveBps: 250,
      reserveReleaseDays: 60,
      reason: "Deliberate pin",
    });
    const pinned = computeMembershipReserve({
      now: NOW,
      standing: {
        reserveBps: overridden.standing.reserveBps,
        reserveReleaseDays: overridden.standing.reserveReleaseDays,
        overriddenBy: overridden.standing.overriddenBy,
      },
      latestLostDisputeAt: null,
      firstMembershipPayoutAt: null,
      firstTicketingPayoutAt: null,
    });
    expect(pinned).toMatchObject({
      basis: "manual",
      reserveBps: 250,
      releaseDays: 60,
    });
  });

  it("suspend does not clobber an EXISTING reserve pin", async () => {
    const harness = makeHarness();
    await overrideMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      reserveBps: 2000,
      reserveReleaseDays: 120,
      reason: "Pinned high on purpose",
    });

    const { standing } = await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspend: true,
      reason: "Then suspended",
    });

    // The pin (and its reason) survives the suspend untouched.
    expect(standing).toMatchObject({
      suspended: true,
      reserveBps: 2000,
      reserveReleaseDays: 120,
      overriddenBy: ACTOR_ID,
      overrideReason: "Pinned high on purpose",
    });
  });

  it("refuses a non-staff actor with STAFF_ONLY and writes nothing", async () => {
    const harness = makeHarness({ staff: false });

    await expect(
      suspendMembershipStanding(harness.deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORG",
        ownerId: ORG_ID,
        suspend: true,
        reason: "Should never land",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expect(harness.membershipStandings.upsertForOwner).not.toHaveBeenCalled();
    expect(harness.auditEntries).toHaveLength(0);
  });

  it("requires a reason — a whitespace-only one is rejected before any write", async () => {
    const harness = makeHarness();

    await expect(
      suspendMembershipStanding(harness.deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORG",
        ownerId: ORG_ID,
        suspend: true,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(harness.membershipStandings.upsertForOwner).not.toHaveBeenCalled();
  });

  it("rejects an unknown owner with NOT_FOUND", async () => {
    const harness = makeHarness();

    await expect(
      suspendMembershipStanding(harness.deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORG",
        ownerId: "99999999-9999-4999-8999-999999999999",
        suspend: true,
        reason: "Typo'd id",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reserve override
// ─────────────────────────────────────────────────────────────────────────────

describe("overrideMembershipStanding", () => {
  it("persists the reserve, stamps the manual-override marker, audits with prior values", async () => {
    const harness = makeHarness();

    const { standing } = await overrideMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      reserveBps: 500,
      reserveReleaseDays: 90,
      reason: "New payee, no history",
    });

    expect(standing).toMatchObject({
      reserveBps: 500,
      reserveReleaseDays: 90,
      overriddenBy: ACTOR_ID,
      overrideReason: "New payee, no history",
      suspended: false,
    });
    expect(harness.auditEntries).toEqual([
      expect.objectContaining({
        entity: "membership_standing",
        action: "reserve_overridden",
        data: expect.objectContaining({
          reserveBps: 500,
          reserveReleaseDays: 90,
          previousReserveBps: 0,
          reason: "New payee, no history",
        }),
      }),
    ]);
  });

  it("bounds reserveBps to 0..10000 and reserveReleaseDays to 0..365", async () => {
    const harness = makeHarness();

    await expect(
      overrideMembershipStanding(harness.deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORG",
        ownerId: ORG_ID,
        reserveBps: 10_001,
        reserveReleaseDays: 90,
        reason: "Over 100%",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      overrideMembershipStanding(harness.deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORG",
        ownerId: ORG_ID,
        reserveBps: 500,
        reserveReleaseDays: 400,
        reason: "Held past a year",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(harness.membershipStandings.upsertForOwner).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const harness = makeHarness();

    await expect(
      overrideMembershipStanding(harness.deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORG",
        ownerId: ORG_ID,
        reserveBps: 500,
        reserveReleaseDays: 90,
        reason: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does NOT clear an existing suspension when only the reserve changes", async () => {
    const harness = makeHarness();
    await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspend: true,
      reason: "Suspended first",
    });

    const { standing } = await overrideMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      reserveBps: 250,
      reserveReleaseDays: 60,
      reason: "Reserve while suspended",
    });

    expect(standing).toMatchObject({
      suspended: true,
      reserveBps: 250,
      reserveReleaseDays: 60,
    });
  });

  it("refuses a non-staff actor", async () => {
    const harness = makeHarness({ staff: false });

    await expect(
      overrideMembershipStanding(harness.deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORG",
        ownerId: ORG_ID,
        reserveBps: 500,
        reserveReleaseDays: 90,
        reason: "Should never land",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Overview
// ─────────────────────────────────────────────────────────────────────────────

describe("getMembershipStandingOverview", () => {
  const twoOwnerFixtures = (): HarnessOptions => ({
    tierStats: [
      {
        ownerOrgId: ORG_ID,
        ownerHumanId: null,
        tierCount: 2,
        activeTierCount: 1,
        memberCount: 12,
      },
      {
        ownerOrgId: null,
        ownerHumanId: HUMAN_OWNER_ID,
        tierCount: 1,
        activeTierCount: 1,
        memberCount: 3,
      },
    ],
    exposure: [
      // Org: 2 lost ($40.00 disputed, $30.00 fees) + 1 open ($15.00, no fee
      // yet — the fee typically lands at funds_withdrawn).
      {
        ownerOrgId: ORG_ID,
        ownerHumanId: null,
        status: "LOST",
        disputeCount: 2,
        amountCents: 4000,
        feeCents: 3000,
      },
      {
        ownerOrgId: ORG_ID,
        ownerHumanId: null,
        status: "OPEN",
        disputeCount: 1,
        amountCents: 1500,
        feeCents: 0,
      },
      // Human owner: one WON dispute — total only, neither open nor lost.
      {
        ownerOrgId: null,
        ownerHumanId: HUMAN_OWNER_ID,
        status: "WON",
        disputeCount: 1,
        amountCents: 1000,
        feeCents: 0,
      },
    ],
  });

  it("aggregates per owner with NO cross-owner blending, splits lost vs open", async () => {
    const harness = makeHarness(twoOwnerFixtures());

    const { rows } = await getMembershipStandingOverview(harness.deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(rows).toHaveLength(2);

    // Sorted riskiest-first: the org's exposure (5500 + 3000) beats the
    // human's (1000 + 0).
    const [org, human] = rows;
    expect(org).toMatchObject({
      ownerType: "ORG",
      ownerId: ORG_ID,
      ownerLabel: "DRKMTTR",
      tierCount: 2,
      activeTierCount: 1,
      memberCount: 12,
      disputeCount: 3,
      disputeAmountCents: 5500,
      disputeFeeCents: 3000,
      lostDisputeCount: 2,
      lostDisputeAmountCents: 4000,
      lostDisputeFeeCents: 3000,
      openDisputeCount: 1,
      openDisputeAmountCents: 1500,
      openDisputeFeeCents: 0,
    });
    expect(human).toMatchObject({
      ownerType: "HUMAN",
      ownerId: HUMAN_OWNER_ID,
      ownerLabel: "Sole Artist",
      memberCount: 3,
      disputeCount: 1,
      disputeAmountCents: 1000,
      disputeFeeCents: 0,
      // WON: counted in the total, in neither risk bucket.
      lostDisputeCount: 0,
      openDisputeCount: 0,
    });
  });

  it("surfaces standing (suspension + reserve) and defaults when no row exists", async () => {
    const harness = makeHarness(twoOwnerFixtures());
    await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspend: true,
      reason: "Threshold crossed",
    });

    const { rows } = await getMembershipStandingOverview(harness.deps, {
      actorHumanId: ACTOR_ID,
    });

    const org = rows.find((r) => r.ownerId === ORG_ID)!;
    const human = rows.find((r) => r.ownerId === HUMAN_OWNER_ID)!;
    expect(org).toMatchObject({
      suspended: true,
      suspendedReason: "Threshold crossed",
      // Suspension does not stamp the reserve-pin marker.
      overriddenBy: null,
    });
    // No standing row: schema defaults, and null means "nothing wrong".
    expect(human).toMatchObject({
      suspended: false,
      reserveBps: 0,
      reserveReleaseDays: 90,
      overriddenBy: null,
    });
  });

  it("keeps a standing-only owner visible after every tier is gone", async () => {
    const harness = makeHarness(); // no tiers, no disputes
    await suspendMembershipStanding(harness.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORG",
      ownerId: ORG_ID,
      suspend: true,
      reason: "Suspended, then deleted their tiers",
    });

    const { rows } = await getMembershipStandingOverview(harness.deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: ORG_ID,
      suspended: true,
      tierCount: 0,
    });
  });

  it("swallows a label-lookup failure, keeps rows, and REPORTS it", async () => {
    const harness = makeHarness(twoOwnerFixtures());
    harness.repos.organizations.getByIds.mockRejectedValueOnce(
      new Error("db blip"),
    );

    const { rows } = await getMembershipStandingOverview(harness.deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ownerLabel === null)).toBe(true);
    expect(harness.deps.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "getMembershipStandingOverview",
        }),
      }),
    );
  });

  it("refuses a non-staff actor", async () => {
    const harness = makeHarness({ staff: false });

    await expect(
      getMembershipStandingOverview(harness.deps, { actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });
});
