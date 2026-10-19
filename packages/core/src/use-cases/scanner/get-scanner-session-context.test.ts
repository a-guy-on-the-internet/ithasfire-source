import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import type { EventRecord } from "@th/ports/repos/events";
import type { HumanWithIdentity } from "@th/ports/repos/humans";

import { getScannerSessionContext } from "./get-scanner-session-context";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const EVT_A1 = "00000000-0000-4000-8000-0000000000a2";
const EVT_OTHER = "00000000-0000-4000-8000-0000000000c2";
const ORG_OTHER = "00000000-0000-4000-8000-0000000000c1";

function human(name: string | null, email: string): HumanWithIdentity {
  return {
    human: {
      id: ACTOR,
      name,
      status: "ACTIVE",
      roles: [],
    } as HumanWithIdentity["human"],
    identity: {
      authUserId: "auth-1",
      email,
      emailVerified: true,
      phone: null,
      phoneVerified: false,
      username: null,
      displayUsername: null,
      image: null,
    },
  };
}

function makeDeps(opts: {
  human?: HumanWithIdentity | null;
  memberships?: OrgMembership[];
  orgs?: OrganizationRecord[];
  eventById?: Record<string, EventRecord | null>;
}) {
  const defaultHuman = human("Operator One", "op@example.com");
  const repos = {
    humans: {
      getByIdWithIdentity: vi.fn(async () =>
        opts.human === undefined ? defaultHuman : opts.human,
      ),
    },
    authz: {
      listOrgMembershipsByHumanId: vi.fn(async () => opts.memberships ?? []),
      // requireScannerAccessOnOrg consults this for the currentEvent path —
      // mirror whatever listOrgMembershipsByHumanId would have returned for
      // (orgId, humanId) so per-event auth uses the same fixture data.
      getOrgMembership: vi.fn(
        async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
          (opts.memberships ?? []).find(
            (m) => m.orgId === orgId && m.humanId === humanId,
          ) ?? null,
      ),
    },
    organizations: {
      getByIds: vi.fn(async (ids: string[]) =>
        (opts.orgs ?? []).filter((o) => ids.includes(o.id)),
      ),
    },
    events: {
      getById: vi.fn(async (id: string) => (opts.eventById ?? {})[id] ?? null),
    },
  };
  return repos as unknown as Repos;
}

describe("getScannerSessionContext", () => {
  it("returns operator + orgs without currentEvent when eventId omitted", async () => {
    const repos = makeDeps({
      memberships: [
        { orgId: ORG_A, humanId: ACTOR, role: "OWNER" },
        { orgId: ORG_B, humanId: ACTOR, role: "SCANNER" },
      ],
      orgs: [
        { id: ORG_A, name: "Alpha" } as OrganizationRecord,
        { id: ORG_B, name: "Bravo" } as OrganizationRecord,
      ],
    });

    const result = await getScannerSessionContext(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR },
    );

    expect(result.operator).toEqual({
      humanId: ACTOR,
      displayName: "Operator One",
      email: "op@example.com",
      scannerTermsAckAt: null,
      scannerTermsAckVersion: null,
    });
    expect(result.orgs).toHaveLength(2);
    expect(result.currentEvent).toBeUndefined();
  });

  it("passes scanner-terms ack state through on the operator", async () => {
    const ackAt = new Date("2026-06-01T12:00:00Z");
    const acked = human("Operator One", "op@example.com");
    acked.human.scannerTermsAckAt = ackAt;
    acked.human.scannerTermsAckVersion = "1";
    const repos = makeDeps({
      human: acked,
      memberships: [{ orgId: ORG_A, humanId: ACTOR, role: "SCANNER" }],
      orgs: [{ id: ORG_A, name: "Alpha" } as OrganizationRecord],
    });

    const result = await getScannerSessionContext(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR },
    );

    expect(result.operator.scannerTermsAckAt).toEqual(ackAt);
    expect(result.operator.scannerTermsAckVersion).toBe("1");
  });

  it("falls back to email when human has no name", async () => {
    const repos = makeDeps({
      human: human(null, "fallback@example.com"),
      memberships: [{ orgId: ORG_A, humanId: ACTOR, role: "ADMIN" }],
      orgs: [{ id: ORG_A, name: "Alpha" } as OrganizationRecord],
    });

    const result = await getScannerSessionContext(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR },
    );
    expect(result.operator.displayName).toBe("fallback@example.com");
  });

  it("includes currentEvent when eventId is on a scanner-eligible org", async () => {
    const startsAt = new Date("2026-07-01T18:00:00Z");
    const repos = makeDeps({
      memberships: [{ orgId: ORG_A, humanId: ACTOR, role: "ADMIN" }],
      orgs: [{ id: ORG_A, name: "Alpha" } as OrganizationRecord],
      eventById: {
        [EVT_A1]: {
          id: EVT_A1,
          orgId: ORG_A,
          humanId: null,
          title: "Festival",
          status: "PUBLISHED",
          startsAt,
          endsAt: null,
        } as EventRecord,
      },
    });

    const result = await getScannerSessionContext(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, eventId: EVT_A1 },
    );

    expect(result.currentEvent).toEqual({
      eventId: EVT_A1,
      orgId: ORG_A,
      eventName: "Festival",
      role: "ADMIN",
      startAt: startsAt,
      endAt: null,
      status: "PUBLISHED",
    });
  });

  it("throws forbidden when actor has zero scanner-eligible memberships", async () => {
    const repos = makeDeps({ memberships: [], orgs: [] });

    await expect(
      getScannerSessionContext(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  // The platform-ADMIN override needs a second factor. An ADMIN with none,
  // and no membership of their own, is refused under a code that says why.
  it("throws SECOND_FACTOR_REQUIRED for a platform ADMIN with no second factor and no memberships", async () => {
    const repos = makeDeps({ memberships: [], orgs: [] });
    const authz = {
      hasStaffRole: vi.fn(async () => ({
        allowed: false,
        secondFactorRequired: true as const,
      })),
    };

    await expect(
      getScannerSessionContext(
        { repos, authz: authz as unknown as AuthZPort },
        { actorHumanId: ACTOR },
      ),
    ).rejects.toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
    // The default probe: no opt-out, so the port applies the rule.
    expect(authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN"],
    });
  });

  it("throws not_found when eventId is provided but event missing", async () => {
    const repos = makeDeps({
      memberships: [{ orgId: ORG_A, humanId: ACTOR, role: "OWNER" }],
      orgs: [{ id: ORG_A, name: "Alpha" } as OrganizationRecord],
      eventById: {},
    });

    await expect(
      getScannerSessionContext(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, eventId: EVT_A1 },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws forbidden when eventId belongs to an org the actor cannot scan", async () => {
    const repos = makeDeps({
      memberships: [{ orgId: ORG_A, humanId: ACTOR, role: "OWNER" }],
      orgs: [{ id: ORG_A, name: "Alpha" } as OrganizationRecord],
      eventById: {
        [EVT_OTHER]: {
          id: EVT_OTHER,
          orgId: ORG_OTHER,
          humanId: null,
          title: "Other",
          status: "PUBLISHED",
          startsAt: new Date("2026-07-01T18:00:00Z"),
          endsAt: null,
        } as EventRecord,
      },
    });

    await expect(
      getScannerSessionContext(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, eventId: EVT_OTHER },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws forbidden when eventId belongs to a personal (non-org) event", async () => {
    const repos = makeDeps({
      memberships: [{ orgId: ORG_A, humanId: ACTOR, role: "OWNER" }],
      orgs: [{ id: ORG_A, name: "Alpha" } as OrganizationRecord],
      eventById: {
        [EVT_A1]: {
          id: EVT_A1,
          orgId: null,
          humanId: ACTOR,
          title: "Personal",
          status: "PUBLISHED",
          startsAt: new Date("2026-07-01T18:00:00Z"),
          endsAt: null,
        } as EventRecord,
      },
    });

    await expect(
      getScannerSessionContext(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, eventId: EVT_A1 },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ORG_OWNED" });
  });

  it("throws not_found when human cannot be resolved", async () => {
    const repos = makeDeps({ human: null });

    await expect(
      getScannerSessionContext(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR },
      ),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });
});
