import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  EventVolunteerRoleWithShiftsRecord,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";
import type { NotifyOutput } from "../comms/notify";

import {
  reviewVolunteerSignup,
  checkInVolunteer,
  withdrawVolunteerSignup,
} from "./volunteer-signups";
import type {
  VolunteerRewardHooks,
  VolunteerSignupDeps,
} from "./volunteer-signups";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000040";
const EVENT_ASK_ID = "00000000-0000-4000-8000-000000000070";
const REWARD_ID = "00000000-0000-4000-8000-000000000080";
const GRANT_ID = "00000000-0000-4000-8000-000000000081";
const NOW = new Date("2026-07-02T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseEvent = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Summer Fest",
  status: "PUBLISHED",
  startsAt: new Date("2026-07-10T18:00:00Z"),
  endsAt: new Date("2026-07-10T23:00:00Z"),
} as unknown as EventRecord;

const baseRole = {
  id: ROLE_ID,
  eventId: EVENT_ID,
  askId: EVENT_ASK_ID,
  templateId: null,
  name: "Security",
  description: null,
  capacity: 10,
  autoApprove: null,
  defaultHours: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
} as unknown as EventVolunteerRoleWithShiftsRecord;

/** Event-native signup that ALSO carries the backfilled EVENT ask id. */
function makeSignup(overrides: Record<string, unknown> = {}): VolunteerSignupRecord {
  return {
    id: SIGNUP_ID,
    eventId: EVENT_ID,
    askId: EVENT_ASK_ID,
    roleId: ROLE_ID,
    shiftId: null,
    groupId: null,
    humanId: ACTOR_ID,
    contactEmail: "vol@example.com",
    contactName: "Vol Unteer",
    contactPhone: null,
    smsOptIn: false,
    status: "PENDING",
    hoursWorked: null,
    answers: {},
    reviewerHumanId: null,
    reviewedAt: null,
    checkedInAt: null,
    notes: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as VolunteerSignupRecord;
}

function makeReward(overrides: Record<string, unknown> = {}) {
  return {
    id: REWARD_ID,
    askId: EVENT_ASK_ID,
    roleId: null,
    ticketTypeId: "tt",
    trigger: "ON_APPROVAL" as const,
    maxGrants: null,
    grantsUsed: 0,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const NOTIFY_RESULT: NotifyOutput = {
  ok: true,
  variant: "volunteer.signup-approved",
  category: "transactional",
  scope: { kind: "EVENT", eventId: EVENT_ID },
  inApp: { status: "skipped", reason: "no_adapter" },
};

const allowingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

// ── Harness ──────────────────────────────────────────────────────────────────

function makeHarness(opts: {
  signup?: Record<string, unknown>;
  reward?: Record<string, unknown> | null;
  grants?: any[];
  withRewards?: boolean;
} = {}) {
  const signup = makeSignup(opts.signup);
  const reward = opts.reward === null ? null : makeReward(opts.reward ?? {});

  const txRepos = {
    events: { getById: vi.fn(async () => baseEvent) },
    eventHumans: {
      attach: vi.fn(async () => ({ id: "eh" })),
      detach: vi.fn(async () => undefined),
      listByEvent: vi.fn(async () => []),
    },
    humans: { getById: vi.fn(async () => ({ id: ACTOR_ID, name: "Reviewer" })) },
    authz: { getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })) },
    volunteering: {
      getSignup: vi.fn(async () => signup),
      getEventRole: vi.fn(async () => baseRole),
      getShift: vi.fn(async () => null),
      getAsk: vi.fn(async () => null),
      countAcceptedOccupancy: vi.fn(async () => 0),
      countPendingSignups: vi.fn(async () => 0),
      // Occurrence-claim cascade (generic-volunteer-shifts-occurrences
      // FR-003) — withdraw flips future claims in the same tx.
      withdrawFutureClaimsBySignup: vi.fn(async () => 0),
      updateSignupStatus: vi.fn(async (id: string, input: any) => ({
        ...signup,
        ...input,
        id,
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
  };

  const grant = vi.fn(async () => ({ ok: true, grantId: GRANT_ID }));
  const revoke = vi.fn(async () => ({ ok: true }));
  const rewards: VolunteerRewardHooks = { grant, revoke };

  const repos = {
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as unknown as TxRepos),
    ),
    volunteering: {
      getRewardForSignup: vi.fn(async () => reward),
      listGrantsBySignup: vi.fn(async () => opts.grants ?? []),
    },
  } as unknown as Repos;

  const deps: VolunteerSignupDeps = {
    repos,
    authz: allowingAuthz,
    clock: { now: () => NOW },
    notify: vi.fn(async () => NOTIFY_RESULT),
    appBaseUrl: "https://test.local",
    ...(opts.withRewards === false ? {} : { rewards }),
  };

  return { deps, repos, txRepos, grant, revoke };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("comp-reward triggers", () => {
  describe("ON_APPROVAL (review)", () => {
    it("fires a grant when an approved signup has an active ON_APPROVAL reward", async () => {
      const h = makeHarness({ reward: { trigger: "ON_APPROVAL" } });

      await reviewVolunteerSignup(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        decision: "APPROVED",
      });

      expect(
        (h.repos.volunteering as any).getRewardForSignup,
      ).toHaveBeenCalledWith(EVENT_ASK_ID, ROLE_ID);
      expect(h.grant).toHaveBeenCalledWith({
        signupId: SIGNUP_ID,
        rewardId: REWARD_ID,
        trigger: "ON_APPROVAL",
      });
    });

    it("does NOT fire when the reward's trigger is ON_CHECK_IN", async () => {
      const h = makeHarness({ reward: { trigger: "ON_CHECK_IN" } });

      await reviewVolunteerSignup(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        decision: "APPROVED",
      });

      expect(h.grant).not.toHaveBeenCalled();
    });

    it("does NOT fire on a REJECTED decision", async () => {
      const h = makeHarness({ reward: { trigger: "ON_APPROVAL" } });

      await reviewVolunteerSignup(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        decision: "REJECTED",
      });

      expect(h.grant).not.toHaveBeenCalled();
    });

    it("does NOT fire when there is no reward configured", async () => {
      const h = makeHarness({ reward: null });

      await reviewVolunteerSignup(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        decision: "APPROVED",
      });

      expect(h.grant).not.toHaveBeenCalled();
    });

    it("does not fail the review when the grant hook throws (post-commit)", async () => {
      const h = makeHarness({ reward: { trigger: "ON_APPROVAL" } });
      h.grant.mockRejectedValueOnce(new Error("grant boom"));

      const result = await reviewVolunteerSignup(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        decision: "APPROVED",
      });

      expect(result.status).toBe("APPROVED");
    });

    it("is a no-op when reward automation is not wired", async () => {
      const h = makeHarness({
        reward: { trigger: "ON_APPROVAL" },
        withRewards: false,
      });

      await reviewVolunteerSignup(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        decision: "APPROVED",
      });

      expect(
        (h.repos.volunteering as any).getRewardForSignup,
      ).not.toHaveBeenCalled();
    });
  });

  describe("ON_CHECK_IN (check-in)", () => {
    it("fires a grant when a checked-in signup has an active ON_CHECK_IN reward", async () => {
      const h = makeHarness({
        signup: { status: "APPROVED" },
        reward: { trigger: "ON_CHECK_IN" },
      });

      await checkInVolunteer(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
      });

      expect(h.grant).toHaveBeenCalledWith({
        signupId: SIGNUP_ID,
        rewardId: REWARD_ID,
        trigger: "ON_CHECK_IN",
      });
    });

    it("does NOT fire when the reward's trigger is ON_APPROVAL", async () => {
      const h = makeHarness({
        signup: { status: "APPROVED" },
        reward: { trigger: "ON_APPROVAL" },
      });

      await checkInVolunteer(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
      });

      expect(h.grant).not.toHaveBeenCalled();
    });
  });

  describe("WITHDRAWN (withdraw → revoke)", () => {
    it("revokes a GRANTED grant on withdrawal", async () => {
      const h = makeHarness({
        signup: { status: "APPROVED" },
        grants: [{ id: GRANT_ID, status: "GRANTED" }],
      });

      await withdrawVolunteerSignup(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
      });

      expect(h.revoke).toHaveBeenCalledWith({
        grantId: GRANT_ID,
        reason: "signup_withdrawn",
      });
    });

    it("does NOT revoke a REDEEMED grant", async () => {
      const h = makeHarness({
        signup: { status: "APPROVED" },
        grants: [{ id: GRANT_ID, status: "REDEEMED" }],
      });

      await withdrawVolunteerSignup(h.deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
      });

      expect(h.revoke).not.toHaveBeenCalled();
    });
  });
});
