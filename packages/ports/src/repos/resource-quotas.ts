import type {
  CreateExpansionRequestInput,
  DefaultResourceLimitRecord,
  EffectiveQuota,
  ExpansionRequestRecord,
  GetResourceUsageInput,
  IncrementResourceUsageInput,
  ListExpansionRequestsInput,
  ListExpansionRequestsResult,
  ResourceLimitKind,
  ResourceQuotaOverrideRecord,
  ResourceUsageRecord,
  ReviewExpansionRequestInput,
  UpsertDefaultResourceLimitInput,
  UpsertResourceQuotaOverrideInput,
} from "@th/types/repos/resource-quotas";

export interface ResourceQuotasRepo {
  // ── Default limits ────────────────────────────────────────────────────────
  /** Get the platform default limit for a resource kind. */
  getDefaultLimit(
    kind: ResourceLimitKind,
  ): Promise<DefaultResourceLimitRecord | null>;
  /** List all platform defaults. */
  listDefaultLimits(): Promise<DefaultResourceLimitRecord[]>;
  /** Create or update a platform default limit. */
  upsertDefaultLimit(
    input: UpsertDefaultResourceLimitInput,
  ): Promise<DefaultResourceLimitRecord>;

  // ── Per-subject overrides ─────────────────────────────────────────────────
  /** Get a per-subject quota override (if one exists). */
  getOverride(
    input: GetResourceUsageInput,
  ): Promise<ResourceQuotaOverrideRecord | null>;
  /** Create or update a per-subject quota override. */
  upsertOverride(
    input: UpsertResourceQuotaOverrideInput,
  ): Promise<ResourceQuotaOverrideRecord>;

  // ── Usage tracking ────────────────────────────────────────────────────────
  /** Get current usage for a subject+kind. Returns null when no usage row exists (treat as 0). */
  getUsage(input: GetResourceUsageInput): Promise<ResourceUsageRecord | null>;
  /** Atomically increment (or decrement) usage. Creates the row if absent. */
  incrementUsage(
    input: IncrementResourceUsageInput,
  ): Promise<ResourceUsageRecord>;
  /**
   * Hard-delete the usage row for a subject+kind (idempotent no-op when
   * absent). Used when the subject itself is deleted (e.g. account deletion)
   * so quota rows don't survive as polymorphic orphans.
   */
  deleteUsage(input: GetResourceUsageInput): Promise<void>;

  // ── Effective quota (convenience) ─────────────────────────────────────────
  /**
   * Resolve the effective limit for a subject+kind by checking:
   * 1. Per-subject override
   * 2. Platform default
   * Also fetches current usage so the caller can compare in one round-trip.
   */
  getEffectiveQuota(input: GetResourceUsageInput): Promise<EffectiveQuota>;

  // ── Expansion requests ────────────────────────────────────────────────────
  getExpansionRequestById(id: string): Promise<ExpansionRequestRecord | null>;
  createExpansionRequest(
    input: CreateExpansionRequestInput,
  ): Promise<ExpansionRequestRecord>;
  reviewExpansionRequest(
    input: ReviewExpansionRequestInput,
  ): Promise<ExpansionRequestRecord>;
  listExpansionRequests(
    input: ListExpansionRequestsInput,
  ): Promise<ListExpansionRequestsResult>;
  /** Check if the subject already has a PENDING request for the given kind. */
  hasPendingExpansionRequest(input: GetResourceUsageInput): Promise<boolean>;

  /**
   * Count the number of completed (transferred) PayoutItems for an org.
   * Used to derive the org's hidden trust level for quota scaling.
   */
  getCompletedPayoutCountForOrg(orgId: string): Promise<number>;
}

export type {
  CreateExpansionRequestInput,
  DefaultResourceLimitRecord,
  EffectiveQuota,
  ExpansionRequestRecord,
  ExpansionRequestStatus,
  GetResourceUsageInput,
  IncrementResourceUsageInput,
  ListExpansionRequestsInput,
  ListExpansionRequestsResult,
  OrgTrustLevel,
  QuotaSubjectType,
  ResourceLimitKind,
  ResourceQuotaOverrideRecord,
  ResourceUsageRecord,
  ReviewExpansionRequestInput,
  TrustScaledKind,
  UpsertDefaultResourceLimitInput,
  UpsertResourceQuotaOverrideInput,
} from "@th/types/repos/resource-quotas";
