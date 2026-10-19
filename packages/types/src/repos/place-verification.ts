import type { PageVisibility } from "./entity-pages";

export type PlaceVerificationRequestStatus =
  | "PENDING"
  | "IN_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN";

/** Active = not yet decided (PENDING or IN_REVIEW). */
export const ACTIVE_VERIFICATION_STATUSES = [
  "PENDING",
  "IN_REVIEW",
] as const satisfies readonly PlaceVerificationRequestStatus[];

export type PlaceVerificationRequestSource =
  | "ORG_SUBMISSION"
  | "OWNERSHIP_CLAIM"
  | "OWNERSHIP_DISPUTE";

export type PlaceOwnerType = "HUMAN" | "ORGANIZATION";

export interface PlaceVerificationRequestRecord {
  id: string;
  placeId: string;
  /** Null for HUMAN ownership claims (no org involved). */
  orgId: string | null;
  /** Null when the submitting account has been deleted (submitter detached). */
  submittedById: string | null;
  status: PlaceVerificationRequestStatus;
  /** What opened this request. Legacy rows + org verifications are ORG_SUBMISSION. */
  source: PlaceVerificationRequestSource;
  /** Claim provenance (null for ORG_SUBMISSION). */
  claimantHumanId: string | null;
  claimOwnerType: PlaceOwnerType | null;
  claimOwnerId: string | null;
  /** The provisional PlaceOwnership row this claim created (null for ORG_SUBMISSION). */
  ownershipId: string | null;
  reviewerNotes: string | null;
  reviewerHumanId: string | null;
  reviewedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaceVerificationDocumentRecord {
  id: string;
  requestId: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  deletedAt: Date | null;
  createdAt: Date;
}

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface CreatePlaceVerificationRequestInput {
  placeId: string;
  /** Null for HUMAN ownership claims. Required for ORG_SUBMISSION. */
  orgId?: string | null;
  submittedById: string;
  /** Defaults to ORG_SUBMISSION when omitted (preserves legacy callers). */
  source?: PlaceVerificationRequestSource;
  claimantHumanId?: string | null;
  claimOwnerType?: PlaceOwnerType | null;
  claimOwnerId?: string | null;
  ownershipId?: string | null;
}

export interface UpdateVerificationDecisionInput {
  requestId: string;
  status: "APPROVED" | "REJECTED";
  reviewerHumanId: string;
  reviewerNotes: string | null;
  reviewedAt: Date;
}

export interface AcknowledgeVerificationInput {
  requestId: string;
  acknowledgedBy: string;
  acknowledgedAt: Date;
}

export interface WithdrawVerificationInput {
  requestId: string;
}

export interface ListVerificationQueueInput {
  /** When omitted, returns PENDING + IN_REVIEW. */
  statuses?: PlaceVerificationRequestStatus[];
  limit: number;
  offset: number;
}

export interface VerificationQueueItem {
  request: PlaceVerificationRequestRecord;
  place: {
    id: string;
    name: string;
    formattedAddress: string | null;
    city: string | null;
    region: string | null;
    countryCode: string | null;
    capacity: number | null;
    website: string | null;
    phone: string | null;
  };
  /** Null when the submitting account has been deleted. */
  submitter: { humanId: string; displayName: string | null } | null;
  reviewer: { humanId: string; displayName: string | null } | null;
  acknowledger: { humanId: string; displayName: string | null } | null;
  documentCount: number;
  /**
   * Count of verified ownership claims on the place. Mirrors the `ownerCount`
   * surfaced by `listPlatformPlaces` (which counts verified PlaceOwnership rows),
   * so the same place reports a consistent figure across both admin surfaces.
   */
  ownerCount: number;
}

// ── Claimant-facing "my claims" list (claim-venue flow) ──────────────────────

export interface ListClaimsByClaimantInput {
  claimantHumanId: string;
  cursor?: string | null;
  limit?: number;
}

/**
 * One ownership claim/dispute as seen by ITS CLAIMANT ("my venue claims").
 * Deliberately excludes reviewer identity (reviewerHumanId / acknowledgedBy)
 * and any other party's identifiers — the claimant only sees the outcome
 * ("reviewed on <date>" + reviewer notes), mirroring what
 * `listMyEditSuggestions` exposes for edit suggestions.
 */
export interface ClaimantPlaceClaimItem {
  requestId: string;
  placeId: string;
  placeName: string;
  /**
   * The place's EntityPage slug — what `/p/[slug]` (and `/places/[slug]`)
   * resolve on. Null when the place has no EntityPage row (pre-dates
   * `upsertPlace` auto-provisioning, or bulk-imported); callers must fall back
   * to `/places/id/{placeId}` rather than link to a known 404.
   *
   * A non-null slug is NOT permission to link it — read it with
   * {@link ClaimantPlaceClaimItem.placePageVisibility}.
   */
  placePageSlug: string | null;
  /**
   * The page's owner-set visibility, carried so the link policy stays in core
   * (`lib/entity-page-visibility`). A PRIVATE page keeps its slug while that
   * slug 404s for everyone. Null when the place has no EntityPage.
   */
  placePageVisibility: PageVisibility | null;
  source: "OWNERSHIP_CLAIM" | "OWNERSHIP_DISPUTE";
  status: PlaceVerificationRequestStatus;
  /** The identity the claim was filed AS (the claimant's own human/org). */
  ownerType: PlaceOwnerType;
  ownerId: string;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewerNotes: string | null;
}

export interface ListClaimsByClaimantResult {
  items: ClaimantPlaceClaimItem[];
  nextCursor: string | null;
}

// ── Ownership (claim-venue flow) ──────────────────────────────────────────────

export interface PlaceOwnershipRecord {
  id: string;
  placeId: string;
  ownerType: PlaceOwnerType;
  ownerId: string;
  verified: boolean;
  reviewerHumanId: string | null;
  reviewedAt: Date | null;
  revokedAt: Date | null;
  proof: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProvisionalOwnershipInput {
  placeId: string;
  ownerType: PlaceOwnerType;
  ownerId: string;
  proof: Record<string, unknown>;
}

export interface VerifyOwnershipInput {
  ownershipId: string;
  /** Null for the SYSTEM fast-track auto-verify (FR-010); no human reviewer. */
  reviewerHumanId: string | null;
  reviewedAt: Date;
}

export interface RevokeOwnershipInput {
  ownershipId: string;
  revokedAt: Date;
}

/**
 * Directly installs a VERIFIED ownership row (dispute-resolution transfer —
 * FR-008 follow-up). Unlike createProvisionalOwnership + verifyOwnership this
 * is a single deliberate admin action; `proof` should carry the dispute
 * provenance (e.g. `{ kind: "ownership_dispute", requestId }`).
 */
export interface CreateVerifiedOwnershipInput {
  placeId: string;
  ownerType: PlaceOwnerType;
  ownerId: string;
  /** The admin who approved the dispute (never null here — always human-reviewed). */
  reviewerHumanId: string;
  reviewedAt: Date;
  proof: Record<string, unknown>;
}

export interface CreateVerificationDocumentsInput {
  requestId: string;
  documents: {
    storageKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }[];
}

export interface MarkVerificationDocsDeletedInput {
  requestId: string;
  deletedAt: Date;
}

export interface ListStaleVerificationDocsInput {
  /** Max age in days before a document is considered stale */
  maxAgeDays: number;
  /** Also include docs on non-PENDING requests that were never cleaned up */
  includeDecided: boolean;
}
