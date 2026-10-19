import { describe, expect, it, vi } from "vitest";

import { getHuman } from "../get-human";
import type { GetHumanDeps } from "../get-human";
import type { Repos } from "@th/ports/repos";
import type { HumansRepo } from "@th/ports/repos/humans";

/** The authz port's staff probe, as the adapter answers it. */
type StaffAnswer = { allowed: boolean; secondFactorRequired?: true };

function makeDeps(
  humansImpl: Partial<HumansRepo>,
  staff: StaffAnswer = { allowed: false },
): GetHumanDeps & { hasStaffRole: ReturnType<typeof vi.fn> } {
  const humans = {
    getById: vi.fn(),
    getByIdWithIdentity: vi.fn(),
    getByEmail: vi.fn(),
    getByPhone: vi.fn(),

    getHumanIdForAuthUserId: vi.fn(),
    linkAuthUserToHuman: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ensureByProvider: vi.fn(),
    listForSearchIndex: vi.fn(),
    ...humansImpl,
  } as unknown as HumansRepo;

  const repos: Repos = {
    humans,
    audit: {} as any,
    tx: async () => {
      throw new Error("unexpected tx call");
    },
  } as unknown as Repos;

  const hasStaffRole = vi.fn(async () => staff);
  return { repos, authz: { hasStaffRole }, hasStaffRole };
}

describe("getHuman", () => {
  const human = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Ada",
    status: "ACTIVE" as const,
    roles: ["USER"],
    locale: null,
    phone: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    trustTier: "NEW" as const,
    trustBadgeLabel: null,
    trustBadgeIcon: null,
    createdAt: new Date(),
  };

  const identity = {
    authUserId: "11111111-1111-4111-8111-111111111111",
    email: "user@example.com",
    emailVerified: true,
    phone: "+12345678901",
    phoneVerified: true,
    username: null,
    displayUsername: null,
    image: null,
  };

  it("allows self access and masks phone", async () => {
    const deps = makeDeps({
      getById: vi.fn(async () => human),
      getByIdWithIdentity: vi.fn(async () => ({ human, identity })),
    });

    const result = await getHuman(deps, {
      actorHumanId: human.id,
      targetHumanId: human.id,
    });

    expect(result.human.phoneMasked).toBe("**********01");
    expect(result.human.email).toBe(identity.email);
    // Reading oneself is no staff read: the probe is never asked.
    expect(deps.hasStaffRole).not.toHaveBeenCalled();
  });

  // Self-access is the actor's own, whatever the staff probe would say: a
  // staff member with no second factor still reads their own record.
  it("allows self access for a staff member with no second factor", async () => {
    const deps = makeDeps(
      { getByIdWithIdentity: vi.fn(async () => ({ human, identity })) },
      { allowed: false, secondFactorRequired: true },
    );

    await expect(
      getHuman(deps, { actorHumanId: human.id, targetHumanId: human.id }),
    ).resolves.toMatchObject({ human: { id: human.id } });
    expect(deps.hasStaffRole).not.toHaveBeenCalled();
  });

  it("allows admin access", async () => {
    const admin = {
      ...human,
      id: "22222222-2222-4222-8222-222222222222",
      roles: ["ADMIN"],
    };
    const deps = makeDeps(
      {
        getById: vi.fn(async (id: string) => {
          if (id === human.id) return human;
          if (id === admin.id) return admin;
          return null;
        }),
        getByIdWithIdentity: vi.fn(async (id: string) => {
          if (id === human.id) return { human, identity };
          if (id === admin.id)
            return {
              human: admin,
              identity: { ...identity, authUserId: admin.id },
            };
          return null;
        }),
      },
      { allowed: true },
    );

    const result = await getHuman(deps, {
      actorHumanId: admin.id,
      targetHumanId: human.id,
    });

    expect(result.human.phoneMasked).toBeNull();
    // The default probe: no opt-out, so the port applies the second-factor rule.
    expect(deps.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: admin.id,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
  });

  // The raw role read says ADMIN; the port says the holder has no second
  // factor. The port decides, and the record is not returned.
  it("refuses a staff member with no second factor: SECOND_FACTOR_REQUIRED", async () => {
    const admin = {
      ...human,
      id: "22222222-2222-4222-8222-222222222222",
      roles: ["ADMIN"],
    };
    const getById = vi.fn(async () => admin);
    const deps = makeDeps(
      {
        getById,
        getByIdWithIdentity: vi.fn(async () => ({ human, identity })),
      },
      { allowed: false, secondFactorRequired: true },
    );

    await expect(
      getHuman(deps, { actorHumanId: admin.id, targetHumanId: human.id }),
    ).rejects.toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
    expect(getById).not.toHaveBeenCalled();
  });

  it("rejects when actor lacks permissions", async () => {
    const other = { ...human, id: "33333333-3333-4333-8333-333333333333" };
    const deps = makeDeps({
      getById: vi.fn(async (id: string) => {
        if (id === human.id) return human;
        if (id === other.id) return other;
        return null;
      }),
      getByIdWithIdentity: vi.fn(async (id: string) => {
        if (id === human.id) return { human, identity };
        if (id === other.id)
          return {
            human: other,
            identity: { ...identity, authUserId: other.id },
          };
        return null;
      }),
    });

    await expect(
      getHuman(deps, {
        actorHumanId: other.id,
        targetHumanId: human.id,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
