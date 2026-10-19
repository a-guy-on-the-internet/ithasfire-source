import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { createDbAuthZAdapter } from "../db-authz-adapter";

const actorHumanId = "087f7b1e-97a2-4c8c-9278-1a3d6cb6c663";
const orgId = "1f9708ec-d3d9-4a1e-b6da-38a481d4a8c5";
const otherOrgId = "3f643857-711a-47fc-bfda-6dccb4c4ac7a";
const eventId = "7a1410b4-7256-4df9-9fe4-0fbc6f1be6f0";
const placeId = "983f814a-8f30-4e78-aad9-0277a1b5dc7f";

type AuthZFunctions = {
  getOrgMembership: ReturnType<typeof vi.fn>;
  getEventOrgId: ReturnType<typeof vi.fn>;
  getEventHumanId: ReturnType<typeof vi.fn>;
  getHumanDelegation: ReturnType<typeof vi.fn>;
  getPlaceAccessContext: ReturnType<typeof vi.fn>;
  isPlaceVerifiedForOrg: ReturnType<typeof vi.fn>;
  getStaffRolesForHumanId: ReturnType<typeof vi.fn>;
  hasSecondFactorEnrolled: ReturnType<typeof vi.fn>;
};

function makeReposMocks(): { repos: Repos } & AuthZFunctions {
  const getOrgMembership = vi.fn();
  const getEventOrgId = vi.fn();
  const getEventHumanId = vi.fn();
  const getHumanDelegation = vi.fn();
  const getPlaceAccessContext = vi.fn();
  const isPlaceVerifiedForOrg = vi.fn();
  const getStaffRolesForHumanId = vi.fn();
  const hasSecondFactorEnrolled = vi.fn();

  const repos = {
    authz: {
      getOrgMembership,
      getStaffRolesForHumanId,
      getEventOrgId,
      getEventHumanId,
      getHumanDelegation,
      getPlaceAccessContext,
      isPlaceVerifiedForOrg,
    },
    humans: { hasSecondFactorEnrolled },
  } as unknown as Repos;

  return {
    repos,
    getOrgMembership,
    getStaffRolesForHumanId,
    hasSecondFactorEnrolled,
    getEventOrgId,
    getEventHumanId,
    getHumanDelegation,
    getPlaceAccessContext,
    isPlaceVerifiedForOrg,
  };
}

describe("DbAuthZAdapter", () => {
  let adapter: AuthZPort;
  let mocks: ReturnType<typeof makeReposMocks>;

  beforeEach(() => {
    mocks = makeReposMocks();
    adapter = createDbAuthZAdapter({ repos: mocks.repos });
  });

  describe("hasOrgRole", () => {
    it("allows membership satisfying any required role", async () => {
      mocks.getOrgMembership.mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role: "ADMIN",
      });

      const result = await adapter.hasOrgRole({
        actorHumanId,
        orgId,
        requiredRoles: ["EDITOR", "FINANCE"],
      });

      expect(result).toEqual({ allowed: true });
      expect(mocks.getOrgMembership).toHaveBeenCalledWith({
        orgId,
        humanId: actorHumanId,
      });
    });

    it("denies when membership is missing", async () => {
      mocks.getOrgMembership.mockResolvedValueOnce(null);

      const result = await adapter.hasOrgRole({
        actorHumanId,
        orgId,
        requiredRoles: ["OWNER"],
      });

      expect(result).toEqual({ allowed: false });
    });

    it("denies when membership role is insufficient", async () => {
      mocks.getOrgMembership.mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role: "VIEWER",
      });

      const result = await adapter.hasOrgRole({
        actorHumanId,
        orgId,
        requiredRoles: ["ADMIN"],
      });

      expect(result).toEqual({ allowed: false });
    });
  });

  describe("requireOrgRole", () => {
    it("resolves when actor satisfies the role", async () => {
      mocks.getOrgMembership.mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role: "OWNER",
      });

      await expect(
        adapter.requireOrgRole({
          actorHumanId,
          orgId,
          requiredRoles: ["ADMIN"],
        }),
      ).resolves.toBeUndefined();
    });

    it("throws a forbidden error when actor lacks the role", async () => {
      mocks.getOrgMembership.mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role: "VIEWER",
      });

      await expect(
        adapter.requireOrgRole({
          actorHumanId,
          orgId,
          requiredRoles: ["ADMIN"],
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  describe("canEditEvent", () => {
    it("denies when event is not associated with an org", async () => {
      mocks.getEventOrgId.mockResolvedValueOnce(null);
      mocks.getEventHumanId.mockResolvedValueOnce(null);

      const result = await adapter.canEditEvent({ actorHumanId, eventId });
      expect(result).toEqual({ allowed: false });
    });

    it("allows editors of the owning org", async () => {
      mocks.getEventOrgId.mockResolvedValueOnce(orgId);
      mocks.getOrgMembership.mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role: "EDITOR",
      });

      const result = await adapter.canEditEvent({ actorHumanId, eventId });
      expect(result).toEqual({ allowed: true });
    });

    it("denies viewers of the owning org", async () => {
      mocks.getEventOrgId.mockResolvedValueOnce(orgId);
      mocks.getOrgMembership.mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role: "VIEWER",
      });

      const result = await adapter.canEditEvent({ actorHumanId, eventId });
      expect(result).toEqual({ allowed: false });
    });

    it("allows the human owner of a human-owned event", async () => {
      mocks.getEventOrgId.mockResolvedValueOnce(null);
      mocks.getEventHumanId.mockResolvedValueOnce(actorHumanId);

      const result = await adapter.canEditEvent({ actorHumanId, eventId });
      expect(result).toEqual({ allowed: true });
      expect(mocks.getHumanDelegation).not.toHaveBeenCalled();
    });

    it.each([
      ["OWNER", true],
      ["ADMIN", true],
      ["EDITOR", true],
      ["VIEWER", false],
      ["FINANCE", false],
      ["SCANNER", false],
    ] as const)(
      "a %s delegate of the human owner → allowed=%s",
      async (role, allowed) => {
        const principalId = "principal-human";
        mocks.getEventOrgId.mockResolvedValueOnce(null);
        mocks.getEventHumanId.mockResolvedValueOnce(principalId);
        mocks.getHumanDelegation.mockResolvedValueOnce({
          orgId: principalId,
          humanId: actorHumanId,
          role,
        });

        const result = await adapter.canEditEvent({ actorHumanId, eventId });
        expect(result).toEqual({ allowed });
        expect(mocks.getHumanDelegation).toHaveBeenCalledWith({
          principalId,
          delegateId: actorHumanId,
        });
      },
    );
  });

  describe("canManagePlace", () => {
    it("denies when the place context does not exist", async () => {
      mocks.getPlaceAccessContext.mockResolvedValueOnce(null);

      const result = await adapter.canManagePlace({ actorHumanId, placeId });
      expect(result).toEqual({ allowed: false });
    });

    it("allows verified human owners", async () => {
      mocks.getPlaceAccessContext.mockResolvedValueOnce({
        placeId,
        owningOrgIds: [],
        verifiedHumanOwnerIds: [actorHumanId],
      });

      const result = await adapter.canManagePlace({ actorHumanId, placeId });
      expect(result).toEqual({ allowed: true });
      expect(mocks.getOrgMembership).not.toHaveBeenCalled();
    });

    it("allows members of an owning org with sufficient role", async () => {
      mocks.getPlaceAccessContext.mockResolvedValueOnce({
        placeId,
        owningOrgIds: [otherOrgId, orgId],
        verifiedHumanOwnerIds: [],
      });

      mocks.getOrgMembership.mockResolvedValueOnce(null).mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role: "ADMIN",
      });

      const result = await adapter.canManagePlace({ actorHumanId, placeId });
      expect(result).toEqual({ allowed: true });
      expect(mocks.getOrgMembership).toHaveBeenCalledTimes(2);
    });

    it("denies when neither ownership nor membership is satisfied", async () => {
      mocks.getPlaceAccessContext.mockResolvedValueOnce({
        placeId,
        owningOrgIds: [orgId],
        verifiedHumanOwnerIds: [],
      });

      mocks.getOrgMembership.mockResolvedValueOnce(null);

      const result = await adapter.canManagePlace({ actorHumanId, placeId });
      expect(result).toEqual({ allowed: false });
    });
  });

  describe("hasStaffRole", () => {
    it("allows a role holder with a second factor enrolled", async () => {
      mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["USER", "SUPPORT"]);
      mocks.hasSecondFactorEnrolled.mockResolvedValueOnce(true);

      const result = await adapter.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN", "SUPPORT"],
      });

      expect(result).toEqual({ allowed: true });
      expect(mocks.getStaffRolesForHumanId).toHaveBeenCalledWith(actorHumanId);
      expect(mocks.hasSecondFactorEnrolled).toHaveBeenCalledWith(actorHumanId);
    });

    it("refuses a role holder with no second factor, and says that is why", async () => {
      mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["ADMIN"]);
      mocks.hasSecondFactorEnrolled.mockResolvedValueOnce(false);

      const result = await adapter.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
      });

      expect(result).toEqual({ allowed: false, secondFactorRequired: true });
    });

    it("answers on the role alone when the caller opts out", async () => {
      mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["ADMIN"]);
      mocks.hasSecondFactorEnrolled.mockResolvedValue(false);

      const result = await adapter.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
        allowWithoutSecondFactor: true,
      });

      expect(result).toEqual({ allowed: true });
      expect(mocks.hasSecondFactorEnrolled).not.toHaveBeenCalled();
    });

    it("applies the rule when the opt-out is passed as false", async () => {
      mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["ADMIN"]);
      mocks.hasSecondFactorEnrolled.mockResolvedValueOnce(false);

      const result = await adapter.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
        allowWithoutSecondFactor: false,
      });

      expect(result).toEqual({ allowed: false, secondFactorRequired: true });
    });

    it("denies when the actor lacks all required staff roles, without an enrolment read", async () => {
      mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["USER"]);

      const result = await adapter.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN", "SUPPORT"],
      });

      // No `secondFactorRequired`: a non-staff caller is plain "not staff",
      // and costs the one role query.
      expect(result).toEqual({ allowed: false });
      expect(mocks.hasSecondFactorEnrolled).not.toHaveBeenCalled();
    });

    it("denies when the actor has no stored staff roles, without an enrolment read", async () => {
      mocks.getStaffRolesForHumanId.mockResolvedValueOnce([]);

      const result = await adapter.hasStaffRole({
        actorHumanId,
        requiredRoles: ["SUPPORT"],
      });

      expect(result).toEqual({ allowed: false });
      expect(mocks.hasSecondFactorEnrolled).not.toHaveBeenCalled();
    });

    it("does not ask a second factor of a match on USER, which is no staff role", async () => {
      mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["USER"]);

      const result = await adapter.hasStaffRole({
        actorHumanId,
        requiredRoles: ["USER"],
      });

      expect(result).toEqual({ allowed: true });
      expect(mocks.hasSecondFactorEnrolled).not.toHaveBeenCalled();
    });

    it("refuses an un-enrolled ADMIN on a request that names USER beside ADMIN", async () => {
      // The actor matched on ADMIN alone (they do not hold USER), so naming
      // USER in the request buys no exemption from the second-factor rule.
      mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["ADMIN"]);
      mocks.hasSecondFactorEnrolled.mockResolvedValueOnce(false);

      const result = await adapter.hasStaffRole({
        actorHumanId,
        requiredRoles: ["USER", "ADMIN"],
      });

      expect(result).toEqual({ allowed: false, secondFactorRequired: true });
      expect(mocks.hasSecondFactorEnrolled).toHaveBeenCalledWith(actorHumanId);
    });

    it("fails closed when the enrolment read throws", async () => {
      mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["ADMIN"]);
      mocks.hasSecondFactorEnrolled.mockRejectedValueOnce(new Error("db down"));

      await expect(
        adapter.hasStaffRole({ actorHumanId, requiredRoles: ["ADMIN"] }),
      ).rejects.toThrow("db down");
    });

    describe("with the dev bypass dep on", () => {
      beforeEach(() => {
        adapter = createDbAuthZAdapter({
          repos: mocks.repos,
          staffSecondFactorBypass: true,
        });
      });

      it("allows a role holder without reading enrolment", async () => {
        mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["ADMIN"]);
        mocks.hasSecondFactorEnrolled.mockResolvedValue(false);

        const result = await adapter.hasStaffRole({
          actorHumanId,
          requiredRoles: ["ADMIN"],
        });

        expect(result).toEqual({ allowed: true });
        expect(mocks.hasSecondFactorEnrolled).not.toHaveBeenCalled();
      });

      it("grants no role: a non-staff actor is still denied", async () => {
        mocks.getStaffRolesForHumanId.mockResolvedValueOnce(["USER"]);

        const result = await adapter.hasStaffRole({
          actorHumanId,
          requiredRoles: ["ADMIN"],
        });

        expect(result).toEqual({ allowed: false });
      });
    });
  });

  // The org, event and place probes share none of the staff answer's shape.
  describe("org probes", () => {
    it("never carry secondFactorRequired", async () => {
      mocks.getOrgMembership.mockResolvedValue(null);

      const org = await adapter.hasOrgRole({
        actorHumanId,
        orgId,
        requiredRoles: ["OWNER"],
      });
      const finance = await adapter.canFinanceOrg({ actorHumanId, orgId });

      expect(org).toEqual({ allowed: false });
      expect(finance).toEqual({ allowed: false });
      expect(mocks.hasSecondFactorEnrolled).not.toHaveBeenCalled();
    });
  });

  describe("canFinanceOrg", () => {
    it("allows finance, admin, or owner roles", async () => {
      mocks.getOrgMembership.mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role: "FINANCE",
      });

      const result = await adapter.canFinanceOrg({
        actorHumanId,
        orgId,
        scope: { action: "finance" },
      });

      expect(result).toEqual({ allowed: true });
    });

    it("denies insufficient roles", async () => {
      mocks.getOrgMembership.mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role: "VIEWER",
      });

      const result = await adapter.canFinanceOrg({
        actorHumanId,
        orgId,
        scope: { action: "finance" },
      });

      expect(result).toEqual({ allowed: false });
    });

    /**
     * The CLOSURE, pinned role by role — and it has a caller outside this file.
     *
     * `requireOwnerAccess` (packages/core/src/lib/rbac.ts) derives
     * `canFinance` from `ORG_FINANCE_ROLES` instead of calling this port, so
     * that admin search does not read the same membership row twice. That
     * refactor is only sound while this predicate answers exactly
     * `{OWNER, ADMIN, FINANCE}`.
     *
     * The equivalence CANNOT be gated from core: `ROLE_IMPLICATIONS` lives in
     * this package, and core must not import an adapter. So the guard lives
     * here, next to the table it guards — widen `ROLE_IMPLICATIONS` (say, add
     * FINANCE to EDITOR) and this goes red. Without it the two sides drift in
     * silence: the ports-based callers (list-org-orders, get-org-order,
     * org-refund-order-items, org-refund-full-order, list-org-settlements,
     * request-admin-export)
     * would start granting a role that admin search still denies.
     *
     * If you change the expected set here, change `ORG_FINANCE_ROLES` too.
     */
    it.each([
      ["OWNER", true],
      ["ADMIN", true],
      ["FINANCE", true],
      ["EDITOR", false],
      ["VIEWER", false],
      ["SCANNER", false],
    ] as const)("role %s => allowed %s", async (role, allowed) => {
      mocks.getOrgMembership.mockResolvedValueOnce({
        orgId,
        humanId: actorHumanId,
        role,
      });

      const result = await adapter.canFinanceOrg({
        actorHumanId,
        orgId,
        scope: { action: "finance" },
      });

      expect(result).toEqual({ allowed });
    });
  });
});
