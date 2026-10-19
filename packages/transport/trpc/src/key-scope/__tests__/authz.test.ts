import { describe, expect, it, vi } from "vitest";
import type { ApiKeyScope } from "@th/ports/authn";
import type { AuthZPort } from "@th/ports/authz";

import { scopeAuthzToKey } from "../authz";

const HOLDER = "11111111-1111-4111-8111-111111111111";
const KEY_ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const EVENT = "44444444-4444-4444-8444-444444444444";
const PLACE = "55555555-5555-4555-8555-555555555555";

type Scoped = Extract<ApiKeyScope, { kind: "scoped" }>;
const key = (subject: Scoped["subject"]): Scoped => ({
  kind: "scoped",
  keyId: "k",
  requestId: "r",
  subject,
  access: "READ_WRITE",
  orgId: subject === "ORG" ? KEY_ORG : null,
});

/** The real port, saying yes to everything. */
const permissive = () => ({
  hasOrgRole: vi.fn(async () => ({ allowed: true })),
  requireOrgRole: vi.fn(async () => undefined),
  canEditEvent: vi.fn(async () => ({ allowed: true })),
  canManagePlace: vi.fn(async () => ({ allowed: true })),
  canFinanceOrg: vi.fn(async () => ({ allowed: true })),
  hasStaffRole: vi.fn(async () => ({ allowed: true })),
});

const orgInput = (orgId: string) => ({
  actorHumanId: HOLDER,
  orgId,
  requiredRoles: ["ADMIN"] as ["ADMIN"],
});
const staffInput = { actorHumanId: HOLDER, requiredRoles: ["ADMIN"] as ["ADMIN"] };

describe("scopeAuthzToKey", () => {
  it("ORG: passes org probes for the key's org only, to the live port", async () => {
    const real = permissive();
    const authz = scopeAuthzToKey(real as unknown as AuthZPort, key("ORG"));

    expect(await authz.hasOrgRole(orgInput(KEY_ORG))).toEqual({ allowed: true });
    expect(await authz.hasOrgRole(orgInput(OTHER_ORG))).toEqual({ allowed: false });
    expect(real.hasOrgRole).toHaveBeenCalledTimes(1);

    await expect(authz.requireOrgRole(orgInput(KEY_ORG))).resolves.toBeUndefined();
    await expect(authz.requireOrgRole(orgInput(OTHER_ORG))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(real.requireOrgRole).toHaveBeenCalledTimes(1);

    expect(await authz.canFinanceOrg({ actorHumanId: HOLDER, orgId: KEY_ORG })).toEqual({
      allowed: true,
    });
    expect(
      await authz.canFinanceOrg({ actorHumanId: HOLDER, orgId: OTHER_ORG }),
    ).toEqual({ allowed: false });
  });

  it("ORG: refuses event and place probes (their org is resolved out of sight)", async () => {
    const real = permissive();
    const authz = scopeAuthzToKey(real as unknown as AuthZPort, key("ORG"));
    expect(await authz.canEditEvent({ actorHumanId: HOLDER, eventId: EVENT })).toEqual({
      allowed: false,
    });
    expect(
      await authz.canManagePlace({ actorHumanId: HOLDER, placeId: PLACE }),
    ).toEqual({ allowed: false });
    expect(real.canEditEvent).not.toHaveBeenCalled();
    expect(real.canManagePlace).not.toHaveBeenCalled();
  });

  it("ORG: never grants what the live port refuses (a demoted holder)", async () => {
    const real = {
      ...permissive(),
      hasOrgRole: vi.fn(async () => ({ allowed: false })),
      requireOrgRole: vi.fn(async () => {
        throw Object.assign(new Error("no"), { code: "forbidden" });
      }),
    };
    const authz = scopeAuthzToKey(real as unknown as AuthZPort, key("ORG"));
    expect(await authz.hasOrgRole(orgInput(KEY_ORG))).toEqual({ allowed: false });
    await expect(authz.requireOrgRole(orgInput(KEY_ORG))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("ORG with a null orgId: every org probe refused", async () => {
    const real = permissive();
    const authz = scopeAuthzToKey(real as unknown as AuthZPort, {
      ...key("ORG"),
      orgId: null,
    });
    expect(await authz.hasOrgRole(orgInput(KEY_ORG))).toEqual({ allowed: false });
    expect(real.hasOrgRole).not.toHaveBeenCalled();
  });

  it.each(["ORG", "PERSONAL", "PLATFORM_WIDE"] as const)(
    "%s: refuses hasStaffRole without asking the port",
    async (subject) => {
      const real = permissive();
      const authz = scopeAuthzToKey(real as unknown as AuthZPort, key(subject));
      expect(await authz.hasStaffRole(staffInput)).toEqual({ allowed: false });
      expect(real.hasStaffRole).not.toHaveBeenCalled();
    },
  );

  it("STAFF: passes hasStaffRole through unchanged, second-factor flag included", async () => {
    const real = {
      ...permissive(),
      hasStaffRole: vi.fn(async () => ({
        allowed: false,
        secondFactorRequired: true as const,
      })),
    };
    const authz = scopeAuthzToKey(real as unknown as AuthZPort, key("STAFF"));
    const input = { ...staffInput, allowWithoutSecondFactor: true };
    expect(await authz.hasStaffRole(input)).toEqual({
      allowed: false,
      secondFactorRequired: true,
    });
    expect(real.hasStaffRole).toHaveBeenCalledWith(input);
  });

  it.each(["STAFF", "PERSONAL", "PLATFORM_WIDE"] as const)(
    "%s: refuses every org, event, place and finance probe",
    async (subject) => {
      const real = permissive();
      const authz = scopeAuthzToKey(real as unknown as AuthZPort, key(subject));
      expect(await authz.hasOrgRole(orgInput(KEY_ORG))).toEqual({ allowed: false });
      await expect(authz.requireOrgRole(orgInput(KEY_ORG))).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(
        await authz.canFinanceOrg({ actorHumanId: HOLDER, orgId: KEY_ORG }),
      ).toEqual({ allowed: false });
      expect(
        await authz.canEditEvent({ actorHumanId: HOLDER, eventId: EVENT }),
      ).toEqual({ allowed: false });
      expect(
        await authz.canManagePlace({ actorHumanId: HOLDER, placeId: PLACE }),
      ).toEqual({ allowed: false });
      expect(real.hasOrgRole).not.toHaveBeenCalled();
      expect(real.requireOrgRole).not.toHaveBeenCalled();
    },
  );
});
