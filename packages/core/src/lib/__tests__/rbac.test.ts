import { describe, it, expect, vi } from "vitest";
import {
  ORG_ANY_ROLE,
  ORG_FINANCE_ROLES,
  requireOrgMembership,
  ORG_SCAN_ROLES,
  requireOwnerAccess,
  requirePlatformStaff,
  requireScannerAccessOnOrg,
} from "../rbac";
import type { OrgMembership, OrgRole } from "@th/ports/repos/authz";

// ─────────────────────────────────────────────────────────────────────────────
// requireOrgMembership
// ─────────────────────────────────────────────────────────────────────────────

describe("requireOrgMembership", () => {
  const orgId = "org-1";
  const actorHumanId = "human-1";

  function mockRepos(membership: OrgMembership | null) {
    return {
      authz: {
        getOrgMembership: vi.fn(async () => membership),
      },
    };
  }

  it("returns the membership when the actor holds a matching role", async () => {
    const membership: OrgMembership = {
      orgId,
      humanId: actorHumanId,
      role: "ADMIN",
    };
    const repos = mockRepos(membership);

    const result = await requireOrgMembership({
      repos,
      orgId,
      actorHumanId,
      roles: ["OWNER", "ADMIN", "EDITOR"],
    });

    expect(result).toEqual(membership);
    expect(repos.authz.getOrgMembership).toHaveBeenCalledWith({
      orgId,
      humanId: actorHumanId,
    });
  });

  it("throws forbidden when the actor is not a member", async () => {
    const repos = mockRepos(null);

    await expect(
      requireOrgMembership({ repos, orgId, actorHumanId, roles: ["OWNER"] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws forbidden when the actor role is not in the allowed list", async () => {
    const repos = mockRepos({ orgId, humanId: actorHumanId, role: "VIEWER" });

    await expect(
      requireOrgMembership({
        repos,
        orgId,
        actorHumanId,
        roles: ["OWNER", "ADMIN"],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("uses a custom error message when provided", async () => {
    const repos = mockRepos(null);

    await expect(
      requireOrgMembership({
        repos,
        orgId,
        actorHumanId,
        roles: ["OWNER"],
        errorMessage: "not_authorized_for_org",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("accepts any single matching role", async () => {
    const membership: OrgMembership = {
      orgId,
      humanId: actorHumanId,
      role: "SCANNER",
    };
    const repos = mockRepos(membership);

    const result = await requireOrgMembership({
      repos,
      orgId,
      actorHumanId,
      roles: ["SCANNER"],
    });

    expect(result.role).toBe("SCANNER");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireOwnerAccess
// ─────────────────────────────────────────────────────────────────────────────

describe("requireOwnerAccess", () => {
  const orgId = "org-1";
  const actorHumanId = "human-1";
  const ALL_ROLES: OrgRole[] = [
    "OWNER",
    "ADMIN",
    "EDITOR",
    "VIEWER",
    "FINANCE",
    "SCANNER",
  ];

  function mockRepos(membership: OrgMembership | null) {
    return {
      authz: { getOrgMembership: vi.fn(async () => membership) },
    };
  }

  /**
   * A restatement of what `canFinanceOrg` answers today, HAND-COPIED from
   * `packages/adapters/src/authz/db-authz-adapter.ts` (`ROLE_IMPLICATIONS` +
   * `satisfiesAny(role, ["OWNER","ADMIN","FINANCE"])`).
   *
   * Read this for what it is: a duplicated table. It is NOT independent and it
   * canNOT detect drift — core must not import an adapter, so editing
   * `ROLE_IMPLICATIONS` leaves every assertion here green by construction.
   * What it does pin is that `canFinance` follows THIS table, i.e. that the
   * derivation in `requireOwnerAccess` is itself correct.
   *
   * The drift guard lives where the table does: "role %s => allowed %s" in
   * `packages/adapters/src/authz/__tests__/db-authz-adapter.test.ts` pins the
   * closure to exactly `{OWNER, ADMIN, FINANCE}`. Change one, change both.
   */
  const ROLE_IMPLICATIONS: Record<OrgRole, readonly OrgRole[]> = {
    OWNER: ["OWNER", "ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"],
    ADMIN: ["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"],
    EDITOR: ["EDITOR", "VIEWER"],
    VIEWER: ["VIEWER"],
    FINANCE: ["FINANCE"],
    SCANNER: ["SCANNER"],
  };
  const canFinanceOrgWouldAnswer = (role: OrgRole): boolean =>
    (["OWNER", "ADMIN", "FINANCE"] as OrgRole[]).some((required) =>
      ROLE_IMPLICATIONS[role].includes(required),
    );

  it("returns the membership and ORGANIZATION discriminant for an org member", async () => {
    const membership: OrgMembership = { orgId, humanId: actorHumanId, role: "EDITOR" };
    const repos = mockRepos(membership);

    const result = await requireOwnerAccess({
      repos,
      ownerType: "ORGANIZATION",
      ownerId: orgId,
      actorHumanId,
      roles: ORG_ANY_ROLE,
    });

    expect(result).toEqual({
      ownerType: "ORGANIZATION",
      membership,
      canFinance: false,
    });
    expect(repos.authz.getOrgMembership).toHaveBeenCalledTimes(1);
  });

  it("derives canFinance identically to canFinanceOrg for EVERY org role", async () => {
    for (const role of ALL_ROLES) {
      const repos = mockRepos({ orgId, humanId: actorHumanId, role });

      const result = await requireOwnerAccess({
        repos,
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        actorHumanId,
        roles: ORG_ANY_ROLE,
      });

      expect(result.canFinance, `role ${role}`).toBe(
        canFinanceOrgWouldAnswer(role),
      );
      // ...and the derivation really is ORG_FINANCE_ROLES, not a local literal.
      expect(result.canFinance, `role ${role}`).toBe(
        ORG_FINANCE_ROLES.includes(role),
      );
      // ONE read per authorization, always.
      expect(repos.authz.getOrgMembership).toHaveBeenCalledTimes(1);
    }
  });

  it("returns a null membership (never a fake one) for a HUMAN owner", async () => {
    const repos = mockRepos(null);

    const result = await requireOwnerAccess({
      repos,
      ownerType: "HUMAN",
      ownerId: actorHumanId,
      actorHumanId,
      roles: ORG_FINANCE_ROLES,
    });

    expect(result).toEqual({
      ownerType: "HUMAN",
      membership: null,
      canFinance: true,
    });
    // There is no org to read a membership from.
    expect(repos.authz.getOrgMembership).not.toHaveBeenCalled();
  });

  it("throws NOT_RESOURCE_OWNER when the actor is not the human owner", async () => {
    const repos = mockRepos(null);

    await expect(
      requireOwnerAccess({
        repos,
        ownerType: "HUMAN",
        ownerId: "someone-else",
        actorHumanId,
        roles: ORG_ANY_ROLE,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(repos.authz.getOrgMembership).not.toHaveBeenCalled();
  });

  it("throws (rather than returning canFinance:false) when the org role is insufficient", async () => {
    const repos = mockRepos({ orgId, humanId: actorHumanId, role: "VIEWER" });

    await expect(
      requireOwnerAccess({
        repos,
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        actorHumanId,
        roles: ORG_FINANCE_ROLES,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws INSUFFICIENT_ROLE for a non-member org actor", async () => {
    const repos = mockRepos(null);

    await expect(
      requireOwnerAccess({
        repos,
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        actorHumanId,
        roles: ORG_ANY_ROLE,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requirePlatformStaff
// ─────────────────────────────────────────────────────────────────────────────

describe("requirePlatformStaff", () => {
  const actorHumanId = "human-1";

  function mockAuthz(allowed: boolean) {
    return {
      hasStaffRole: vi.fn(async () => ({ allowed })),
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(),
      canFinanceOrg: vi.fn(),
    } as any;
  }

  it("resolves when the actor has a matching staff role", async () => {
    const authz = mockAuthz(true);

    await expect(
      requirePlatformStaff({
        authz,
        actorHumanId,
        roles: ["ADMIN"],
      }),
    ).resolves.toBeUndefined();

    expect(authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId,
      requiredRoles: ["ADMIN"],
    });
  });

  it("throws forbidden when the actor lacks the staff role", async () => {
    const authz = mockAuthz(false);

    await expect(
      requirePlatformStaff({
        authz,
        actorHumanId,
        roles: ["ADMIN"],
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("uses a custom error message when provided", async () => {
    const authz = mockAuthz(false);

    await expect(
      requirePlatformStaff({
        authz,
        actorHumanId,
        roles: ["ADMIN"],
        errorMessage: "platform_admin_required",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("passes multiple roles to the authz port", async () => {
    const authz = mockAuthz(true);

    await requirePlatformStaff({
      authz,
      actorHumanId,
      roles: ["ADMIN", "REVIEWER", "SUPPORT"],
    });

    expect(authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId,
      requiredRoles: ["ADMIN", "REVIEWER", "SUPPORT"],
    });
  });

  // The authz port refuses a role holder with no passkey or TOTP enrolled and
  // says why. That refusal is not "you are not staff", so it gets its own code
  // (the web sends the holder to /enroll-2fa on it).
  it("throws SECOND_FACTOR_REQUIRED when the port says the role holder has no second factor", async () => {
    const authz = {
      hasStaffRole: vi.fn(async () => ({
        allowed: false,
        secondFactorRequired: true as const,
      })),
    };

    await expect(
      requirePlatformStaff({ authz, actorHumanId, roles: ["ADMIN"] }),
    ).rejects.toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
  });

  it("keeps SECOND_FACTOR_REQUIRED even when the caller names its own error code", async () => {
    const authz = {
      hasStaffRole: vi.fn(async () => ({
        allowed: false,
        secondFactorRequired: true as const,
      })),
    };

    await expect(
      requirePlatformStaff({
        authz,
        actorHumanId,
        roles: ["ADMIN"],
        errorCode: "NOT_AUTHORIZED",
      }),
    ).rejects.toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
  });

  it("never opts out of the second-factor rule", async () => {
    const authz = mockAuthz(true);

    await requirePlatformStaff({ authz, actorHumanId, roles: ["ADMIN"] });

    expect(authz.hasStaffRole.mock.calls[0][0]).not.toHaveProperty(
      "allowWithoutSecondFactor",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireScannerAccessOnOrg
// ─────────────────────────────────────────────────────────────────────────────

describe("requireScannerAccessOnOrg", () => {
  const orgId = "org-1";
  const actorHumanId = "human-1";

  function setup(opts: {
    membership: OrgMembership | null;
    staff: { allowed: boolean; secondFactorRequired?: true };
  }) {
    const repos = {
      authz: { getOrgMembership: vi.fn(async () => opts.membership) },
    };
    const authz = { hasStaffRole: vi.fn(async () => opts.staff) };
    const run = (errorCode?: "NOT_AUTHORIZED") =>
      requireScannerAccessOnOrg({
        repos,
        authz,
        orgId,
        actorHumanId,
        roles: ORG_SCAN_ROLES,
        ...(errorCode ? { errorCode } : {}),
      });
    return { repos, authz, run };
  }

  it("lets an org member with a scan role through without asking for a staff role", async () => {
    const { authz, run } = setup({
      membership: { orgId, humanId: actorHumanId, role: "SCANNER" },
      // Would refuse if it were asked: the member is also an un-enrolled
      // platform ADMIN, and keeps the access their membership gives.
      staff: { allowed: false, secondFactorRequired: true },
    });

    await expect(run()).resolves.toEqual({
      via: "membership",
      role: "SCANNER",
    });
    expect(authz.hasStaffRole).not.toHaveBeenCalled();
  });

  it("refuses a non-member platform ADMIN with no second factor: SECOND_FACTOR_REQUIRED", async () => {
    const { authz, run } = setup({
      membership: null,
      staff: { allowed: false, secondFactorRequired: true },
    });

    await expect(run()).rejects.toMatchObject({
      code: "SECOND_FACTOR_REQUIRED",
    });
    // The default probe: no opt-out, so the port applies the rule.
    expect(authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId,
      requiredRoles: ["ADMIN"],
    });
  });

  it("keeps SECOND_FACTOR_REQUIRED when the caller names its own error code", async () => {
    const { run } = setup({
      membership: null,
      staff: { allowed: false, secondFactorRequired: true },
    });

    await expect(run("NOT_AUTHORIZED")).rejects.toMatchObject({
      code: "SECOND_FACTOR_REQUIRED",
    });
  });

  it("refuses a member whose role cannot scan and who is an un-enrolled ADMIN", async () => {
    const { run } = setup({
      membership: { orgId, humanId: actorHumanId, role: "VIEWER" },
      staff: { allowed: false, secondFactorRequired: true },
    });

    await expect(run()).rejects.toMatchObject({
      code: "SECOND_FACTOR_REQUIRED",
    });
  });

  it("gives a non-member platform ADMIN with a second factor the OWNER override", async () => {
    const { run } = setup({ membership: null, staff: { allowed: true } });

    await expect(run()).resolves.toEqual({
      via: "platform_admin",
      role: "OWNER",
    });
  });

  it("refuses a non-member with no staff role: INSUFFICIENT_ROLE", async () => {
    const { run } = setup({ membership: null, staff: { allowed: false } });

    await expect(run()).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("uses the caller's error code for a non-member with no staff role", async () => {
    const { run } = setup({ membership: null, staff: { allowed: false } });

    await expect(run("NOT_AUTHORIZED")).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
  });
});
