import { describe, it, expect, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { ClaimRecord } from "@th/types/repos/claims";

import { getClaim } from "../get-claim";
import { CLAIM_DESK_ROLES } from "../claim-desk-staff";

// ── Constants ──────────────────────────────────────────────────────────────

const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BUYER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELLER_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const STAFF_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
const STRANGER_ID = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const NOW = new Date("2026-03-10T12:00:00Z");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeClaim(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    id: CLAIM_ID,
    orderId: "order-uuid",
    orderItemId: "item-uuid",
    eventId: "event-uuid",
    claimantId: BUYER_ID,
    respondentId: SELLER_ID,
    kind: "ticket_invalid",
    status: "open",
    evidence: { description: "The ticket QR code didn't scan" },
    deadline: new Date("2026-03-15T12:00:00Z"),
    resolvedAt: null,
    resolvedById: null,
    resolutionNote: null,
    resolution: null,
    sellerEvidence: null,
    sellerRespondedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDeps(
  claim: ClaimRecord | null,
  opts?: { staff?: boolean; refunded?: string[] },
) {
  const hasStaffRole = vi.fn(async () => ({ allowed: opts?.staff ?? false }));
  const refundedOrderIds = vi.fn(
    async (ids: string[]) =>
      new Set(ids.filter((id) => (opts?.refunded ?? []).includes(id))),
  );
  return {
    deps: {
      repos: {
        claims: {
          getById: vi.fn(async () => claim),
          refundedOrderIds,
        },
      } as unknown as Repos,
      authz: { hasStaffRole } as unknown as Pick<AuthZPort, "hasStaffRole">,
    },
    mocks: { hasStaffRole, refundedOrderIds },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("getClaim", () => {
  it("returns a serialized claim with ISO date strings", async () => {
    const { deps } = makeDeps(makeClaim());

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: BUYER_ID,
    });

    expect(result.id).toBe(CLAIM_ID);
    expect(result.kind).toBe("ticket_invalid");
    expect(result.status).toBe("open");
    expect(result.deadline).toBe("2026-03-15T12:00:00.000Z");
    expect(result.createdAt).toBe("2026-03-10T12:00:00.000Z");
    expect(result.updatedAt).toBe("2026-03-10T12:00:00.000Z");
    expect(result.resolvedAt).toBeNull();
    expect(result.sellerRespondedAt).toBeNull();
  });

  it("throws not_found when claim does not exist", async () => {
    const { deps, mocks } = makeDeps(null);

    await expect(
      getClaim(deps, { claimId: CLAIM_ID, actorHumanId: BUYER_ID }),
    ).rejects.toEqual(expect.objectContaining({ code: "CLAIM_NOT_FOUND" }));
    expect(mocks.hasStaffRole).not.toHaveBeenCalled();
  });

  it("serializes resolved claim with all date fields", async () => {
    const { deps } = makeDeps(
      makeClaim({
        status: "approved",
        resolvedAt: new Date("2026-03-14T10:00:00Z"),
        resolvedById: "admin-uuid",
        resolutionNote: "Refund issued",
        resolution: "full_refund",
        sellerEvidence: { note: "I disagree" },
        sellerRespondedAt: new Date("2026-03-12T08:00:00Z"),
      }),
      { staff: true },
    );

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: STAFF_ID,
    });

    expect(result.status).toBe("approved");
    expect(result.resolvedAt).toBe("2026-03-14T10:00:00.000Z");
    expect(result.resolvedById).toBe("admin-uuid");
    expect(result.resolutionNote).toBe("Refund issued");
    expect(result.resolution).toBe("full_refund");
    expect(result.sellerRespondedAt).toBe("2026-03-12T08:00:00.000Z");
  });

  it("preserves evidence as opaque JSON", async () => {
    const evidence = { photos: ["url1", "url2"], description: "bad ticket" };
    const { deps } = makeDeps(makeClaim({ evidence }), { staff: true });

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: STAFF_ID,
    });

    expect(result.evidence).toEqual(evidence);
  });

  it("derives the buyer's description and the seller's reply for the claim desk", async () => {
    const { deps } = makeDeps(
      makeClaim({
        evidence: { description: "The QR code didn't scan" },
        sellerEvidence: { reply: "It scanned fine for me" },
        sellerRespondedAt: new Date("2026-03-12T08:00:00Z"),
      }),
    );

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: BUYER_ID,
    });

    expect(result.evidenceText).toBe("The QR code didn't scan");
    expect(result.sellerReplyText).toBe("It scanned fine for me");
    expect(result.sellerRespondedAt).toBe("2026-03-12T08:00:00.000Z");
  });

  it("sellerReplyText is null before the seller replies", async () => {
    const { deps } = makeDeps(makeClaim());

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: BUYER_ID,
    });

    expect(result.evidenceText).toBe("The ticket QR code didn't scan");
    expect(result.sellerReplyText).toBeNull();
    expect(result.sellerRespondedAt).toBeNull();
  });

  // Rows written before v1 typed evidence can hold any JSON. Reading them
  // never throws; the derived text is null and the raw value still rides.
  it.each([
    ["{}", {}, {}],
    ["null", null, null],
    ["a bare string", "just text", "just text"],
    ["an array", ["a"], ["a"]],
    ["a wrong key", { note: "QR" }, { note: "QR" }],
    ["a non-string value", { description: 42 }, { reply: false }],
    ["a blank string", { description: "  " }, { reply: "" }],
  ])("tolerates legacy evidence that is %s", async (_label, evidence, sellerEvidence) => {
    const { deps } = makeDeps(makeClaim({ evidence, sellerEvidence }), { staff: true });

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: STAFF_ID,
    });

    expect(result.evidenceText).toBeNull();
    expect(result.sellerReplyText).toBeNull();
    expect(result.evidence).toEqual(evidence);
    expect(result.sellerEvidence).toEqual(sellerEvidence);
  });

  // ── Authorization ────────────────────────────────────────────────────────

  it("rejects input without an actorHumanId", async () => {
    const { deps } = makeDeps(makeClaim());

    await expect(getClaim(deps, { claimId: CLAIM_ID })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("the seller (respondent) may read the claim without being staff", async () => {
    const { deps, mocks } = makeDeps(makeClaim());

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: SELLER_ID,
    });

    expect(result.id).toBe(CLAIM_ID);
    expect(mocks.hasStaffRole).not.toHaveBeenCalled();
  });

  it("the seller gets the respondent view: no buyer identity, order ids, staff id or raw evidence", async () => {
    const { deps } = makeDeps(
      makeClaim({
        status: "denied",
        resolution: "denied",
        resolvedById: STAFF_ID,
        sellerEvidence: { reply: "It scanned" },
      }),
    );

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: SELLER_ID,
    });

    expect(result.view).toBe("respondent");
    for (const key of [
      "claimantId",
      "orderId",
      "orderItemId",
      "respondentId",
      "resolvedById",
      "evidence",
      "sellerEvidence",
    ]) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result).toMatchObject({
      evidenceText: "The ticket QR code didn't scan",
      sellerReplyText: "It scanned",
      status: "denied",
      eventId: "event-uuid",
      refundConfirmed: false,
    });
  });

  it("a buyer who is staff, and staff, get the full view", async () => {
    for (const actorHumanId of [BUYER_ID, STAFF_ID]) {
      const { deps } = makeDeps(makeClaim(), { staff: true });
      const result = await getClaim(deps, { claimId: CLAIM_ID, actorHumanId });
      expect(result).toMatchObject({
        view: "full",
        claimantId: BUYER_ID,
        orderId: "order-uuid",
      });
    }
  });

  it("refundConfirmed: approved + order REFUNDED → true; approved + refund not landed → false", async () => {
    const approved = makeClaim({ status: "approved", resolution: "full_refund" });

    const landed = makeDeps(approved, { refunded: ["order-uuid"] });
    const a = await getClaim(landed.deps, { claimId: CLAIM_ID, actorHumanId: BUYER_ID });
    expect(a.refundConfirmed).toBe(true);
    expect(landed.mocks.refundedOrderIds).toHaveBeenCalledWith(["order-uuid"]);

    const pending = makeDeps(approved, { refunded: [] });
    const b = await getClaim(pending.deps, { claimId: CLAIM_ID, actorHumanId: BUYER_ID });
    expect(b.refundConfirmed).toBe(false);
  });

  it("refundConfirmed is false and unread for a claim that is not approved", async () => {
    const { deps, mocks } = makeDeps(makeClaim({ status: "open" }), {
      refunded: ["order-uuid"],
    });

    const result = await getClaim(deps, { claimId: CLAIM_ID, actorHumanId: BUYER_ID });

    expect(result.refundConfirmed).toBe(false);
    expect(mocks.refundedOrderIds).not.toHaveBeenCalled();
  });

  it("the buyer (claimant) may read the claim without being staff", async () => {
    const { deps, mocks } = makeDeps(makeClaim());

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: BUYER_ID,
    });

    expect(result.id).toBe(CLAIM_ID);
    // One probe: a claimant who is staff gets the full view instead.
    expect(mocks.hasStaffRole).toHaveBeenCalledTimes(1);
  });

  it("the buyer gets the claimant view: own order ids, no seller or staff identity, no raw evidence", async () => {
    const { deps } = makeDeps(
      makeClaim({
        status: "denied",
        resolution: "denied",
        resolvedById: STAFF_ID,
        sellerEvidence: { reply: "It scanned" },
      }),
    );

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: BUYER_ID,
    });

    expect(result).toMatchObject({
      view: "claimant",
      orderId: "order-uuid",
      orderItemId: "item-uuid",
      evidenceText: "The ticket QR code didn't scan",
      sellerReplyText: "It scanned",
      refundConfirmed: false,
    });
    for (const key of [
      "claimantId",
      "respondentId",
      "resolvedById",
      "evidence",
      "sellerEvidence",
    ]) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it("claim-desk staff may read any claim", async () => {
    const { deps, mocks } = makeDeps(makeClaim(), { staff: true });

    const result = await getClaim(deps, {
      claimId: CLAIM_ID,
      actorHumanId: STAFF_ID,
    });

    expect(result.id).toBe(CLAIM_ID);
    expect(mocks.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: STAFF_ID,
      requiredRoles: [...CLAIM_DESK_ROLES],
    });
  });

  it("a stranger gets CLAIM_NOT_FOUND — indistinguishable from a missing claim (no existence oracle)", async () => {
    const { deps, mocks } = makeDeps(makeClaim(), { staff: false });

    await expect(
      getClaim(deps, { claimId: CLAIM_ID, actorHumanId: STRANGER_ID }),
    ).rejects.toEqual(expect.objectContaining({ code: "CLAIM_NOT_FOUND" }));
    expect(mocks.hasStaffRole).toHaveBeenCalledTimes(1);
  });
});
