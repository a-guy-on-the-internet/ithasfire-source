// ─────────────────────────────────────────────────────────────────────────────
// Resource quota types
// ─────────────────────────────────────────────────────────────────────────────

export type ResourceLimitKind =
  | "ORGS_OWNED"
  | "ORGS_JOINED"
  | "STORAGE_BYTES_ORG"
  | "STORAGE_BYTES_HUMAN"
  /**
   * Cumulative upload storage per PLACE (subject=PLACE): page images a
   * community moderator uploads to an unowned place's page. Held by the
   * place, never by the moderator (moderator place page spec R5).
   */
  | "STORAGE_BYTES_PLACE"
  | "EVENTS_PER_ORG"
  | "MEMBERS_PER_ORG"
  | "ANNOUNCEMENTS_PER_DAY";

/** Exhaustive list of every ResourceLimitKind value. */
export const ALL_RESOURCE_LIMIT_KINDS: readonly ResourceLimitKind[] = [
  "ORGS_OWNED",
  "ORGS_JOINED",
  "STORAGE_BYTES_ORG",
  "STORAGE_BYTES_HUMAN",
  "STORAGE_BYTES_PLACE",
  "EVENTS_PER_ORG",
  "MEMBERS_PER_ORG",
  "ANNOUNCEMENTS_PER_DAY",
] as const;

/**
 * Platform-wide fallback limits applied when no DefaultResourceLimit row exists.
 * These are generous enough for legitimate use but catch abuse.
 * Both the adapter (runtime enforcement) and use cases (admin UI listing)
 * reference this single source of truth.
 */
export const DEFAULT_RESOURCE_LIMITS: Record<ResourceLimitKind, bigint> = {
  ORGS_OWNED: 3n,
  ORGS_JOINED: 10n,
  STORAGE_BYTES_ORG: 1_073_741_824n, // 1 GiB
  STORAGE_BYTES_HUMAN: 536_870_912n, // 512 MiB
  STORAGE_BYTES_PLACE: 536_870_912n, // 512 MiB, the human default
  EVENTS_PER_ORG: 50n,
  MEMBERS_PER_ORG: 25n,
  ANNOUNCEMENTS_PER_DAY: 20n,
};

// ── Org trust levels (hidden) ───────────────────────────────────────────────
//
// Orgs automatically earn higher quota limits based on their payout history.
// "Completed payouts" = distinct PayoutItem rows with status "transferred" for
// the org's Payee record.  Trust levels are invisible to users — they silently
// raise the effective limit for ORG-scoped kinds.
//
// Resolution order:  Override (manual) → Trust-level → Platform default → Hardcoded fallback.

export type OrgTrustLevel = 0 | 1 | 2 | 3;

/** Minimum number of completed (transferred) payouts to reach each trust level. */
export const TRUST_LEVEL_THRESHOLDS: Record<OrgTrustLevel, number> = {
  0: 0,
  1: 1,
  2: 5,
  3: 20,
};

/** ORG-scoped kinds whose limits scale with trust level. */
export type TrustScaledKind =
  | "EVENTS_PER_ORG"
  | "MEMBERS_PER_ORG"
  | "ANNOUNCEMENTS_PER_DAY"
  | "STORAGE_BYTES_ORG";

/** All ORG-scoped kinds that scale with trust. */
export const TRUST_SCALED_KINDS: readonly TrustScaledKind[] = [
  "EVENTS_PER_ORG",
  "MEMBERS_PER_ORG",
  "ANNOUNCEMENTS_PER_DAY",
  "STORAGE_BYTES_ORG",
] as const;

/**
 * Sentinel value meaning "no limit".  Used for EVENTS_PER_ORG at trust
 * level 2+ so established orgs are never blocked from creating events.
 * `enforceQuota` skips enforcement when the limit equals this value.
 */
export const QUOTA_UNLIMITED = BigInt("9007199254740991"); // Number.MAX_SAFE_INTEGER as bigint

/**
 * Per-kind limit for each trust level.
 * Level 0 mirrors the hardcoded defaults so behaviour is unchanged for new orgs.
 * EVENTS_PER_ORG becomes effectively unlimited at level 2 (5+ payouts).
 */
export const TRUST_LEVEL_LIMITS: Record<
  OrgTrustLevel,
  Record<TrustScaledKind, bigint>
> = {
  0: {
    EVENTS_PER_ORG: 50n,
    MEMBERS_PER_ORG: 25n,
    ANNOUNCEMENTS_PER_DAY: 20n,
    STORAGE_BYTES_ORG: 1_073_741_824n,
  },
  1: {
    EVENTS_PER_ORG: 100n,
    MEMBERS_PER_ORG: 50n,
    ANNOUNCEMENTS_PER_DAY: 40n,
    STORAGE_BYTES_ORG: 5_368_709_120n,
  },
  2: {
    EVENTS_PER_ORG: QUOTA_UNLIMITED,
    MEMBERS_PER_ORG: 100n,
    ANNOUNCEMENTS_PER_DAY: 75n,
    STORAGE_BYTES_ORG: 21_474_836_480n,
  },
  3: {
    EVENTS_PER_ORG: QUOTA_UNLIMITED,
    MEMBERS_PER_ORG: 250n,
    ANNOUNCEMENTS_PER_DAY: 150n,
    STORAGE_BYTES_ORG: 107_374_182_400n,
  },
};

/**
 * Derive the trust level from a count of completed (transferred) payouts.
 * Walks the thresholds from highest to lowest, returning the first match.
 */
export function orgTrustLevelFromPayoutCount(
  completedPayouts: number,
): OrgTrustLevel {
  if (completedPayouts >= TRUST_LEVEL_THRESHOLDS[3]) return 3;
  if (completedPayouts >= TRUST_LEVEL_THRESHOLDS[2]) return 2;
  if (completedPayouts >= TRUST_LEVEL_THRESHOLDS[1]) return 1;
  return 0;
}

/**
 * Returns true if `kind` participates in trust-level scaling.
 */
export function isTrustScaledKind(
  kind: ResourceLimitKind,
): kind is TrustScaledKind {
  return (TRUST_SCALED_KINDS as readonly string[]).includes(kind);
}

/**
 * Who a quota is held by. PLACE holds only STORAGE_BYTES_PLACE (community
 * page uploads on an unowned place); it is charged by core, never chosen by
 * a caller (the transport-facing `quotaSubjectTypeSchema` stays HUMAN | ORG).
 */
export type QuotaSubjectType = "HUMAN" | "ORG" | "PLACE";

export type ExpansionRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

// ── Records ─────────────────────────────────────────────────────────────────

export interface DefaultResourceLimitRecord {
  kind: ResourceLimitKind;
  /** Count or byte value depending on kind. */
  limitValue: bigint;
  updatedAt: Date;
  createdAt: Date;
}

export interface ResourceQuotaOverrideRecord {
  id: string;
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
  limitValue: bigint;
  note: string | null;
  grantedByHumanId: string | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface ResourceUsageRecord {
  id: string;
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
  currentUsage: bigint;
  updatedAt: Date;
  createdAt: Date;
}

export interface ExpansionRequestRecord {
  id: string;
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
  currentLimitValue: bigint;
  requestedLimitValue: bigint;
  reason: string;
  status: ExpansionRequestStatus;
  requestedByHumanId: string;
  reviewedByHumanId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface UpsertDefaultResourceLimitInput {
  kind: ResourceLimitKind;
  limitValue: bigint;
}

export interface UpsertResourceQuotaOverrideInput {
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
  limitValue: bigint;
  note?: string | null;
  grantedByHumanId?: string | null;
}

export interface IncrementResourceUsageInput {
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
  delta: bigint;
}

export interface GetResourceUsageInput {
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
}

export interface CreateExpansionRequestInput {
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
  currentLimitValue: bigint;
  requestedLimitValue: bigint;
  reason: string;
  requestedByHumanId: string;
}

export interface ReviewExpansionRequestInput {
  id: string;
  status: "APPROVED" | "REJECTED";
  reviewedByHumanId: string;
  reviewNote?: string | null;
}

export interface ListExpansionRequestsInput {
  status?: ExpansionRequestStatus;
  limit: number;
  offset: number;
}

export interface ListExpansionRequestsResult {
  items: ExpansionRequestRecord[];
  total: number;
}

/** Resolved effective limit for a subject+kind after checking override → trust-level → default fallback. */
export interface EffectiveQuota {
  kind: ResourceLimitKind;
  limitValue: bigint;
  currentUsage: bigint;
  /** True when an override row exists (rather than using the default). */
  isOverride: boolean;
  /** The org trust level that contributed to the limit (only set for ORG subjects with trust-scaled kinds). */
  trustLevel?: OrgTrustLevel;
}
