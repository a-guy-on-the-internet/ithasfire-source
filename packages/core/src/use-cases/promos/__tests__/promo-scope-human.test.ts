import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPromo } from "../create-promo";
import { listPromos } from "../list-promos";
import { updatePromo } from "../update-promo";
import { revokePromo } from "../revoke-promo";
import { ensurePromoScopeOwnedByOwner } from "../scope-ownership";
import type { Repos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// PromoScope.HUMAN — owner-wide scope for direct/personal sellers.
//
// Covers the fix for the dead-promo bug: HUMAN owners used to get scope "ORG"
// with scopeId = their humanId, which listed fine but never applied at
// checkout (ORG eligibility compares against event.orgId).
// ─────────────────────────────────────────────────────────────────────────────

const HUMAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_HUMAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const PROMO_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-05T12:00:00.000Z");

function makeMockRepos() {
  const authz = {
    getOrgMembership: vi.fn(),
  };
  const promos = {
    create: vi.fn(),
    update: vi.fn(),
    getById: vi.fn(),
    getByIdWithStats: vi.fn(),
    listByScope: vi.fn(),
    findActiveByCodes: vi.fn(),
    getRedemptionStats: vi.fn(),
    createHolds: vi.fn(),
    releaseHoldsForOrder: vi.fn(),
    listHoldsForOrder: vi.fn(),
    confirmHoldsForOrder: vi.fn(),
    listRedemptionsByOrderId: vi.fn(),
  };
  const events = {
    getById: vi.fn(),
  };
  return {
    authz,
    promos,
    events,
    repos: { authz, promos, events } as unknown as Repos,
  };
}

const humanPromoRecord = {
  id: PROMO_ID,
  code: "SELLER10",
  codeNormalized: "SELLER10",
  kind: "PERCENT" as const,
  value: 10,
  currency: "usd",
  scope: "HUMAN" as const,
  scopeId: HUMAN_ID,
  startsAt: undefined,
  endsAt: undefined,
  maxRedemptions: undefined,
  maxRedemptionsPerHuman: undefined,
  minOrderCents: 0,
  maxDiscountCents: undefined,
  stackable: false,
  isPublic: false,
  status: "ACTIVE" as const,
  createdAt: NOW,
  updatedAt: NOW,
};

// ─────────────────────────────────────────────────────────────────────────────
// ensurePromoScopeOwnedByOwner
// ─────────────────────────────────────────────────────────────────────────────

describe("ensurePromoScopeOwnedByOwner — HUMAN scope", () => {
  let mocks: ReturnType<typeof makeMockRepos>;

  beforeEach(() => {
    mocks = makeMockRepos();
  });

  it("accepts HUMAN scope when ownerType is HUMAN and scopeId === ownerId", async () => {
    await expect(
      ensurePromoScopeOwnedByOwner({
        repos: mocks.repos,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        scope: "HUMAN",
        scopeId: HUMAN_ID,
        mode: "create",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects HUMAN scope for ORGANIZATION owners", async () => {
    await expect(
      ensurePromoScopeOwnedByOwner({
        repos: mocks.repos,
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        scope: "HUMAN",
        scopeId: ORG_ID,
        mode: "create",
      }),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
  });

  it("rejects HUMAN scope when scopeId is another human", async () => {
    await expect(
      ensurePromoScopeOwnedByOwner({
        repos: mocks.repos,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        scope: "HUMAN",
        scopeId: OTHER_HUMAN_ID,
        mode: "mutate",
      }),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
  });

  it("rejects EVENT scope for a HUMAN owner on an org-owned event that carries their humanId (payee precedence)", async () => {
    // orgId wins payee precedence: being listed as humanId on an org event
    // is not ownership, so the human must not be able to attach an
    // EVENT-scoped promo (which would discount the org's revenue).
    mocks.events.getById.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      orgId: ORG_ID,
      humanId: HUMAN_ID,
    });

    await expect(
      ensurePromoScopeOwnedByOwner({
        repos: mocks.repos,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        scope: "EVENT",
        scopeId: "44444444-4444-4444-8444-444444444444",
        mode: "create",
      }),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
  });

  it("still allows EVENT scope for a HUMAN owner on their personal event", async () => {
    mocks.events.getById.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      orgId: null,
      humanId: HUMAN_ID,
    });

    await expect(
      ensurePromoScopeOwnedByOwner({
        repos: mocks.repos,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        scope: "EVENT",
        scopeId: "44444444-4444-4444-8444-444444444444",
        mode: "create",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects ORG scope for HUMAN owners (dead-promo bug regression)", async () => {
    // Previously this passed (only scopeId === ownerId was checked), which
    // minted ORG-scoped promos carrying a humanId — dead at checkout.
    await expect(
      ensurePromoScopeOwnedByOwner({
        repos: mocks.repos,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        scope: "ORG",
        scopeId: HUMAN_ID,
        mode: "create",
      }),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPromo
// ─────────────────────────────────────────────────────────────────────────────

describe("createPromo — HUMAN owners", () => {
  let mocks: ReturnType<typeof makeMockRepos>;

  beforeEach(() => {
    mocks = makeMockRepos();
    mocks.promos.create.mockResolvedValue(humanPromoRecord);
  });

  it("maps the owner-wide default scope (ORG) to HUMAN for human owners", async () => {
    const result = await createPromo(
      { repos: mocks.repos },
      {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        code: "SELLER10",
        kind: "PERCENT",
        value: 10,
        // no scope → schema default "ORG" → derived "HUMAN"
      },
    );

    expect(result.scope).toBe("HUMAN");
    expect(mocks.promos.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "HUMAN", scopeId: HUMAN_ID }),
    );
  });

  it("accepts an explicit HUMAN scope and pins scopeId to the owner", async () => {
    await createPromo(
      { repos: mocks.repos },
      {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        code: "SELLER10",
        kind: "PERCENT",
        value: 10,
        scope: "HUMAN",
        // even a hostile scopeId is overridden with ownerId
        scopeId: OTHER_HUMAN_ID,
      },
    );

    expect(mocks.promos.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "HUMAN", scopeId: HUMAN_ID }),
    );
  });

  it("rejects an explicit HUMAN scope for ORGANIZATION owners", async () => {
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "OWNER" });

    await expect(
      createPromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          code: "SELLER10",
          kind: "PERCENT",
          value: 10,
          scope: "HUMAN",
        },
      ),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
    expect(mocks.promos.create).not.toHaveBeenCalled();
  });

  it("keeps ORG owners on scope ORG (unchanged behavior)", async () => {
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "OWNER" });
    mocks.promos.create.mockResolvedValue({
      ...humanPromoRecord,
      scope: "ORG" as const,
      scopeId: ORG_ID,
    });

    const result = await createPromo(
      { repos: mocks.repos },
      {
        actorHumanId: ACTOR_ID,
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        code: "SAVE20",
        kind: "PERCENT",
        value: 20,
      },
    );

    expect(result.scope).toBe("ORG");
    expect(mocks.promos.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "ORG", scopeId: ORG_ID }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listPromos
// ─────────────────────────────────────────────────────────────────────────────

describe("listPromos — HUMAN owners", () => {
  let mocks: ReturnType<typeof makeMockRepos>;

  beforeEach(() => {
    mocks = makeMockRepos();
    mocks.promos.listByScope.mockResolvedValue({
      items: [{ ...humanPromoRecord, totalRedemptions: 0 }],
      total: 1,
    });
  });

  it("queries scope HUMAN with the human's id", async () => {
    const result = await listPromos(
      { repos: mocks.repos },
      { actorHumanId: HUMAN_ID, ownerType: "HUMAN", ownerId: HUMAN_ID },
    );

    expect(result.total).toBe(1);
    expect(mocks.promos.listByScope).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "HUMAN", scopeId: HUMAN_ID }),
    );
  });

  it("still queries scope ORG for organizations", async () => {
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "ADMIN" });

    await listPromos(
      { repos: mocks.repos },
      { actorHumanId: ACTOR_ID, ownerType: "ORGANIZATION", ownerId: ORG_ID },
    );

    expect(mocks.promos.listByScope).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "ORG", scopeId: ORG_ID }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updatePromo / revokePromo — HUMAN promos flow through mode "mutate"
// ─────────────────────────────────────────────────────────────────────────────

describe("updatePromo / revokePromo — HUMAN promos", () => {
  let mocks: ReturnType<typeof makeMockRepos>;

  beforeEach(() => {
    mocks = makeMockRepos();
    mocks.promos.getById.mockResolvedValue(humanPromoRecord);
  });

  it("lets the owning human update their HUMAN-scoped promo", async () => {
    mocks.promos.update.mockResolvedValue({ ...humanPromoRecord, value: 25 });

    const result = await updatePromo(
      { repos: mocks.repos },
      {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        promoId: PROMO_ID,
        value: 25,
      },
    );

    expect(result.value).toBe(25);
  });

  it("rejects another human updating it", async () => {
    await expect(
      updatePromo(
        { repos: mocks.repos },
        {
          actorHumanId: OTHER_HUMAN_ID,
          ownerType: "HUMAN",
          ownerId: OTHER_HUMAN_ID,
          promoId: PROMO_ID,
          value: 25,
        },
      ),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
    expect(mocks.promos.update).not.toHaveBeenCalled();
  });

  it("lets the owning human revoke their HUMAN-scoped promo", async () => {
    mocks.promos.update.mockResolvedValue({
      ...humanPromoRecord,
      status: "ARCHIVED" as const,
    });

    const result = await revokePromo(
      { repos: mocks.repos },
      {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        promoId: PROMO_ID,
      },
    );

    expect(result.status).toBe("ARCHIVED");
  });

  it("rejects an org revoking a HUMAN-scoped promo", async () => {
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "OWNER" });

    await expect(
      revokePromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          promoId: PROMO_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
    expect(mocks.promos.update).not.toHaveBeenCalled();
  });
});
