import { describe, it, expect, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ClaimRecord } from "@th/types/repos/claims";

import { respondToClaim, type RespondToClaimDeps } from "../respond-to-claim";

// ── Constants ──────────────────────────────────────────────────────────────

const SELLER_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-03-10T12:00:00Z");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeClaim(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    id: CLAIM_ID,
    orderId: "order-uuid",
    orderItemId: "item-uuid",
    eventId: "event-uuid",
    claimantId: "buyer-uuid",
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
    createdAt: new Date("2026-03-09T12:00:00Z"),
    updatedAt: new Date("2026-03-09T12:00:00Z"),
    ...overrides,
  };
}

function makeDeps(opts?: { claim?: ClaimRecord | null }) {
  const claim = opts?.claim !== undefined ? opts.claim : makeClaim();

  const getById = vi.fn(async () => claim);
  const recordSellerResponse = vi.fn(
    async (_id: string, payload: any): Promise<ClaimRecord | null> => ({
      ...claim!,
      sellerEvidence: payload.sellerEvidence,
      sellerRespondedAt: payload.respondedAt,
    }),
  );
  const auditLog = vi.fn(async () => {});

  const claimsRepo = { getById, recordSellerResponse } as any;
  const auditRepo = { log: auditLog } as any;

  const repos = {
    claims: claimsRepo,
    audit: auditRepo,
    tx: vi.fn(async (fn: any) => fn({ claims: claimsRepo, audit: auditRepo })),
  } as unknown as Repos;

  const clock: ClockPort = { now: () => NOW };

  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(),
  } as unknown as LoggerPort;

  return {
    deps: { repos, clock, logger } satisfies RespondToClaimDeps,
    mocks: { getById, recordSellerResponse, auditLog },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("respondToClaim", () => {
  it("records seller evidence and returns the responded timestamp", async () => {
    const { deps, mocks } = makeDeps();

    const result = await respondToClaim(deps, {
      actorHumanId: SELLER_ID,
      claimId: CLAIM_ID,
      sellerEvidence: { reply: "ticket was valid" },
    });

    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.respondedAt).toBe(NOW.toISOString());
    expect(mocks.recordSellerResponse).toHaveBeenCalledWith(CLAIM_ID, {
      sellerEvidence: { reply: "ticket was valid" },
      respondedAt: NOW,
    });
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "claim",
        entityId: CLAIM_ID,
        action: "seller_responded",
      }),
    );
  });

  it("stores the sanitized, trimmed reply", async () => {
    const { deps, mocks } = makeDeps();

    await respondToClaim(deps, {
      actorHumanId: SELLER_ID,
      claimId: CLAIM_ID,
      sellerEvidence: { reply: "  <b>It scanned</b> at the door  " },
    });

    expect(mocks.recordSellerResponse).toHaveBeenCalledWith(CLAIM_ID, {
      sellerEvidence: { reply: "It scanned at the door" },
      respondedAt: NOW,
    });
  });

  // v1 seller evidence is a written reply: anything else is refused before
  // the claim is read.
  it.each([
    ["missing", undefined],
    ["an empty object", {}],
    ["an empty reply", { reply: "" }],
    ["a whitespace-only reply", { reply: "   " }],
    ["a reply that is only markup", { reply: "<p></p>" }],
    ["a reply over 2000 chars", { reply: "x".repeat(2001) }],
    ["an extra key", { reply: "ok", photos: ["u"] }],
  ])("rejects sellerEvidence that is %s", async (_label, sellerEvidence) => {
    const { deps, mocks } = makeDeps();

    await expect(
      respondToClaim(deps, {
        actorHumanId: SELLER_ID,
        claimId: CLAIM_ID,
        sellerEvidence,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
    expect(mocks.getById).not.toHaveBeenCalled();
    expect(mocks.recordSellerResponse).not.toHaveBeenCalled();
  });

  it("throws not_found when claim does not exist", async () => {
    const { deps } = makeDeps({ claim: null });

    await expect(
      respondToClaim(deps, {
        actorHumanId: SELLER_ID,
        claimId: CLAIM_ID,
        sellerEvidence: { reply: "ticket was valid" },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "CLAIM_NOT_FOUND" }));
  });

  it("throws claim_not_respondent when actor is not the seller", async () => {
    const { deps } = makeDeps({
      claim: makeClaim({ respondentId: "other-seller" }),
    });

    await expect(
      respondToClaim(deps, {
        actorHumanId: SELLER_ID,
        claimId: CLAIM_ID,
        sellerEvidence: { reply: "ticket was valid" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_NOT_RESPONDENT" }),
    );
  });

  it("throws claim_already_resolved when claim is approved", async () => {
    const { deps } = makeDeps({
      claim: makeClaim({ status: "approved" }),
    });

    await expect(
      respondToClaim(deps, {
        actorHumanId: SELLER_ID,
        claimId: CLAIM_ID,
        sellerEvidence: { reply: "ticket was valid" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_ALREADY_RESOLVED" }),
    );
  });

  it("throws claim_already_resolved when claim is denied", async () => {
    const { deps } = makeDeps({
      claim: makeClaim({ status: "denied" }),
    });

    await expect(
      respondToClaim(deps, {
        actorHumanId: SELLER_ID,
        claimId: CLAIM_ID,
        sellerEvidence: { reply: "ticket was valid" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_ALREADY_RESOLVED" }),
    );
  });

  it("throws claim_already_resolved when claim is expired", async () => {
    const { deps } = makeDeps({
      claim: makeClaim({ status: "expired" }),
    });

    await expect(
      respondToClaim(deps, {
        actorHumanId: SELLER_ID,
        claimId: CLAIM_ID,
        sellerEvidence: { reply: "ticket was valid" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_ALREADY_RESOLVED" }),
    );
  });

  it("a reply racing a staff decision writes nothing and is refused", async () => {
    // The read saw `open`, but a decision committed before the write: the
    // conditional write matches no row.
    const { deps, mocks } = makeDeps();
    mocks.recordSellerResponse.mockResolvedValueOnce(null);

    await expect(
      respondToClaim(deps, {
        actorHumanId: SELLER_ID,
        claimId: CLAIM_ID,
        sellerEvidence: { reply: "ticket was valid" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_ALREADY_RESOLVED" }),
    );
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  // No reply deadline: the seller may reply until staff decide (owner
  // rulings Q8 + Q9, 2026-10-06 — claims never close on their own).
  const PAST_DEADLINE = new Date("2026-03-09T00:00:00Z"); // < NOW

  it.each(["open", "under_review"] as const)(
    "accepts a reply after the deadline while the claim is %s",
    async (status) => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status, deadline: PAST_DEADLINE }),
      });

      const result = await respondToClaim(deps, {
        actorHumanId: SELLER_ID,
        claimId: CLAIM_ID,
        sellerEvidence: { reply: "ticket was valid" },
      });

      expect(result).toEqual({
        claimId: CLAIM_ID,
        respondedAt: NOW.toISOString(),
      });
      expect(mocks.recordSellerResponse).toHaveBeenCalledWith(CLAIM_ID, {
        sellerEvidence: { reply: "ticket was valid" },
        respondedAt: NOW,
      });
    },
  );

  it.each(["approved", "denied", "expired"] as const)(
    "still refuses a reply after the deadline once the claim is %s",
    async (status) => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status, deadline: PAST_DEADLINE }),
      });

      await expect(
        respondToClaim(deps, {
          actorHumanId: SELLER_ID,
          claimId: CLAIM_ID,
          sellerEvidence: { reply: "ticket was valid" },
        }),
      ).rejects.toEqual(
        expect.objectContaining({ code: "CLAIM_ALREADY_RESOLVED" }),
      );
      expect(mocks.recordSellerResponse).not.toHaveBeenCalled();
    },
  );
});
