import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPromo } from "../create-promo";
import { listPromos } from "../list-promos";
import { updatePromo } from "../update-promo";
import { revokePromo } from "../revoke-promo";
import type { Repos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "11111111-1111-4111-8111-999999999999";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const PROMO_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const TICKET_TYPE_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-03-14T12:00:00.000Z");

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

const basePromoRecord = {
  id: PROMO_ID,
  code: "SAVE20",
  codeNormalized: "SAVE20",
  kind: "PERCENT" as const,
  value: 20,
  currency: "usd",
  scope: "ORG" as const,
  scopeId: ORG_ID,
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
// createPromo
// ─────────────────────────────────────────────────────────────────────────────

describe("createPromo", () => {
  let mocks: ReturnType<typeof makeMockRepos>;

  beforeEach(() => {
    mocks = makeMockRepos();
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "OWNER" });
    mocks.promos.create.mockResolvedValue(basePromoRecord);
  });

  it("creates a promo and returns it", async () => {
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

    expect(result.id).toBe(PROMO_ID);
    expect(result.code).toBe("SAVE20");
    expect(mocks.promos.create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "SAVE20",
        kind: "PERCENT",
        value: 20,
        scope: "ORG",
        scopeId: ORG_ID,
      }),
    );
  });

  it("rejects when actor is not an org member", async () => {
    mocks.authz.getOrgMembership.mockResolvedValue(null);

    await expect(
      createPromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          code: "X",
          kind: "AMOUNT",
          value: 100,
        },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects VIEWER role", async () => {
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "VIEWER" });

    await expect(
      createPromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          code: "X",
          kind: "AMOUNT",
          value: 100,
        },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects when endsAt is before startsAt", async () => {
    await expect(
      createPromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          code: "X",
          kind: "AMOUNT",
          value: 100,
          startsAt: new Date("2026-04-01"),
          endsAt: new Date("2026-03-01"),
        },
      ),
    ).rejects.toMatchObject({ code: "END_BEFORE_START" });
  });

  it("allows FINANCE role", async () => {
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "FINANCE" });

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

    expect(result.id).toBe(PROMO_ID);
  });

  it("forwards public visibility when creating a promo", async () => {
    mocks.promos.create.mockResolvedValueOnce({
      ...basePromoRecord,
      isPublic: true,
    });

    const result = await createPromo(
      { repos: mocks.repos },
      {
        actorHumanId: ACTOR_ID,
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        code: "PUBLIC20",
        kind: "PERCENT",
        value: 20,
        isPublic: true,
      },
    );

    expect(result.isPublic).toBe(true);
    expect(mocks.promos.create).toHaveBeenCalledWith(
      expect.objectContaining({ isPublic: true }),
    );
  });

  it("rejects event-scoped promo creation when the event belongs to another owner", async () => {
    mocks.events.getById.mockResolvedValue({
      id: EVENT_ID,
      orgId: OTHER_ORG_ID,
      humanId: null,
    });

    await expect(
      createPromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          code: "EVENT20",
          kind: "PERCENT",
          value: 20,
          scope: "EVENT",
          scopeId: EVENT_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
    expect(mocks.promos.create).not.toHaveBeenCalled();
  });

  it("rejects ticket-type-scoped promo creation from organizer CRUD", async () => {
    await expect(
      createPromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          code: "TYPE20",
          kind: "PERCENT",
          value: 20,
          scope: "TICKET_TYPE",
          scopeId: TICKET_TYPE_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SCOPE_UNSUPPORTED" });
    expect(mocks.promos.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listPromos
// ─────────────────────────────────────────────────────────────────────────────

describe("listPromos", () => {
  let mocks: ReturnType<typeof makeMockRepos>;

  beforeEach(() => {
    mocks = makeMockRepos();
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "ADMIN" });
    mocks.promos.listByScope.mockResolvedValue({
      items: [{ ...basePromoRecord, totalRedemptions: 5 }],
      total: 1,
    });
  });

  it("lists promos for the org", async () => {
    const result = await listPromos(
      { repos: mocks.repos },
      { actorHumanId: ACTOR_ID, ownerType: "ORGANIZATION", ownerId: ORG_ID },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.totalRedemptions).toBe(5);
    expect(result.total).toBe(1);
  });

  it("rejects non-members", async () => {
    mocks.authz.getOrgMembership.mockResolvedValue(null);

    await expect(
      listPromos(
        { repos: mocks.repos },
        { actorHumanId: ACTOR_ID, ownerType: "ORGANIZATION", ownerId: ORG_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updatePromo
// ─────────────────────────────────────────────────────────────────────────────

describe("updatePromo", () => {
  let mocks: ReturnType<typeof makeMockRepos>;

  beforeEach(() => {
    mocks = makeMockRepos();
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "OWNER" });
    mocks.promos.getById.mockResolvedValue(basePromoRecord);
    mocks.promos.update.mockResolvedValue({ ...basePromoRecord, value: 30 });
  });

  it("updates a promo", async () => {
    mocks.promos.update.mockResolvedValueOnce({
      ...basePromoRecord,
      value: 30,
      isPublic: true,
    });

    const result = await updatePromo(
      { repos: mocks.repos },
      {
        actorHumanId: ACTOR_ID,
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        promoId: PROMO_ID,
        value: 30,
        isPublic: true,
      },
    );

    expect(result.value).toBe(30);
    expect(result.isPublic).toBe(true);
    expect(mocks.promos.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: PROMO_ID, value: 30, isPublic: true }),
    );
  });

  it("rejects when promo not found", async () => {
    mocks.promos.getById.mockResolvedValue(null);

    await expect(
      updatePromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          promoId: PROMO_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "PROMO_NOT_FOUND" });
  });

  it("rejects when promo belongs to different org", async () => {
    mocks.promos.getById.mockResolvedValue({
      ...basePromoRecord,
      scopeId: "other-org-id-12345678-abcd-1234-abcd",
    });

    await expect(
      updatePromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          promoId: PROMO_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
  });

  it("rejects event-scoped promo update when the event belongs to another owner", async () => {
    mocks.promos.getById.mockResolvedValue({
      ...basePromoRecord,
      scope: "EVENT",
      scopeId: EVENT_ID,
    });
    mocks.events.getById.mockResolvedValue({
      id: EVENT_ID,
      orgId: OTHER_ORG_ID,
      humanId: null,
    });

    await expect(
      updatePromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          promoId: PROMO_ID,
          value: 30,
        },
      ),
    ).rejects.toMatchObject({ code: "PROMO_NOT_OWNED" });
    expect(mocks.promos.update).not.toHaveBeenCalled();
  });

  it("rejects ticket-type-scoped promo update from organizer CRUD", async () => {
    mocks.promos.getById.mockResolvedValue({
      ...basePromoRecord,
      scope: "TICKET_TYPE",
      scopeId: TICKET_TYPE_ID,
    });

    await expect(
      updatePromo(
        { repos: mocks.repos },
        {
          actorHumanId: ACTOR_ID,
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          promoId: PROMO_ID,
          value: 30,
        },
      ),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SCOPE_UNSUPPORTED" });
    expect(mocks.promos.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// revokePromo
// ─────────────────────────────────────────────────────────────────────────────

describe("revokePromo", () => {
  let mocks: ReturnType<typeof makeMockRepos>;

  beforeEach(() => {
    mocks = makeMockRepos();
    mocks.authz.getOrgMembership.mockResolvedValue({ role: "OWNER" });
    mocks.promos.getById.mockResolvedValue(basePromoRecord);
    mocks.promos.update.mockResolvedValue({
      ...basePromoRecord,
      status: "ARCHIVED",
    });
  });

  it("archives a promo", async () => {
    const result = await revokePromo(
      { repos: mocks.repos },
      {
        actorHumanId: ACTOR_ID,
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        promoId: PROMO_ID,
      },
    );

    expect(result.status).toBe("ARCHIVED");
    expect(mocks.promos.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: PROMO_ID, status: "ARCHIVED" }),
    );
  });

  it("is idempotent for already-archived promos", async () => {
    mocks.promos.getById.mockResolvedValue({
      ...basePromoRecord,
      status: "ARCHIVED",
    });

    const result = await revokePromo(
      { repos: mocks.repos },
      {
        actorHumanId: ACTOR_ID,
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        promoId: PROMO_ID,
      },
    );

    expect(result.status).toBe("ARCHIVED");
    expect(mocks.promos.update).not.toHaveBeenCalled();
  });

  it("rejects non-member", async () => {
    mocks.authz.getOrgMembership.mockResolvedValue(null);

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
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects event-scoped promo revoke when the event belongs to another owner", async () => {
    mocks.promos.getById.mockResolvedValue({
      ...basePromoRecord,
      scope: "EVENT",
      scopeId: EVENT_ID,
    });
    mocks.events.getById.mockResolvedValue({
      id: EVENT_ID,
      orgId: OTHER_ORG_ID,
      humanId: null,
    });

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

  it("rejects ticket-type-scoped promo revoke from organizer CRUD", async () => {
    mocks.promos.getById.mockResolvedValue({
      ...basePromoRecord,
      scope: "TICKET_TYPE",
      scopeId: TICKET_TYPE_ID,
    });

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
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SCOPE_UNSUPPORTED" });
    expect(mocks.promos.update).not.toHaveBeenCalled();
  });
});
