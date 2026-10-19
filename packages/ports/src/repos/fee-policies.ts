import type {
  FeePolicyRecord,
  FeePolicyScopeType,
  ResolveFeePolicyInput,
} from "@th/types";

export interface UpsertFeePolicyInput {
  scopeType: FeePolicyScopeType;
  scopeId: string | null;
  buyerFeePct: number;
  maxFeeCents: number | null;
  minFeeCents: number;
  maxPlatformFeeCents: number | null;
  platformFixedCents: number;
  feeMode: "ABSORB" | "PASS_THROUGH";
  processsorFeePct: number;
  processorFixedCents: number;
  payoutPct: number;
  payoutFixedCents: number;
  monthlyPayoutCents: number;
  payoutMinimumCents: number;
  /**
   * Stripe's monthly active-account fee to withhold from a membership-only
   * payout, in cents (200 = $2; 0 = recovery off).
   *
   * OPTIONAL, and omission means "leave it as it is" — `upsert` mints a NEW
   * policy version, so a caller that doesn't know about this knob (the platform
   * pricing form) must not be able to silently reset it to 0 while editing
   * something else. The adapter carries the existing value forward.
   */
  connectAccountFeeCents?: number;
  actorHumanId: string;
  notes?: string | null;
}

export interface FeePoliciesRepo {
  getById(id: string): Promise<FeePolicyRecord | null>;
  resolveEffective(
    input: ResolveFeePolicyInput,
  ): Promise<FeePolicyRecord | null>;
  /**
   * {@link FeePoliciesRepo.getById} for many ids in ONE query. Ids with no row
   * are absent from the map. Same no-status/no-time filter as `getById`: a
   * pinned policy is read as pinned.
   */
  getByIds(ids: readonly string[]): Promise<Map<string, FeePolicyRecord>>;
  /**
   * {@link FeePoliciesRepo.resolveEffective} for many scope ids of ONE scope
   * type, in ONE query: scopeId → the row `resolveEffective({ scopeType,
   * scopeId, at })` would return (same filter, same `effectiveFrom desc,
   * version desc` tie-break). Scope ids with no policy in force are absent.
   *
   * EVENT / ORG only — GLOBAL has a single (null) scope id, so its caller
   * reads it once through `resolveEffective`. Exists for listing pages, which
   * price N events at once and must not walk EVENT → ORG → GLOBAL per event.
   */
  resolveEffectiveForScopes(input: {
    scopeType: Exclude<FeePolicyScopeType, "GLOBAL">;
    scopeIds: readonly string[];
    at: Date;
  }): Promise<Map<string, FeePolicyRecord>>;
  /**
   * The ACTIVE policy for a scope with NO time filter — precisely the row
   * {@link FeePoliciesRepo.upsert} will archive.
   *
   * Distinct from `resolveEffective`, and the distinction is load-bearing for
   * the deploy-time reconciler. `resolveEffective` answers "what does a buyer
   * pay at instant T", so it filters on `effectiveFrom <= T`. A reconciler
   * needs "what row is in place", and using the time-filtered read for that is
   * a REAL bug, observed: two concurrent reconciles serialize correctly on
   * `lockScopeGuard`, but the second one's `T` was captured before it started
   * waiting, so the row the first one just committed (`effectiveFrom` = a few
   * ms LATER than T) failed the `<= T` filter while the previous row was
   * already ARCHIVED. The second reconcile saw NOTHING, concluded no policy
   * existed, and wrote a duplicate.
   *
   * Answering "what is in place" without a clock removes that whole class of
   * skew bug rather than narrowing its window. Also correct for a future-dated
   * policy, which `resolveEffective` hides but `upsert` would still archive.
   */
  getActiveForScope(input: {
    scopeType: FeePolicyScopeType;
    scopeId: string | null;
  }): Promise<FeePolicyRecord | null>;
  /**
   * Create or bump-version an ACTIVE policy for the given scope.
   *
   * ARCHIVE-THEN-CREATE, two statements. It MUST be called inside
   * `repos.tx(...)`: interrupted between the two, the scope is left with ZERO
   * ACTIVE policies, and for GLOBAL that means `publishEvent` throws
   * `FEE_POLICY_NOT_FOUND` and checkout cannot price a ticket.
   *
   * It also read-modify-writes `version`, so callers must serialize with
   * {@link FeePoliciesRepo.lockScopeGuard} first — see that method for why the
   * `@@unique([scopeType, scopeId, status, version])` index cannot do it.
   */
  upsert(input: UpsertFeePolicyInput): Promise<FeePolicyRecord>;
  /**
   * Acquire a Postgres transaction-scoped advisory lock serializing
   * resolve-then-`upsert` for one fee-policy scope.
   *
   * The unique index `@@unique([scopeType, scopeId, status, version])` CANNOT
   * dedupe this for GLOBAL policies: `scopeId` is NULL there, and Postgres
   * treats NULLs as distinct in a unique index, so two concurrent reconciles
   * both read version n, both compute n+1, and both INSERT an ACTIVE row.
   * `resolveEffective` then picks one by `effectiveFrom desc` and the next
   * write archives only one (`findFirst`), orphaning the other as a permanently
   * ACTIVE ghost.
   *
   * SINCE 20260812130000_fee_policy_one_active_per_scope there IS a DB backstop
   * — a PARTIAL unique index `("scopeType", COALESCE("scopeId", '')) WHERE
   * status = 'ACTIVE'`, whose `COALESCE` is exactly what defeats the NULL
   * problem above. It does NOT replace this lock: it turns the race into a
   * P2002 for the loser rather than serializing it, and nothing maps that
   * P2002 to a domain error. Take the lock; the index is there for the caller
   * who forgets.
   *
   * Keyed on the scope, so an ORG-scoped write never blocks a GLOBAL one.
   * Transaction-scoped (`pg_advisory_xact_lock`) — released on commit/rollback,
   * no matching unlock call. Must be called inside `repos.tx(...)`.
   */
  lockScopeGuard(input: {
    scopeType: FeePolicyScopeType;
    scopeId: string | null;
  }): Promise<void>;
}

export type {
  FeePolicyRecord,
  FeePolicyScopeType,
  ResolveFeePolicyInput,
} from "@th/types";
