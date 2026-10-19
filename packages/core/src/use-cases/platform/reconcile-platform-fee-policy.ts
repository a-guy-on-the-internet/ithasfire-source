import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";

import {
  PLATFORM_FEE_POLICY,
  PLATFORM_FEE_POLICY_FIELDS,
  type PlatformFeePolicy,
} from "../../lib/pricing/platform-fee-policy";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PlatformFeePolicyField =
  (typeof PLATFORM_FEE_POLICY_FIELDS)[number];

export type PlatformFeePolicyFieldDiff = {
  field: PlatformFeePolicyField;
  /** `undefined` when there is no effective GLOBAL policy at all. */
  current: unknown;
  next: unknown;
};

export type ReconcilePlatformFeePolicyResult =
  | {
      action: "noop";
      policy: FeePolicyRecord;
      diffs: [];
    }
  | {
      action: "written";
      policy: FeePolicyRecord;
      /** The policy that was archived, or null on a first install. */
      previous: FeePolicyRecord | null;
      diffs: PlatformFeePolicyFieldDiff[];
    };

export type ReconcilePlatformFeePolicyDeps = {
  /**
   * Only `tx` is used directly: the resolve, the advisory lock, the write and
   * the audit row all happen INSIDE one transaction (`TxRepos` carries
   * `feePolicies` and `audit`). Nothing is read on the base client, so there is
   * no read-outside/write-inside window.
   */
  repos: Pick<Repos, "tx">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type ReconcilePlatformFeePolicyOptions = {
  /**
   * Written to `FeePolicy.createdBy`. There is no human actor on a deploy-time
   * reconcile, so the caller supplies a labelled system sentinel.
   */
  actorHumanId: string;
  /** Provenance metadata. NOT compared — see {@link diffPlatformFeePolicy}. */
  notes: string;
  /**
   * Override the constant. Tests only — production callers must pass nothing so
   * the shipped constant is the only source of truth.
   */
  policy?: PlatformFeePolicy;
};

// ─────────────────────────────────────────────────────────────────────────────
// Comparison
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field-by-field comparison of the live GLOBAL policy against the code
 * constant. Returns one entry per differing field; an empty array means the
 * row is already a faithful materialization and nothing should be written.
 *
 * DECIMALS: `buyerFeePct`, `processsorFeePct` and `payoutPct` are Prisma
 * `Decimal(5, 4)`. `FeePolicyRecord` is a DTO — the adapter has already run
 * them through `decimalToNumber` (`Number(value)`) — so both sides here are
 * plain JS numbers and this is a NUMERIC comparison, never a string or
 * reference one. `Decimal(5, 4)` round-trips exactly through a double;
 * `platform-fee-policy.test.ts` guards the constant against a fifth decimal
 * place, which would be rounded on write and make this report a diff on every
 * deploy forever.
 *
 * `notes` is deliberately NOT compared: it is provenance metadata, not
 * economics, and comparing it would mint a policy version every time someone
 * reworded a log line.
 */
export function diffPlatformFeePolicy(
  current: FeePolicyRecord | null,
  next: PlatformFeePolicy = PLATFORM_FEE_POLICY,
): PlatformFeePolicyFieldDiff[] {
  if (!current) {
    return PLATFORM_FEE_POLICY_FIELDS.map((field) => ({
      field,
      current: undefined,
      next: next[field],
    }));
  }

  const diffs: PlatformFeePolicyFieldDiff[] = [];
  for (const field of PLATFORM_FEE_POLICY_FIELDS) {
    // `Object.is` rather than `===` only to avoid the `NaN !== NaN` trap on a
    // corrupt Decimal; nulls and the enum strings compare identically either
    // way.
    if (!Object.is(current[field], next[field])) {
      diffs.push({ field, current: current[field], next: next[field] });
    }
  }
  return diffs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconcile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make the GLOBAL `FeePolicy` row match `PLATFORM_FEE_POLICY`.
 *
 * The platform fee is defined in CODE
 * (`packages/core/src/lib/pricing/platform-fee-policy.ts`); the DB row is a
 * materialization that still has to exist because checkout snapshots it and
 * `PayoutTerms.feePolicyId` pins a version. This is the reconciler, invoked on
 * every deploy by `apps/api/src/scripts/reference-data/seed-platform-fee-policy.ts`.
 *
 * - Row matches the constant → `{ action: "noop" }`. NOTHING is written. This
 *   is the steady state and it matters: the reconciler runs on every deploy,
 *   and minting a version per deploy would make `PayoutTerms.feePolicyId` pins
 *   churn and bury a real fee change in noise.
 * - Row differs, or no effective row exists → `upsert`, which archives the
 *   previous ACTIVE row (status ARCHIVED + effectiveTo) and creates the next
 *   version. The diff is returned so the caller can log old vs new.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE TRANSACTION, TAKEN UNDER AN ADVISORY LOCK. Both are load-bearing:
 *
 *  1. ATOMICITY. `feePolicies.upsert` is archive-then-create, two statements.
 *     Interrupted between them there are ZERO ACTIVE GLOBAL policies, which is
 *     precisely the prod outage this whole mechanism exists to prevent
 *     (`publishEvent` → `FEE_POLICY_NOT_FOUND`). This runs UNATTENDED on every
 *     deploy, and `deploy-dev.yml` sets `concurrency.cancel-in-progress: true`,
 *     so "cancelled mid-run" is a routine event here, not a thought experiment.
 *     The transaction makes the archive and the create commit or vanish
 *     together.
 *
 *  2. SERIALIZATION. `upsert` read-modify-writes `version`, and the
 *     `@@unique([scopeType, scopeId, status, version])` index CANNOT catch a
 *     duplicate for GLOBAL because `scopeId IS NULL` and Postgres treats NULLs
 *     as distinct. Two overlapping reconciles (a re-dispatch, or dev + a manual
 *     remote run) would both insert an ACTIVE row; the next write archives only
 *     one (`findFirst`) and the other becomes a permanently ACTIVE ghost.
 *     `lockScopeGuard` is taken FIRST, before the resolve, so the compare and
 *     the write see the same state.
 *
 *     A DB backstop now exists too — the partial unique index
 *     `FeePolicy_one_active_per_scope_key` (migration
 *     20260812130000_fee_policy_one_active_per_scope) keys on
 *     `COALESCE("scopeId", '')`, which is what the `@@unique` above cannot do.
 *     It does not make the lock redundant: without the lock the loser of the
 *     race gets a P2002 and the deploy job fails, where with it the loser waits
 *     and correctly no-ops. The index is insurance against a FUTURE writer that
 *     forgets the lock, not a substitute for taking it here.
 *
 * The read happens inside the transaction too — resolving outside would
 * reintroduce the TOCTOU the lock is there to close.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * NO RBAC CHECK, deliberately: there is no actor. This is not reachable from a
 * transport — there is no `upsertGlobalFeePolicy` mutation and there must not
 * be one — and its only caller is a deploy-time script whose authorization IS
 * write access to the database.
 *
 * An audit row is written in the SAME transaction on the write path. A
 * platform-wide fee change had no audit trail at all before this; the row
 * records the actor sentinel, both version numbers and the field-level diff, so
 * "when did the fee change and to what" is answerable from
 * `/platform/audit-log` without diffing git.
 *
 * Note for the caller: buyer totals are FEE-INCLUSIVE in search documents, so
 * an `action: "written"` result means every published event's indexed price is
 * now stale and needs `reindexAllPublishedEvents`. This function does not do
 * that itself — it holds no search port, and a reindex must NOT sit inside the
 * transaction (it is a long corpus-wide walk, and a failed cache refresh must
 * not roll back a correct policy row).
 */
export async function reconcilePlatformFeePolicy(
  deps: ReconcilePlatformFeePolicyDeps,
  options: ReconcilePlatformFeePolicyOptions,
): Promise<ReconcilePlatformFeePolicyResult> {
  const logger = deps.logger?.child({ useCase: "reconcilePlatformFeePolicy" });
  const target = options.policy ?? PLATFORM_FEE_POLICY;

  return deps.repos.tx(async (tx) => {
    // FIRST, before the read: everything after this point is a
    // compare-then-write against a version number.
    await tx.feePolicies.lockScopeGuard({
      scopeType: target.scopeType,
      scopeId: target.scopeId,
    });

    // Clock read is INSIDE the transaction, after the lock, and is used only to
    // stamp the audit row — never to filter the read below.
    const at = deps.clock.now();

    // `getActiveForScope`, NOT `resolveEffective`. The reconciler needs "what
    // row is in place", not "what does a buyer pay at instant T". Using the
    // time-filtered read here defeated the advisory lock in a way that was only
    // visible at runtime: the waiting reconcile's `T` predated the row the
    // holder had just committed, so `effectiveFrom <= T` excluded it, the
    // previous row was already ARCHIVED, and the waiter concluded no policy
    // existed and wrote a DUPLICATE. Two ACTIVE GLOBAL rows, which the unique
    // index cannot catch (`scopeId IS NULL`).
    const current = await tx.feePolicies.getActiveForScope({
      scopeType: target.scopeType,
      scopeId: target.scopeId,
    });

    const diffs = diffPlatformFeePolicy(current, target);

    if (current && diffs.length === 0) {
      logger?.info("fee_policy_unchanged", {
        policyId: current.id,
        version: current.version,
      });
      return { action: "noop", policy: current, diffs: [] };
    }

    logger?.info("fee_policy_changing", {
      previousPolicyId: current?.id ?? null,
      previousVersion: current?.version ?? null,
      changedFields: diffs.map((diff) => diff.field),
    });

    const policy = await tx.feePolicies.upsert({
      ...target,
      actorHumanId: options.actorHumanId,
      notes: options.notes,
    });

    await tx.audit.log({
      entity: "FeePolicy",
      entityId: policy.id,
      action: "platform.feePolicy.reconciled",
      data: {
        actorHumanId: options.actorHumanId,
        scopeType: target.scopeType,
        scopeId: target.scopeId,
        previousPolicyId: current?.id ?? null,
        previousVersion: current?.version ?? null,
        version: policy.version,
        // Serialized so the row is readable in the viewer without a join.
        changes: diffs.map((diff) => ({
          field: diff.field,
          from: diff.current ?? null,
          to: diff.next,
        })),
      },
      at,
    });

    logger?.info("fee_policy_written", {
      policyId: policy.id,
      version: policy.version,
    });

    return { action: "written", policy, previous: current, diffs };
  });
}
