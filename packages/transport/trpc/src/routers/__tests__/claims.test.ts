import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { claimsRouter } from "../claims";

// `claims.*` is mounted at the ROOT router (`router.ts`: `claims: router(claimsRouter)`),
// not under `platform.*`, so it inherits no staff or second-factor gate. These
// tests pin that the use-case gates fire with the SESSION actor and that no
// claim row is read before a refusal.

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORDER_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const ITEM_ID = "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BUYER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELLER_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const NOW = new Date("2026-03-10T12:00:00Z");

const authzWith = (allowed: boolean) =>
  ({
    hasOrgRole: vi.fn(),
    requireOrgRole: vi.fn(),
    canEditEvent: vi.fn(),
    canManagePlace: vi.fn(),
    canFinanceOrg: vi.fn(),
    hasStaffRole: vi.fn(async () => ({ allowed })),
  }) as any;

const emptyPage = () => ({
  items: [],
  pageInfo: { total: 0, limit: 25, offset: 0, hasMore: false },
});

const makeClaim = () => ({
  id: CLAIM_ID,
  orderId: ORDER_ID,
  orderItemId: ITEM_ID,
  eventId: EVENT_ID,
  claimantId: BUYER_ID,
  respondentId: SELLER_ID,
  kind: "ticket_invalid",
  status: "open",
  evidence: {},
  deadline: new Date("2026-03-15T12:00:00Z"),
  resolvedAt: null,
  resolvedById: null,
  resolutionNote: null,
  resolution: null,
  sellerEvidence: null,
  sellerRespondedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

// The session actor has a verified email: `claims.*` sits behind the B2
// verified-email gate (verified-email-gate.test.ts covers the refusal).
const verifiedActor = () => ({
  humans: {
    getByIdWithIdentity: vi.fn(async () => ({
      human: { id: ACTOR_ID },
      identity: { emailVerified: true },
    })),
  },
});

// Every claims repo method is a throwing spy: a refusal must land BEFORE any
// of them is reached, so a call here is a test failure.
const untouchedClaimsRepo = () => {
  const boom = vi.fn(async () => {
    throw new Error("claims repo reached past the gate");
  });
  return {
    claims: {
      getById: boom,
      listAll: boom,
      listByEvent: boom,
      listByClaimant: boom,
      listByRespondent: boom,
      updateStatus: boom,
    },
    events: { getById: boom },
    authz: { getOrgMembership: boom },
    audit: { log: boom },
    tx: boom,
    ...verifiedActor(),
  } as any;
};

const expectUntouched = (repos: any) => {
  // `humans` is the verified-email gate's read (B2), not a claim row.
  const { humans: _gate, ...claimRepos } = repos;
  for (const repo of Object.values(claimRepos) as any[]) {
    if (typeof repo === "function") {
      expect(repo).not.toHaveBeenCalled();
      continue;
    }
    for (const fn of Object.values(repo) as any[]) {
      expect(fn).not.toHaveBeenCalled();
    }
  }
};

describe("claims router", () => {
  describe("list", () => {
    it("rejects an anonymous caller with UNAUTHORIZED", async () => {
      const repos = untouchedClaimsRepo();
      const { caller } = createCaller(
        { list: claimsRouter.list },
        { actorHumanId: null, repos },
      );

      await expect(caller.list({})).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expectUntouched(repos);
    });

    it("platform-wide: a signed-in NON-staff user gets FORBIDDEN and no claim row is read", async () => {
      const repos = untouchedClaimsRepo();
      const authz = authzWith(false);
      const { caller } = createCaller(
        { list: claimsRouter.list },
        { actorHumanId: ACTOR_ID, authz, repos },
      );

      await expect(caller.list({})).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(authz.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN", "SUPPORT"],
      });
      expectUntouched(repos);
    });

    it("platform-wide: a staff user gets the list shape", async () => {
      const listAll = vi.fn(async () => emptyPage());
      const authz = authzWith(true);
      const { caller } = createCaller(
        { list: claimsRouter.list },
        {
          actorHumanId: ACTOR_ID,
          authz,
          repos: { claims: { listAll }, ...verifiedActor() } as any,
        },
      );

      const result = await caller.list({ status: ["open"], limit: 5 });

      expect(result).toEqual({ items: [], total: 0 });
      expect(listAll).toHaveBeenCalledWith({
        status: ["open"],
        limit: 5,
        offset: 0,
      });
    });

    it("ignores a client-supplied actorHumanId — the session actor is the one gated", async () => {
      const repos = untouchedClaimsRepo();
      const authz = authzWith(false);
      const { caller } = createCaller(
        { list: claimsRouter.list },
        { actorHumanId: ACTOR_ID, authz, repos },
      );

      await expect(
        caller.list({ actorHumanId: OTHER_ID } as any),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(authz.hasStaffRole).toHaveBeenCalledWith(
        expect.objectContaining({ actorHumanId: ACTOR_ID }),
      );
      expect(authz.hasStaffRole).not.toHaveBeenCalledWith(
        expect.objectContaining({ actorHumanId: OTHER_ID }),
      );
      expectUntouched(repos);
    });

    it("respondentId = someone else: non-staff gets FORBIDDEN", async () => {
      const repos = untouchedClaimsRepo();
      const { caller } = createCaller(
        { list: claimsRouter.list },
        { actorHumanId: ACTOR_ID, authz: authzWith(false), repos },
      );

      await expect(
        caller.list({ respondentId: OTHER_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expectUntouched(repos);
    });
  });

  describe("listMy", () => {
    it("lists the session actor's own claims as respondent without any staff role", async () => {
      const listByRespondent = vi.fn(async () => emptyPage());
      const authz = authzWith(false);
      const { caller } = createCaller(
        { listMy: claimsRouter.listMy },
        {
          actorHumanId: ACTOR_ID,
          authz,
          repos: { claims: { listByRespondent }, ...verifiedActor() } as any,
        },
      );

      const result = await caller.listMy({});

      expect(result).toEqual({ items: [], total: 0 });
      expect(listByRespondent).toHaveBeenCalledWith(ACTOR_ID, {
        status: undefined,
        limit: 25,
        offset: 0,
      });
      expect(authz.hasStaffRole).not.toHaveBeenCalled();
    });

    it("rejects an anonymous caller with UNAUTHORIZED", async () => {
      const repos = untouchedClaimsRepo();
      const { caller } = createCaller(
        { listMy: claimsRouter.listMy },
        { actorHumanId: null, repos },
      );

      await expect(caller.listMy({})).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expectUntouched(repos);
    });
  });

  describe("get", () => {
    it("rejects an anonymous caller with UNAUTHORIZED", async () => {
      const repos = untouchedClaimsRepo();
      const { caller } = createCaller(
        { get: claimsRouter.get },
        { actorHumanId: null, repos },
      );

      await expect(caller.get({ claimId: CLAIM_ID })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expectUntouched(repos);
    });

    it("a signed-in stranger (not buyer, seller, or staff) gets NOT_FOUND", async () => {
      const getById = vi.fn(async () => makeClaim());
      const { caller } = createCaller(
        { get: claimsRouter.get },
        {
          actorHumanId: ACTOR_ID,
          authz: authzWith(false),
          repos: { claims: { getById }, ...verifiedActor() } as any,
        },
      );

      await expect(caller.get({ claimId: CLAIM_ID })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("the seller reads their claim without a staff role", async () => {
      const getById = vi.fn(async () => makeClaim());
      const authz = authzWith(false);
      const { caller } = createCaller(
        { get: claimsRouter.get },
        {
          actorHumanId: SELLER_ID,
          authz,
          repos: { claims: { getById }, ...verifiedActor() } as any,
        },
      );

      const result = await caller.get({ claimId: CLAIM_ID });

      expect(result.id).toBe(CLAIM_ID);
      expect(result.deadline).toBe("2026-03-15T12:00:00.000Z");
      expect(authz.hasStaffRole).not.toHaveBeenCalled();
    });

    it("staff reads any claim", async () => {
      const getById = vi.fn(async () => makeClaim());
      const { caller } = createCaller(
        { get: claimsRouter.get },
        {
          actorHumanId: ACTOR_ID,
          authz: authzWith(true),
          repos: { claims: { getById }, ...verifiedActor() } as any,
        },
      );

      const result = await caller.get({ claimId: CLAIM_ID });
      expect(result.id).toBe(CLAIM_ID);
    });
  });

  describe("review", () => {
    const input = {
      claimId: CLAIM_ID,
      status: "approved" as const,
      resolution: "full_refund" as const,
    };

    it("rejects an anonymous caller with UNAUTHORIZED", async () => {
      const repos = untouchedClaimsRepo();
      const { caller } = createCaller(
        { review: claimsRouter.review },
        { actorHumanId: null, repos },
      );

      await expect(caller.review(input)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expectUntouched(repos);
    });

    it("a signed-in NON-staff user gets FORBIDDEN before any repo, idempotency, or payment call", async () => {
      const repos = untouchedClaimsRepo();
      const authz = authzWith(false);
      const idempotency = {
        begin: vi.fn(),
        get: vi.fn(),
        commit: vi.fn(),
        fail: vi.fn(),
      } as any;
      const payments = { refundPaymentIntent: vi.fn() } as any;
      const { caller } = createCaller(
        { review: claimsRouter.review },
        { actorHumanId: ACTOR_ID, authz, repos, idempotency, payments },
      );

      await expect(caller.review(input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(authz.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN", "SUPPORT"],
      });
      expectUntouched(repos);
      expect(idempotency.begin).not.toHaveBeenCalled();
      expect(payments.refundPaymentIntent).not.toHaveBeenCalled();
    });

    it("does not accept a client-supplied actorHumanId", async () => {
      const repos = untouchedClaimsRepo();
      const authz = authzWith(false);
      const { caller } = createCaller(
        { review: claimsRouter.review },
        { actorHumanId: ACTOR_ID, authz, repos },
      );

      await expect(
        caller.review({ ...input, actorHumanId: OTHER_ID } as any),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(authz.hasStaffRole).not.toHaveBeenCalledWith(
        expect.objectContaining({ actorHumanId: OTHER_ID }),
      );
      expectUntouched(repos);
    });
  });
});
