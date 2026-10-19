import type {
  ApiKeyListItem,
  ApiKeyLookupInput,
  ApiKeyLookupWithScopeResult,
  ApiKeyRecord,
  ApiKeyRequestLapseDue,
  ApiKeyRequestRecord,
  CollectApiKeyOutcome,
  CollectApiKeyRepoInput,
  CountActiveApiKeysInput,
  CountForApiKeyCapInput,
  CountForApiKeyCapResult,
  CreateApiKeyRepoInput,
  CreateApiKeyRepoResult,
  CreateApiKeyRequestRepoInput,
  DecideApiKeyRequestOutcome,
  DecideApiKeyRequestRepoInput,
  GetApiKeyByIdInput,
  ListAllApiKeysInput,
  ListAllApiKeysResult,
  ListApiKeysByHumanInput,
  ListApiKeysByHumanResult,
  ListPlatformApiKeyQueueInput,
  RenewApiKeyOutcome,
  RenewApiKeyRepoInput,
  RevokeAllApiKeysForHumanInput,
  RevokeAllApiKeysForHumanResult,
  RevokeApiKeyRepoInput,
  RevokeScopedApiKeyOutcome,
  RevokeScopedApiKeyRepoInput,
  ScopedApiKeyRecord,
  SetApiKeyAutoRenewOutcome,
  SetApiKeyAutoRenewRepoInput,
  SwitchOffRequestAutoRenewOutcome,
  WithdrawApiKeyRequestOutcome,
} from "@th/types";

// ── Typed refusals ─────────────────────────────────────────────────────────

/**
 * Why the database refused an api-key write. Every CHECK, the two guard
 * triggers (api_keys_guard / api_key_requests_guard, migrations
 * 20261012120200..20261012120400) and the unique indexes map to one of these;
 * a refusal never reaches the caller as an untyped driver error.
 *
 * Expected outcomes (already decided, withdrawn, lapsed approval, not found)
 * are NOT errors: the CAS methods return them as values. A thrown
 * {@link ApiKeyRepoError} means a guard caught something the caller should
 * have refused first, or a race the guard settled.
 */
export type ApiKeyRepoRefusalReason =
  // A named CHECK constraint; see `constraint` for which one.
  | "check_violation"
  // api_key_requests_guard
  | "request_not_inserted_pending"
  | "request_content_immutable"
  | "request_auto_renew_switch_on"
  | "decision_without_decider"
  | "undecided_with_decider"
  | "request_lapsed"
  | "decision_final"
  | "withdrawal_final"
  // R31: deciding, collecting or renewing under a withdrawn/closed request
  | "request_withdrawn"
  | "collected_at_writer"
  // api_keys_guard
  | "key_born_dirty"
  | "request_not_approved"
  | "expiry_outside_term"
  | "auto_renew_not_allowed"
  | "already_collected_or_collect_lapsed"
  | "renewal_not_allowed"
  | "renewal_overlap"
  | "key_identity_immutable"
  | "revocation_final"
  | "expiry_only_earlier"
  // unique indexes (e.g. api_keys_one_collect_per_request)
  | "unique_violation"
  // composite scope FKs (api_keys_request_scope_fkey / api_keys_request_org_fkey)
  | "foreign_key_violation"
  // a guard message this adapter does not know (a newer guard version)
  | "guard_violation_unknown";

export type ApiKeyRepoErrorCode =
  /** A DB guard refused the write. Not retryable: the same write fails again. */
  | "guard_refused"
  /** Deadlock (40P01) or serialization failure (40001): roll back and retry. */
  | "retryable";

/**
 * Thrown by `ApiKeysRepo` writes when the database refuses them. The
 * surrounding transaction is ABORTED by then (Postgres semantics): callers
 * map it to their own typed error and rethrow; they must not keep writing in
 * the same `repos.tx()`.
 */
export class ApiKeyRepoError extends Error {
  readonly code: ApiKeyRepoErrorCode;
  readonly reason: ApiKeyRepoRefusalReason | null;
  /** The CHECK / index / FK / guard trigger name, when known. */
  readonly constraint: string | null;
  /** Postgres SQLSTATE (23514, 23505, 23503, 40P01, 40001). */
  readonly sqlState: string;

  constructor(params: {
    code: ApiKeyRepoErrorCode;
    reason: ApiKeyRepoRefusalReason | null;
    constraint: string | null;
    sqlState: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "ApiKeyRepoError";
    this.code = params.code;
    this.reason = params.reason;
    this.constraint = params.constraint;
    this.sqlState = params.sqlState;
  }
}

export function isApiKeyRepoError(error: unknown): error is ApiKeyRepoError {
  return error instanceof ApiKeyRepoError;
}

// ── Repo ───────────────────────────────────────────────────────────────────

/**
 * API keys and key requests (scoped-api-keys spec 2026-10-08).
 *
 * Lock order, every method: (advisory cap lock) → request row FOR UPDATE →
 * key rows. The guard triggers follow the same order. Keys are never
 * hard-deleted by app code; revoke is the soft remove.
 */
export interface ApiKeysRepo {
  // ── Authn hot path ───────────────────────────────────────────────────────

  /**
   * Resolve a key to its holder, the holder's `Human.status` and the key
   * scope, in ONE statement (NFR-003): an `UPDATE api_keys … FROM "Human"`
   * that also stamps `last_used_at`. Refuses (returns null for) revoked keys
   * and keys whose `expires_at` is at or before the DB clock. Legacy keys
   * (no subject) come back as `keyScope.kind = "legacy"`; they are never
   * granted a scope here. Callers decide what a non-ACTIVE holder means; the
   * authn adapter refuses it.
   */
  getHumanIdForKey(
    input: ApiKeyLookupInput,
  ): Promise<ApiKeyLookupWithScopeResult | null>;

  // ── Legacy (removed with apiKeys.create, steps 5 / 10) ───────────────────

  /** @deprecated Legacy full-scope mint; removed in step 5 (FR-001). */
  create(input: CreateApiKeyRepoInput): Promise<CreateApiKeyRepoResult>;
  /** @deprecated Legacy list; replaced by {@link listKeysByHolder}. */
  listByHuman(
    input: ListApiKeysByHumanInput,
  ): Promise<ListApiKeysByHumanResult>;
  /** @deprecated Legacy read; replaced by {@link getKey}. */
  getById(input: GetApiKeyByIdInput): Promise<ApiKeyRecord | null>;
  /**
   * @deprecated Legacy revoke of one key; replaced by {@link revokeKey},
   * which revokes the whole approval (both live keys). CAS
   * `WHERE revoked_at IS NULL`; the api_keys_guard trigger stamps revoked_at.
   */
  revoke(input: RevokeApiKeyRepoInput): Promise<void>;
  /**
   * @deprecated Legacy per-human cap (advisory lock + count); replaced by
   * {@link lockAndCountForCap}. MUST be called inside `repos.tx()` (throws
   * on the root client).
   */
  lockAndCountActiveByHuman(input: CountActiveApiKeysInput): Promise<number>;

  /**
   * Revoke every unrevoked key the human holds, scoped and legacy (ban,
   * password reset, account-takeover cleanup). Idempotent; returns how many
   * keys it revoked. Locks the human's APPROVED and undecided request rows
   * by id (sorted) FIRST, then the keys, so a concurrent collect or self-renewal either
   * finishes before the sweep (and its key is revoked) or waits for it (and
   * the renewal's parent is then revoked: api_keys_guard refuses to renew a
   * revoked key). Also CLOSES (R31) the holder's pending requests and
   * approved requests not yet collected (CAS, withdrawalReason
   * ACCOUNT_SECURITY): api_key_requests_guard then refuses to decide them
   * and api_keys_guard refuses to mint a key under them. `count` counts
   * only keys that were live. Opens its own transaction when given the root
   * client. revoked_at / withdrawn_at are stamped by the guards.
   */
  revokeAllForHuman(
    input: RevokeAllApiKeysForHumanInput,
  ): Promise<RevokeAllApiKeysForHumanResult>;

  // ── Key requests ─────────────────────────────────────────────────────────

  /**
   * Insert a pending request. The api_key_requests_guard trigger stamps
   * created_at and refuses a non-pending insert; the CHECKs refuse a bad
   * shape: api_key_requests_org_shape, _platform_wide_read_only,
   * _expiry_days_cap (R6), _auto_renew_min_term (R30). Throws
   * {@link ApiKeyRepoError} (`check_violation` + constraint name) on any of
   * them; core validates first, the DB is the backstop.
   */
  createRequest(
    input: CreateApiKeyRequestRepoInput,
  ): Promise<ApiKeyRequestRecord>;

  getRequest(input: { requestId: string }): Promise<ApiKeyRequestRecord | null>;

  /** The holder's own requests, newest first (account screen). */
  listRequestsByRequester(input: {
    requesterHumanId: string;
    limit: number;
  }): Promise<ApiKeyRequestRecord[]>;

  /**
   * The org's approval queue (R24): ORG requests on the org that are
   * undecided, not withdrawn and not lapsed (created within 14 days). Oldest
   * first.
   */
  listOrgQueue(input: {
    orgId: string;
    limit: number;
  }): Promise<ApiKeyRequestRecord[]>;

  /**
   * The platform queue (FR-014): undecided, unwithdrawn, unlapsed requests of
   * `subjects`, plus (when asked) ORG requests whose org has no ACTIVE
   * OWNER/ADMIN other than the requester. Oldest first. Approval rights are
   * core's to check; this is only the list.
   */
  listPlatformQueue(
    input: ListPlatformApiKeyQueueInput,
  ): Promise<ApiKeyRequestRecord[]>;

  /**
   * Whether the org has a live approver other than `excludeHumanId`: an
   * OrgMember with role OWNER or ADMIN whose Human.status is ACTIVE. The SAME
   * SQL decides the platform queue's ORG fallbacks ({@link
   * listPlatformQueue}); use this in the decide-rights check so the two never
   * drift (Key scopes table: "none → any platform staff").
   */
  orgHasOtherLiveApprover(input: {
    orgId: string;
    excludeHumanId: string;
  }): Promise<boolean>;

  /**
   * FR-011 cap counts. MUST be called inside `repos.tx()` (throws on the
   * root client): it first takes a
   * transaction-scoped advisory lock (the holder's, plus the org's for ORG)
   * so two concurrent requests cannot both read "4" and both
   * insert a fifth. Counts slots, not rows: a pending request (undecided,
   * unwithdrawn, under 14 days), an approved request still inside its 7-day
   * collect window, or a collected request with a live key (unrevoked,
   * unexpired). Expired keys and lapsed / withdrawn / denied requests do not
   * count. Legacy keys do not count (they have no subject).
   *
   * Also returns `holderRequestsLast24h` (every request the holder created
   * in the last 24 hours on the DB clock, any subject or state) for core's
   * per-holder request rate limit. Lock order: the holder's lock first (it
   * serializes that count across subjects), then the org's lock for ORG.
   * Every caller takes them in that order, so the two locks cannot deadlock.
   */
  lockAndCountForCap(
    input: CountForApiKeyCapInput,
  ): Promise<CountForApiKeyCapResult>;

  /**
   * Decide a request. CAS `WHERE decided_at IS NULL AND withdrawn_at IS
   * NULL` (and, for APPROVED, created within 14 days, FR-004), so 0 rows is
   * an outcome, not an exception. The api_key_requests_guard trigger stamps
   * decided_at, requires a decider and makes the decision final; CHECKs
   * api_key_requests_self_approved_is_self / _self_approved_shape /
   * _denial_reason_shape refuse an inconsistent `selfApproved` or reason
   * (thrown as {@link ApiKeyRepoError}).
   */
  decide(
    input: DecideApiKeyRequestRepoInput,
  ): Promise<DecideApiKeyRequestOutcome>;

  /**
   * Withdraw a pending request (FR-004), recording withdrawalReason
   * REQUESTER. CAS `WHERE requester_human_id = $ AND decided_at IS NULL AND
   * withdrawn_at IS NULL`; the guard stamps withdrawn_at and makes it and
   * the reason final; CHECK api_key_requests_withdrawn_shape allows
   * REQUESTER only on an undecided request.
   */
  withdraw(input: {
    requestId: string;
    requesterHumanId: string;
  }): Promise<WithdrawApiKeyRequestOutcome>;

  /**
   * Mint the key for an approved request (FR-005): INSERT only. Locks the
   * request row (holder must be its requester, else `not_found`), then
   * inserts a key with the request's subject/access/org/label, expires_at =
   * DB clock (UTC) + expiry_days (NULL = never) and the request's auto-renew.
   * api_keys_guard stamps created_at and collected_at and refuses: not
   * APPROVED / withdrawn (`request_not_approved`), already collected or past
   * the 7-day window (`already_collected_or_collect_lapsed`); the partial
   * unique api_keys_one_collect_per_request backs "once" (`unique_violation`).
   * Refusals throw {@link ApiKeyRepoError}. Returns `holder_inactive` (no
   * key) when the holder's Human.status is not ACTIVE. The plaintext is
   * returned once.
   */
  collect(input: CollectApiKeyRepoInput): Promise<CollectApiKeyOutcome>;

  /**
   * Self-renewal (FR-009): INSERT only, with renewed_from_key_id. Copies
   * request, subject, access, org, label and holder from the parent (the
   * scope_shape / org_shape CHECKs and the composite scope FKs need them
   * together); expires_at = DB clock + the request's expiry_days. Locks the
   * request row first; api_keys_guard then locks the parent, cuts its
   * expiry to now + 24h and refuses: request or parent without auto-renew
   * (`auto_renew_not_allowed` / `renewal_not_allowed`), parent revoked,
   * expired, never-expiring or outside its last 7 days
   * (`renewal_not_allowed`), another live key on the request
   * (`renewal_overlap`). Refusals throw {@link ApiKeyRepoError}. `not_found`
   * when the parent or its request is gone; never `renewed` without a key.
   */
  renew(input: RenewApiKeyRepoInput): Promise<RenewApiKeyOutcome>;

  getKey(input: { keyId: string }): Promise<ApiKeyListItem | null>;

  /**
   * Revoke a key's whole approval (FR-010): every unrevoked key on its
   * request, i.e. both live keys during a renewal overlap, in one
   * transaction (request row FOR UPDATE first, then the keys). A legacy key
   * (no request) is revoked alone. `revokedKeyIds` lists only keys that were
   * live when revoked; already-expired siblings come back in
   * `alsoClosedExpiredKeyIds`. CAS `WHERE revoked_at IS NULL`;
   * api_keys_guard stamps revoked_at and makes revoke final. Opens its own
   * transaction when given the root client.
   */
  revokeKey(
    input: RevokeScopedApiKeyRepoInput,
  ): Promise<RevokeScopedApiKeyOutcome>;

  /**
   * The holder's switch on one live key (FR-009). Switching ON needs the
   * request's auto-renew on (api_keys_guard backs it; returned as
   * `request_disallows`, not thrown). Request row locked first.
   */
  setKeyAutoRenew(
    input: SetApiKeyAutoRenewRepoInput,
  ): Promise<SetApiKeyAutoRenewOutcome>;

  /**
   * The approver's switch-off (spec db_guards: "the approver's switch-off is
   * written to the request"): writes the request FIRST (api_key_requests_guard
   * makes it final: auto-renew only switches off), then every unrevoked key
   * on the request.
   */
  switchOffRequestAutoRenew(input: {
    requestId: string;
  }): Promise<SwitchOffRequestAutoRenewOutcome>;

  // ── Screen reads (never the hash) ────────────────────────────────────────

  /** Every key the human holds, scoped and legacy, newest first. */
  listKeysByHolder(input: {
    humanId: string;
    limit: number;
  }): Promise<ApiKeyListItem[]>;

  /** Every key on the org (all holders), newest first. */
  listKeysByOrg(input: {
    orgId: string;
    limit: number;
  }): Promise<ApiKeyListItem[]>;

  /** Every key on the platform, newest first (platform page). */
  listAllKeys(input: ListAllApiKeysInput): Promise<ListAllApiKeysResult>;

  // ── Notice markers for the lifecycle sweep (FR-012, step 6) ──────────────

  /**
   * Requests whose lapse notice is due and unsent (`lapse_notified_at IS
   * NULL`): pending past 14 days, or APPROVED and uncollected past 7 days.
   */
  listRequestsDueLapseNotice(input: {
    limit: number;
  }): Promise<ApiKeyRequestLapseDue[]>;

  /**
   * CAS `WHERE lapse_notified_at IS NULL AND withdrawn_at IS NULL`; true
   * when this call marked it. A request withdrawn or closed for account
   * security (R31) between the list and the mark is not marked, so no lapse
   * notice goes out for it.
   */
  markRequestLapseNotified(input: { requestId: string }): Promise<boolean>;

  /**
   * Live scoped keys expiring within 7 days with no expiry notice sent
   * (`expiry_notified_at IS NULL`), whose effective auto-renew is off (key
   * AND request) and that have not already been renewed.
   */
  listKeysDueExpiryNotice(input: {
    limit: number;
  }): Promise<ScopedApiKeyRecord[]>;

  /** CAS `WHERE expiry_notified_at IS NULL`; true when this call marked it. */
  markKeyExpiryNotified(input: { keyId: string }): Promise<boolean>;
}

export type {
  ApiKeyListItem,
  ApiKeyLookupInput,
  ApiKeyLookupResult,
  ApiKeyLookupWithScopeResult,
  ApiKeyRecord,
  ApiKeyRequestLapseDue,
  ApiKeyRequestRecord,
  ApiKeyAccess,
  ApiKeySubject,
  ApiKeyRequestDecision,
  ApiKeyRequestWithdrawal,
  CollectApiKeyOutcome,
  CollectApiKeyRepoInput,
  CountActiveApiKeysInput,
  CountForApiKeyCapInput,
  CountForApiKeyCapResult,
  CreateApiKeyRepoInput,
  CreateApiKeyRepoResult,
  CreateApiKeyRequestRepoInput,
  DecideApiKeyRequestOutcome,
  DecideApiKeyRequestRepoInput,
  GetApiKeyByIdInput,
  ListAllApiKeysInput,
  ListAllApiKeysResult,
  ListApiKeysByHumanInput,
  ListApiKeysByHumanResult,
  ListPlatformApiKeyQueueInput,
  MintedApiKey,
  RenewApiKeyOutcome,
  RenewApiKeyRepoInput,
  ResolvedApiKeyScope,
  RevokeAllApiKeysForHumanInput,
  RevokeAllApiKeysForHumanResult,
  RevokeApiKeyRepoInput,
  RevokeScopedApiKeyOutcome,
  RevokeScopedApiKeyRepoInput,
  ScopedApiKeyRecord,
  SetApiKeyAutoRenewOutcome,
  SetApiKeyAutoRenewRepoInput,
  SwitchOffRequestAutoRenewOutcome,
  WithdrawApiKeyRequestOutcome,
} from "@th/types";
