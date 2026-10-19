import type { HumanStatus } from "./humans";

export interface ApiKeyLookupInput {
  apiKey: string;
}

export interface ApiKeyLookupResult {
  apiKeyId: string;
  humanId: string;
  /**
   * The owning Human's status, read in the same statement as the key. The
   * authn adapter refuses any key whose owner is not `ACTIVE` (a ban must
   * stop API keys, not just sessions).
   */
  humanStatus: HumanStatus;
}

export interface ApiKeyRecord {
  id: string;
  humanId: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface CreateApiKeyRepoInput {
  humanId: string;
  label?: string;
}

export interface CreateApiKeyRepoResult {
  id: string;
  key: string;
  createdAt: Date;
}

export interface ListApiKeysByHumanInput {
  humanId: string;
  limit: number;
  offset: number;
}

export interface ListApiKeysByHumanResult {
  items: ApiKeyRecord[];
  total: number;
}

export interface RevokeApiKeyRepoInput {
  apiKeyId: string;
  humanId: string;
}

export interface GetApiKeyByIdInput {
  apiKeyId: string;
  humanId: string;
}

export interface CountActiveApiKeysInput {
  humanId: string;
}

export interface RevokeAllApiKeysForHumanInput {
  humanId: string;
}

export interface RevokeAllApiKeysForHumanResult {
  /**
   * Keys cut off: those that were LIVE (unexpired) when revoked, scoped and
   * legacy. Already-expired unrevoked keys are closed too but not counted.
   */
  count: number;
  /**
   * Key requests closed for account security (R31): the holder's pending
   * requests (undecided, under 14 days) and approved requests still inside
   * their 7-day collect window. Each records withdrawalReason
   * ACCOUNT_SECURITY. Already-lapsed requests are left as they are.
   */
  closedRequestCount: number;
}

// ── Scoped API keys (scoped-api-keys spec 2026-10-08) ──────────────────────
//
// Domain shapes for the key-request lifecycle and scoped keys. Never carries
// the key hash. Timestamps are UTC instants (the columns are tz-naive and
// written in UTC by the DB guards).

/** Mirrors the Prisma enum `ApiKeySubject` (R18). */
export type ApiKeySubject = "ORG" | "PERSONAL" | "STAFF" | "PLATFORM_WIDE";

/** Mirrors the Prisma enum `ApiKeyAccess` (R3). */
export type ApiKeyAccess = "READ" | "READ_WRITE";

/** Mirrors the Prisma enum `ApiKeyRequestDecision` (FR-003 / FR-004). */
export type ApiKeyRequestDecision = "APPROVED" | "DENIED";

/**
 * Mirrors the Prisma enum `ApiKeyRequestWithdrawal` (FR-004, R31): who or
 * what withdrew a request. ACCOUNT_SECURITY = a password reset or a ban
 * closed it; show the holder why, never "you withdrew".
 */
export type ApiKeyRequestWithdrawal = "REQUESTER" | "ACCOUNT_SECURITY";

export const API_KEY_SUBJECTS = [
  "ORG",
  "PERSONAL",
  "STAFF",
  "PLATFORM_WIDE",
] as const satisfies readonly ApiKeySubject[];

export const API_KEY_ACCESS_LEVELS = [
  "READ",
  "READ_WRITE",
] as const satisfies readonly ApiKeyAccess[];

/**
 * A key request row. Pending / lapsed / uncollected are DERIVED from the
 * timestamps (see the `ApiKeyRequest` model comment), never stored.
 */
export interface ApiKeyRequestRecord {
  id: string;
  requesterHumanId: string;
  subject: ApiKeySubject;
  /** Set exactly when subject = ORG. */
  orgId: string | null;
  access: ApiKeyAccess;
  label: string;
  purpose: string;
  /** NULL = the key never expires (ORG and PERSONAL only). */
  expiryDays: number | null;
  autoRenew: boolean;
  createdAt: Date;
  decidedAt: Date | null;
  decision: ApiKeyRequestDecision | null;
  decidedByHumanId: string | null;
  denialReason: string | null;
  selfApproved: boolean;
  withdrawnAt: Date | null;
  /** Set exactly when withdrawnAt is (R31). */
  withdrawalReason: ApiKeyRequestWithdrawal | null;
  collectedAt: Date | null;
  lapseNotifiedAt: Date | null;
}

/**
 * An API key row, scoped or legacy (legacy: subject/access/requestId NULL,
 * until the FR-013 cutover revokes them). Never carries the key hash.
 */
export interface ScopedApiKeyRecord {
  id: string;
  humanId: string;
  requestId: string | null;
  subject: ApiKeySubject | null;
  orgId: string | null;
  access: ApiKeyAccess | null;
  label: string | null;
  /** Last 4 characters of the plaintext ("thk_…ab12", R25); NULL on legacy keys. */
  keyLast4: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** NULL = never expires. */
  expiresAt: Date | null;
  autoRenew: boolean;
  renewedFromKeyId: string | null;
  revokedAt: Date | null;
  revokedByHumanId: string | null;
  revokeReason: string | null;
  expiryNotifiedAt: Date | null;
}

/**
 * A key as the three screens list it: the key plus the request fields they
 * show (purpose, self-approval flag, approver). Request fields are NULL on
 * legacy keys.
 */
export interface ApiKeyListItem extends ScopedApiKeyRecord {
  purpose: string | null;
  selfApproved: boolean;
  decidedByHumanId: string | null;
  /** The request's auto-renew switch (the approver's switch-off lands here). */
  requestAutoRenew: boolean | null;
}

/**
 * The key scope resolved with the key on the per-request auth path
 * (NFR-003: same single statement). `legacy` = a key with no subject, minted
 * by the old `apiKeys.create`; it keeps working until the FR-013 cutover and
 * step 4 decides what it may reach. It is NEVER granted a scope implicitly.
 */
export type ResolvedApiKeyScope =
  | {
      kind: "scoped";
      keyId: string;
      requestId: string;
      subject: ApiKeySubject;
      access: ApiKeyAccess;
      /** Set exactly when subject = ORG. */
      orgId: string | null;
    }
  | { kind: "legacy"; keyId: string };

/** `getHumanIdForKey` result once the key's scope rides along. */
export interface ApiKeyLookupWithScopeResult extends ApiKeyLookupResult {
  keyScope: ResolvedApiKeyScope;
}

export interface CreateApiKeyRequestRepoInput {
  requesterHumanId: string;
  subject: ApiKeySubject;
  orgId: string | null;
  access: ApiKeyAccess;
  label: string;
  purpose: string;
  expiryDays: number | null;
  autoRenew: boolean;
}

export interface DecideApiKeyRequestRepoInput {
  requestId: string;
  decision: ApiKeyRequestDecision;
  decidedByHumanId: string;
  /** Required (and only allowed) on DENIED. */
  denialReason: string | null;
  /**
   * The platform owner approving their own STAFF request (FR-003). Core
   * decides it; the DB refuses a value that does not match "decider is
   * requester" (CHECK api_key_requests_self_approved_is_self) or a non-STAFF /
   * non-APPROVED self-approval (CHECK api_key_requests_self_approved_shape).
   */
  selfApproved: boolean;
}

/**
 * Outcome of a decide CAS. Only `decided` changed the row; every other
 * status is a no-op read back for the caller to explain.
 */
export type DecideApiKeyRequestOutcome =
  | { status: "decided"; request: ApiKeyRequestRecord }
  | { status: "not_found" }
  | { status: "already_decided"; request: ApiKeyRequestRecord }
  | { status: "withdrawn"; request: ApiKeyRequestRecord }
  /** APPROVED refused: the request is 14+ days old (FR-004). DENIED is still allowed. */
  | { status: "lapsed"; request: ApiKeyRequestRecord };

export type WithdrawApiKeyRequestOutcome =
  | { status: "withdrawn"; request: ApiKeyRequestRecord }
  /** No such request, or the caller is not its requester. */
  | { status: "not_found" }
  | { status: "already_decided"; request: ApiKeyRequestRecord }
  | { status: "already_withdrawn"; request: ApiKeyRequestRecord };

export interface CollectApiKeyRepoInput {
  requestId: string;
  holderHumanId: string;
}

/**
 * A freshly minted key. `key` is the plaintext, returned ONCE; only its
 * SHA-256 hash is stored (FR-005).
 */
export interface MintedApiKey {
  key: string;
  record: ScopedApiKeyRecord;
}

export type CollectApiKeyOutcome =
  | ({ status: "collected" } & MintedApiKey)
  /** No such request, or the caller is not its requester. */
  | { status: "not_found" }
  /** The holder's `Human.status` is not ACTIVE (banned, suspended, …). */
  | { status: "holder_inactive" };

export interface RenewApiKeyRepoInput {
  parentKeyId: string;
  holderHumanId: string;
}

export type RenewApiKeyOutcome =
  | ({ status: "renewed" } & MintedApiKey)
  /** No such key, not the holder's, or a legacy key (no request to renew under). */
  | { status: "not_found" };

export interface RevokeScopedApiKeyRepoInput {
  keyId: string;
  /** NULL for a system revoke (no human revoker). */
  revokedByHumanId: string | null;
  reason: string | null;
}

export type RevokeScopedApiKeyOutcome =
  | {
      status: "revoked";
      /** Keys that were LIVE (unexpired) and are now cut off. */
      revokedKeyIds: string[];
      /**
       * Unrevoked keys on the same request that had already expired; they
       * are marked revoked too (the approval is closed) but were not cut
       * off by this revoke. Notices and audit must not describe them as such.
       */
      alsoClosedExpiredKeyIds: string[];
    }
  | { status: "not_found" }
  | { status: "already_revoked" };

export interface SetApiKeyAutoRenewRepoInput {
  keyId: string;
  autoRenew: boolean;
}

export type SetApiKeyAutoRenewOutcome =
  | { status: "updated"; record: ScopedApiKeyRecord }
  | { status: "unchanged"; record: ScopedApiKeyRecord }
  | { status: "not_found" }
  /** Revoked or expired keys do not change. */
  | { status: "not_live"; record: ScopedApiKeyRecord }
  /** Switching ON while the request is off (approver's switch-off is final). */
  | { status: "request_disallows"; record: ScopedApiKeyRecord };

export type SwitchOffRequestAutoRenewOutcome =
  | { status: "switched_off"; request: ApiKeyRequestRecord; keyIds: string[] }
  | { status: "unchanged"; request: ApiKeyRequestRecord }
  | { status: "not_found" };

export interface CountForApiKeyCapInput {
  holderHumanId: string;
  subject: ApiKeySubject;
  /** Required when subject = ORG. */
  orgId: string | null;
}

/**
 * FR-011 counts: one per approval slot (a pending request, an approved
 * request still inside its 7-day collect window, or a collected request with
 * at least one live key). A renewal pair in its 24h overlap is one slot.
 */
export interface CountForApiKeyCapResult {
  /** The holder's slots on this subject (on this org, for ORG). */
  holderCount: number;
  /** All holders' slots on the org; NULL unless subject = ORG. */
  orgCount: number | null;
  /**
   * Key requests the holder created in the last 24 hours (DB clock), every
   * subject and state, withdrawn and lapsed included. Feeds core's per-holder
   * request rate limit, an abuse limit set by the orchestrator (2026-10-13),
   * not a spec rule: request-and-withdraw in a loop would otherwise flood
   * approvers with notices.
   */
  holderRequestsLast24h: number;
}

export interface ListPlatformApiKeyQueueInput {
  subjects: readonly ApiKeySubject[];
  /**
   * Also list ORG requests whose org has no live OWNER/ADMIN other than the
   * requester (Key scopes table: "none → any platform staff").
   */
  includeOrgFallbacks: boolean;
  limit: number;
}

export interface ListAllApiKeysInput {
  limit: number;
  offset: number;
  subject?: ApiKeySubject;
}

export interface ListAllApiKeysResult {
  items: ApiKeyListItem[];
  total: number;
}

/** A request whose lapse notice (FR-004 14-day / FR-005 7-day) is due. */
export interface ApiKeyRequestLapseDue {
  request: ApiKeyRequestRecord;
  kind: "pending_lapsed" | "collect_lapsed";
}
