import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { platformRouter } from "../platform";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

/**
 * An authz fake that answers `hasStaffRole` the way the port does: a role
 * holder with no second factor is refused, with `secondFactorRequired`,
 * unless the caller passes `allowWithoutSecondFactor`.
 */
const portStaffRole = (actor: { holdsRole: boolean; enrolled: boolean }) =>
  vi.fn(async (input: { allowWithoutSecondFactor?: boolean }) => {
    if (!actor.holdsRole) return { allowed: false };
    if (input.allowWithoutSecondFactor || actor.enrolled) {
      return { allowed: true };
    }
    return { allowed: false, secondFactorRequired: true as const };
  });

describe("platform router", () => {
  describe("checkStaffAccess", () => {
    it("returns allowed=true with roles for a staff member", async () => {
      const hasStaffRole = vi.fn(async () => ({ allowed: true }));
      const getStaffRolesForHumanId = vi.fn(async () => ["ADMIN", "SUPPORT"]);
      const hasSecondFactorEnrolled = vi.fn(async () => true);

      const { caller } = createCaller(
        { checkStaffAccess: platformRouter.checkStaffAccess },
        {
          actorHumanId: ACTOR_ID,
          authz: {
            hasOrgRole: vi.fn(),
            requireOrgRole: vi.fn(),
            canEditEvent: vi.fn(),
            canManagePlace: vi.fn(),
            canFinanceOrg: vi.fn(),
            hasStaffRole,
          } as any,
          repos: {
            authz: { getStaffRolesForHumanId },
            humans: { hasSecondFactorEnrolled },
          } as any,
        },
      );

      const result = await caller.checkStaffAccess();

      expect(result.allowed).toBe(true);
      expect(result.roles).toEqual(["ADMIN", "SUPPORT"]);
      expect(result.secondFactorEnrolled).toBe(true);
      // A status probe: it asks for the role without the second-factor rule,
      // and reports enrolment in its own field.
      expect(hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"],
        allowWithoutSecondFactor: true,
      });
      expect(getStaffRolesForHumanId).toHaveBeenCalledWith(ACTOR_ID);
      expect(hasSecondFactorEnrolled).toHaveBeenCalledWith(ACTOR_ID);
    });

    it("returns allowed=true with secondFactorEnrolled=false for a staff member missing a 2nd factor", async () => {
      const hasStaffRole = vi.fn(async () => ({ allowed: true }));
      const getStaffRolesForHumanId = vi.fn(async () => ["ADMIN"]);
      const hasSecondFactorEnrolled = vi.fn(async () => false);

      const { caller } = createCaller(
        { checkStaffAccess: platformRouter.checkStaffAccess },
        {
          actorHumanId: ACTOR_ID,
          authz: {
            hasOrgRole: vi.fn(),
            requireOrgRole: vi.fn(),
            canEditEvent: vi.fn(),
            canManagePlace: vi.fn(),
            canFinanceOrg: vi.fn(),
            hasStaffRole,
          } as any,
          repos: {
            authz: { getStaffRolesForHumanId },
            humans: { hasSecondFactorEnrolled },
          } as any,
        },
      );

      const result = await caller.checkStaffAccess();

      expect(result.allowed).toBe(true);
      expect(result.secondFactorEnrolled).toBe(false);
    });

    // The port refuses an un-enrolled role holder by default. The shell needs
    // `allowed: true, secondFactorEnrolled: false` to send them to /enroll-2fa;
    // `allowed: false` would show "not staff" instead.
    it("still answers allowed=true for an un-enrolled staff member against a port that applies the second-factor rule", async () => {
      const hasStaffRole = portStaffRole({ holdsRole: true, enrolled: false });

      const { caller } = createCaller(
        { checkStaffAccess: platformRouter.checkStaffAccess },
        {
          actorHumanId: ACTOR_ID,
          authz: { hasStaffRole } as any,
          repos: {
            authz: { getStaffRolesForHumanId: vi.fn(async () => ["ADMIN"]) },
            humans: { hasSecondFactorEnrolled: vi.fn(async () => false) },
          } as any,
        },
      );

      await expect(caller.checkStaffAccess()).resolves.toMatchObject({
        allowed: true,
        roles: ["ADMIN"],
        secondFactorEnrolled: false,
      });
    });

    it("returns allowed=false for a non-staff user", async () => {
      const { caller } = createCaller(
        { checkStaffAccess: platformRouter.checkStaffAccess },
        {
          actorHumanId: ACTOR_ID,
          authz: {
            hasOrgRole: vi.fn(),
            requireOrgRole: vi.fn(),
            canEditEvent: vi.fn(),
            canManagePlace: vi.fn(),
            canFinanceOrg: vi.fn(),
            hasStaffRole: vi.fn(async () => ({ allowed: false })),
          } as any,
        },
      );

      const result = await caller.checkStaffAccess();

      expect(result.allowed).toBe(false);
      expect(result.roles).toEqual([]);
    });

    it("throws UNAUTHORIZED when no actor is present", async () => {
      const { caller } = createCaller(
        { checkStaffAccess: platformRouter.checkStaffAccess },
        {
          actorHumanId: null,
        },
      );

      await expect(caller.checkStaffAccess()).rejects.toThrow("unauthorized");
    });

    it("filters out USER role from returned roles", async () => {
      const { caller } = createCaller(
        { checkStaffAccess: platformRouter.checkStaffAccess },
        {
          actorHumanId: ACTOR_ID,
          authz: {
            hasOrgRole: vi.fn(),
            requireOrgRole: vi.fn(),
            canEditEvent: vi.fn(),
            canManagePlace: vi.fn(),
            canFinanceOrg: vi.fn(),
            hasStaffRole: vi.fn(async () => ({ allowed: true })),
          } as any,
          repos: {
            authz: {
              getStaffRolesForHumanId: vi.fn(async () => ["USER", "REVIEWER"]),
            },
            humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
          } as any,
        },
      );

      const result = await caller.checkStaffAccess();

      expect(result.allowed).toBe(true);
      expect(result.roles).toEqual(["REVIEWER"]);
    });
  });

  describe("listAuditLogs", () => {
    it("allows ADMIN and calls repos.audit.list with the actor id injected server-side", async () => {
      const hasStaffRole = vi.fn(async () => ({ allowed: true }));
      const list = vi.fn(async () => ({ items: [], total: 0 }));

      const { caller } = createCaller(
        { listAuditLogs: platformRouter.listAuditLogs },
        {
          actorHumanId: ACTOR_ID,
          authz: {
            hasOrgRole: vi.fn(),
            requireOrgRole: vi.fn(),
            canEditEvent: vi.fn(),
            canManagePlace: vi.fn(),
            canFinanceOrg: vi.fn(),
            hasStaffRole,
          } as any,
          repos: { audit: { list } } as any,
        },
      );

      const result = await caller.listAuditLogs({ entity: "event" });

      expect(result.items).toEqual([]);
      expect(hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN", "REVIEWER"],
      });
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ entity: "event" }),
      );
    });

    it("allows REVIEWER (read-only audit-trail review is core to the role)", async () => {
      const hasStaffRole = vi.fn(async () => ({ allowed: true }));
      const list = vi.fn(async () => ({ items: [], total: 0 }));

      const { caller } = createCaller(
        { listAuditLogs: platformRouter.listAuditLogs },
        {
          actorHumanId: ACTOR_ID,
          authz: {
            hasOrgRole: vi.fn(),
            requireOrgRole: vi.fn(),
            canEditEvent: vi.fn(),
            canManagePlace: vi.fn(),
            canFinanceOrg: vi.fn(),
            hasStaffRole,
          } as any,
          repos: { audit: { list } } as any,
        },
      );

      await expect(caller.listAuditLogs({})).resolves.toMatchObject({
        items: [],
      });
    });

    it("maps a non-staff (e.g. SUPPORT-only) actor's FORBIDDEN to a TRPCError", async () => {
      const hasStaffRole = vi.fn(async () => ({ allowed: false }));
      const list = vi.fn();

      const { caller } = createCaller(
        { listAuditLogs: platformRouter.listAuditLogs },
        {
          actorHumanId: ACTOR_ID,
          authz: {
            hasOrgRole: vi.fn(),
            requireOrgRole: vi.fn(),
            canEditEvent: vi.fn(),
            canManagePlace: vi.fn(),
            canFinanceOrg: vi.fn(),
            hasStaffRole,
          } as any,
          repos: { audit: { list } } as any,
        },
      );

      await expect(caller.listAuditLogs({})).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(list).not.toHaveBeenCalled();
    });

    it("throws UNAUTHORIZED when no actor is present", async () => {
      const { caller } = createCaller(
        { listAuditLogs: platformRouter.listAuditLogs },
        { actorHumanId: null },
      );

      await expect(caller.listAuditLogs({})).rejects.toThrow("unauthorized");
    });
  });

  describe("membership standing (ADMIN-only)", () => {
    const ORG_ID = "22222222-2222-4222-8222-222222222222";

    const staffAuthz = (allowed: boolean) =>
      ({
        hasOrgRole: vi.fn(),
        requireOrgRole: vi.fn(),
        canEditEvent: vi.fn(),
        canManagePlace: vi.fn(),
        canFinanceOrg: vi.fn(),
        hasStaffRole: vi.fn(async () => ({ allowed })),
      }) as any;

    const standingRow = {
      id: "standing-1",
      ownerOrgId: ORG_ID,
      ownerHumanId: null,
      suspended: true,
      suspendedAt: new Date("2026-08-10T12:00:00.000Z"),
      suspendedReason: "Dispute losses",
      reserveBps: 0,
      reserveReleaseDays: 90,
      overriddenBy: ACTOR_ID,
      overrideReason: "Dispute losses",
      createdAt: new Date("2026-08-10T12:00:00.000Z"),
      updatedAt: new Date("2026-08-10T12:00:00.000Z"),
    };

    const standingRepos = () => {
      const membershipStandings = {
        findForOwner: vi.fn(async () => null),
        upsertForOwner: vi.fn(async () => standingRow),
        listAll: vi.fn(async () => []),
      };
      const audit = { log: vi.fn() };
      return {
        membershipStandings,
        audit,
        organizations: {
          getById: vi.fn(async () => ({ id: ORG_ID, name: "Org" })),
          getByIds: vi.fn(async () => []),
        },
        humans: { getById: vi.fn(), getByIds: vi.fn(async () => []) },
        membershipTiers: { listOwnersWithTiers: vi.fn(async () => []) },
        disputes: { listMembershipExposureByOwner: vi.fn(async () => []) },
        tx: vi.fn(async (fn: any) => fn({ membershipStandings, audit })),
      };
    };

    it("suspend: enforces the ADMIN staff role in the use case and writes via tx", async () => {
      const repos = standingRepos();
      const authz = staffAuthz(true);
      const { caller } = createCaller(
        { suspendMembershipStanding: platformRouter.suspendMembershipStanding },
        { actorHumanId: ACTOR_ID, authz, repos: repos as any },
      );

      const result = await caller.suspendMembershipStanding({
        ownerType: "ORG",
        ownerId: ORG_ID,
        suspend: true,
        reason: "Dispute losses",
      });

      expect(result.standing).toMatchObject({
        ownerType: "ORG",
        ownerId: ORG_ID,
        suspended: true,
      });
      expect(authz.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN"],
      });
      // `overriddenBy` is deliberately NOT written by a suspension. It is the
      // manual-reserve-pin marker that the seasoning curve honours verbatim,
      // and a fresh standing row defaults `reserveBps` to 0 — so stamping it
      // here would drop the reserve to 0% on exactly the account we just
      // flagged as risky. The actor is recorded in the audit entry below.
      const suspendCall = (
        repos.membershipStandings.upsertForOwner as unknown as {
          mock: { calls: Array<[Record<string, unknown>]> };
        }
      ).mock.calls[0]![0];
      expect(suspendCall).toMatchObject({
        ownerOrgId: ORG_ID,
        suspended: true,
      });
      expect(suspendCall).not.toHaveProperty("overriddenBy");
      expect(repos.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "membership_standing",
          action: "suspended",
        }),
      );
    });

    it("suspend: a normal org admin (no platform staff role) gets FORBIDDEN and nothing is written", async () => {
      const repos = standingRepos();
      const { caller } = createCaller(
        { suspendMembershipStanding: platformRouter.suspendMembershipStanding },
        { actorHumanId: ACTOR_ID, authz: staffAuthz(false), repos: repos as any },
      );

      await expect(
        caller.suspendMembershipStanding({
          ownerType: "ORG",
          ownerId: ORG_ID,
          suspend: true,
          reason: "Should never land",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(repos.membershipStandings.upsertForOwner).not.toHaveBeenCalled();
      expect(repos.audit.log).not.toHaveBeenCalled();
    });

    it("override: non-staff gets FORBIDDEN", async () => {
      const repos = standingRepos();
      const { caller } = createCaller(
        {
          overrideMembershipStanding: platformRouter.overrideMembershipStanding,
        },
        { actorHumanId: ACTOR_ID, authz: staffAuthz(false), repos: repos as any },
      );

      await expect(
        caller.overrideMembershipStanding({
          ownerType: "ORG",
          ownerId: ORG_ID,
          reserveBps: 500,
          reserveReleaseDays: 90,
          reason: "Should never land",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(repos.membershipStandings.upsertForOwner).not.toHaveBeenCalled();
    });

    it("list: non-staff gets FORBIDDEN; staff gets rows", async () => {
      const repos = standingRepos();
      const { caller: nonStaff } = createCaller(
        { listMembershipStandings: platformRouter.listMembershipStandings },
        { actorHumanId: ACTOR_ID, authz: staffAuthz(false), repos: repos as any },
      );
      await expect(
        nonStaff.listMembershipStandings({}),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const { caller: staff } = createCaller(
        { listMembershipStandings: platformRouter.listMembershipStandings },
        { actorHumanId: ACTOR_ID, authz: staffAuthz(true), repos: repos as any },
      );
      await expect(staff.listMembershipStandings({})).resolves.toEqual({
        rows: [],
      });
    });

    it("throws UNAUTHORIZED when no actor is present", async () => {
      const { caller } = createCaller(
        { suspendMembershipStanding: platformRouter.suspendMembershipStanding },
        { actorHumanId: null },
      );

      await expect(
        caller.suspendMembershipStanding({
          ownerType: "ORG",
          ownerId: ORG_ID,
          suspend: true,
          reason: "No actor",
        }),
      ).rejects.toThrow("unauthorized");
    });
  });
});
