import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import type { ClaimRecord } from "@th/types/repos/claims";
import { fail } from "@th/errors";
import { isClaimDeskStaff } from "./claim-desk-staff";
import { claimEvidenceText, claimSellerReplyText } from "./claim-evidence";

// ── Schemas ────────────────────────────────────────────────────────────────

export const getClaimInputSchema = z.object({
  /** Injected by the transport from the session — never client-supplied. */
  actorHumanId: z.string().uuid(),
  claimId: z.string().uuid(),
});

/**
 * Fields every claim view carries: the claim itself as either party may see
 * it. Dates are ISO strings.
 */
const sharedClaimFields = {
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  kind: z.string(),
  status: z.string(),
  deadline: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  resolutionNote: z.string().nullable(),
  resolution: z.string().nullable(),
  sellerRespondedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /**
   * The buyer's description, read from `evidence`. Null when the stored value
   * is not the v1 `{ description }` shape (rows filed before v1).
   */
  evidenceText: z.string().nullable(),
  /**
   * The seller's reply, read from `sellerEvidence`. Null when the seller has
   * not replied or the stored value is not the v1 `{ reply }` shape.
   */
  sellerReplyText: z.string().nullable(),
  /**
   * An approved claim whose refund has actually landed: the claim's order is
   * REFUNDED. Approval commits BEFORE the Stripe refund, which can then fail
   * or stay pending, so `status: "approved"` alone does not mean money moved.
   * Always false for any other status.
   */
  refundConfirmed: z.boolean(),
};

/** The full claim record: claimant (buyer), claim-desk staff, event owner. */
export const claimRecordSchema = z.object({
  view: z.literal("full"),
  ...sharedClaimFields,
  orderId: z.string().uuid(),
  orderItemId: z.string().uuid(),
  claimantId: z.string().uuid(),
  respondentId: z.string().uuid(),
  evidence: z.unknown(),
  resolvedById: z.string().uuid().nullable(),
  sellerEvidence: z.unknown(),
});

/**
 * What the seller (respondent) sees: no buyer identity (`claimantId`), no
 * buyer order ids, no staff identity (`resolvedById`) and no raw evidence
 * JSON — only the derived `*Text` fields.
 */
export const respondentClaimRecordSchema = z.object({
  view: z.literal("respondent"),
  ...sharedClaimFields,
});

/**
 * What the buyer (claimant) sees: the respondent view plus their own order
 * ids (the order page filters on them). No seller identity
 * (`respondentId`), no staff identity (`resolvedById`), no raw evidence JSON.
 */
export const claimantClaimRecordSchema = z.object({
  view: z.literal("claimant"),
  ...sharedClaimFields,
  orderId: z.string().uuid(),
  orderItemId: z.string().uuid(),
});

export const getClaimOutputSchema = z.discriminatedUnion("view", [
  claimRecordSchema,
  claimantClaimRecordSchema,
  respondentClaimRecordSchema,
]);

export type SerializedClaimRecord = z.infer<typeof claimRecordSchema>;
export type SerializedRespondentClaimRecord = z.infer<
  typeof respondentClaimRecordSchema
>;
export type SerializedClaimantClaimRecord = z.infer<
  typeof claimantClaimRecordSchema
>;

export type GetClaimInput = z.infer<typeof getClaimInputSchema>;
export type GetClaimOutput = z.infer<typeof getClaimOutputSchema>;

export type GetClaimDeps = {
  repos: Pick<Repos, "claims">;
  authz: Pick<AuthZPort, "hasStaffRole">;
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Order ids, among `claims`, whose refund is confirmed (order REFUNDED). One
 * query for the whole page, and only for approved claims — the only status
 * `refundConfirmed` describes.
 */
export async function loadRefundedOrderIds(
  claimsRepo: Pick<Repos["claims"], "refundedOrderIds">,
  claims: readonly ClaimRecord[],
): Promise<ReadonlySet<string>> {
  const orderIds = [
    ...new Set(
      claims.filter((c) => c.status === "approved").map((c) => c.orderId),
    ),
  ];
  if (orderIds.length === 0) return new Set();
  return claimsRepo.refundedOrderIds(orderIds);
}

function sharedClaimView(
  claim: ClaimRecord,
  refundedOrderIds: ReadonlySet<string>,
) {
  return {
    id: claim.id,
    eventId: claim.eventId,
    kind: claim.kind,
    status: claim.status,
    deadline: claim.deadline.toISOString(),
    resolvedAt: claim.resolvedAt?.toISOString() ?? null,
    resolutionNote: claim.resolutionNote,
    resolution: claim.resolution,
    sellerRespondedAt: claim.sellerRespondedAt?.toISOString() ?? null,
    createdAt: claim.createdAt.toISOString(),
    updatedAt: claim.updatedAt.toISOString(),
    evidenceText: claimEvidenceText(claim.evidence),
    sellerReplyText: claimSellerReplyText(claim.sellerEvidence),
    refundConfirmed:
      claim.status === "approved" && refundedOrderIds.has(claim.orderId),
  };
}

/** Convert a ClaimRecord (with Date fields) to the full serialized view. */
export function serializeClaimRecord(
  claim: ClaimRecord,
  refundedOrderIds: ReadonlySet<string>,
): SerializedClaimRecord {
  return {
    view: "full",
    ...sharedClaimView(claim, refundedOrderIds),
    orderId: claim.orderId,
    orderItemId: claim.orderItemId,
    claimantId: claim.claimantId,
    respondentId: claim.respondentId,
    evidence: claim.evidence,
    resolvedById: claim.resolvedById,
    sellerEvidence: claim.sellerEvidence,
  };
}

/** The buyer's view of a claim (see {@link claimantClaimRecordSchema}). */
export function serializeClaimantClaimRecord(
  claim: ClaimRecord,
  refundedOrderIds: ReadonlySet<string>,
): SerializedClaimantClaimRecord {
  return {
    view: "claimant",
    ...sharedClaimView(claim, refundedOrderIds),
    orderId: claim.orderId,
    orderItemId: claim.orderItemId,
  };
}

/** The seller's view of a claim (see {@link respondentClaimRecordSchema}). */
export function serializeRespondentClaimRecord(
  claim: ClaimRecord,
  refundedOrderIds: ReadonlySet<string>,
): SerializedRespondentClaimRecord {
  return {
    view: "respondent",
    ...sharedClaimView(claim, refundedOrderIds),
  };
}

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * Fetch a single claim by ID. Readable by the claim's buyer (claimant), its
 * seller (respondent), or claim-desk staff — enforced HERE, not at the
 * transport (`claims.*` is a bare authed router with no role gate upstream).
 *
 * Anyone else gets `CLAIM_NOT_FOUND`, the same shape as a missing claim, so
 * the endpoint is not an error-text oracle for enumerating claim ids (the
 * `POS_READER_ORG_MISMATCH → NOT_FOUND` posture in the transport error map).
 * A stranger probing a REAL id pays one extra read (the staff probe) before
 * the same refusal; ids are v4 UUIDs, so that latency difference is accepted.
 * Contrast `respondToClaim`, which throws `CLAIM_NOT_RESPONDENT`: a mutation
 * whose caller already holds the id from their own seller inbox.
 */
export async function getClaim(
  deps: GetClaimDeps,
  rawInput: unknown,
): Promise<GetClaimOutput> {
  const input = parseInput(getClaimInputSchema, rawInput);

  const claim = await deps.repos.claims.getById(input.claimId);
  if (!claim) {
    throw fail("CLAIM_NOT_FOUND");
  }

  // Each side sees the claim without the other side's identity: the seller
  // gets the respondent view (no staff probe — a seller's own claim never
  // needs it), the buyer the claimant view unless they are claim-desk staff.
  // Staff who are neither party get the full record; anyone else NOT_FOUND.
  const isRespondent =
    claim.respondentId === input.actorHumanId &&
    claim.claimantId !== input.actorHumanId;
  let view: "full" | "claimant" | "respondent";
  if (isRespondent) {
    view = "respondent";
  } else if (await isClaimDeskStaff(deps, input.actorHumanId)) {
    view = "full";
  } else if (claim.claimantId === input.actorHumanId) {
    view = "claimant";
  } else {
    throw fail("CLAIM_NOT_FOUND");
  }

  const refundedOrderIds = await loadRefundedOrderIds(deps.repos.claims, [
    claim,
  ]);
  if (view === "respondent") {
    return serializeRespondentClaimRecord(claim, refundedOrderIds);
  }
  if (view === "claimant") {
    return serializeClaimantClaimRecord(claim, refundedOrderIds);
  }
  return serializeClaimRecord(claim, refundedOrderIds);
}
