// ── Claim status (validated in app code, not Prisma enum) ──
// "expired" is legacy and read-only: nothing writes it since the claim-expiry
// job was removed (owner ruling Q9, 2026-10-06 — staff review every claim).
export type ClaimStatus =
  | "open"
  | "under_review"
  | "approved"
  | "denied"
  | "expired";

export type ClaimKind =
  | "ticket_invalid"
  | "entry_denied"
  | "wrong_seat"
  | "other";

export type ClaimResolution =
  | "full_refund"
  | "denied"
  | "expired";

// ── Records ──

export interface ClaimRecord {
  id: string;
  orderId: string;
  orderItemId: string;
  eventId: string;
  claimantId: string;
  respondentId: string;
  kind: string;
  status: ClaimStatus;
  evidence: unknown;
  deadline: Date;
  resolvedAt: Date | null;
  resolvedById: string | null;
  resolutionNote: string | null;
  resolution: string | null;
  sellerEvidence: unknown;
  sellerRespondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Inputs ──

export interface CreateClaimInput {
  orderId: string;
  orderItemId: string;
  eventId: string;
  claimantId: string;
  respondentId: string;
  kind: ClaimKind;
  evidence: unknown;
  deadline: Date;
}

export interface UpdateClaimStatusInput {
  /**
   * The status the caller decided on (read under the claim lock). The update
   * applies only while the row still has it; otherwise nothing is written.
   */
  fromStatus: ClaimStatus;
  status: ClaimStatus;
  resolvedById?: string;
  resolutionNote?: string;
  resolution?: ClaimResolution;
}
