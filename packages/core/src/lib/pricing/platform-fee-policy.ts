import type { UpsertFeePolicyInput } from "@th/ports/repos/fee-policies";

/**
 * platform-fee-policy.ts — THE SOURCE OF TRUTH for the GLOBAL fee policy.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE CHANGING A NUMBER BELOW
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The platform fee is defined HERE, in code, not in an admin form. The
 * `FeePolicy` GLOBAL row in Postgres is a MATERIALIZATION of this constant,
 * not an independent source of truth. It still has to exist because:
 *
 *   - checkout snapshots the resolved policy onto the order
 *     (`feePolicySnapshot`), so a historical order can always be re-derived;
 *   - `PayoutTerms.feePolicyId` pins a specific policy VERSION, so an
 *     agreement signed under the old economics keeps the old economics.
 *
 * The row is reconciled on every deploy by
 * `apps/api/src/scripts/reference-data/seed-platform-fee-policy.ts` (wired into the
 * `migrate_db` job of both `.github/workflows/deploy-dev.yml` and
 * `deploy-prod.yml`). That script is a no-op when the live row already
 * matches this constant field-for-field, and mints a NEW policy version
 * (archiving the previous one) when it does not. There is deliberately NO
 * write path from the UI — `/platform/fees` is read-only.
 *
 * Changing a value here therefore ships a fee change on the next deploy.
 * Treat it like a migration.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FOUR-DECIMAL LIMIT ON THE PERCENTAGES
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `buyerFeePct`, `processsorFeePct` and `payoutPct` are stored as
 * `Decimal(5, 4)` (see `packages/db/prisma/finance.prisma`). A value with
 * more than four decimal places would be ROUNDED on write, the reconciler
 * would read back a different number than it wrote, and every single deploy
 * would mint a fresh policy version forever. `platform-fee-policy.test.ts`
 * guards this.
 */

/**
 * The GLOBAL fee policy, minus the two fields the writer owns rather than the
 * policy itself:
 *
 *   - `actorHumanId` — there is no human actor on a deploy-time reconcile; the
 *     script supplies a labelled system sentinel.
 *   - `notes` — free-text provenance metadata, not economics. Keeping it out of
 *     the constant means editing a note can never mint a policy version.
 *
 * `connectAccountFeeCents` is widened from optional to REQUIRED. On
 * `UpsertFeePolicyInput` it is optional and the adapter CARRIES THE EXISTING
 * VALUE FORWARD when omitted (see the comment at
 * `packages/adapters/src/db/prisma/fee-policies.ts`), specifically so the old
 * hand-edit form could not reset it to 0 while editing an unrelated knob. That
 * protection existed because a human editor did not know about the field. This
 * constant is not a partial edit — it is the whole policy, in code, reviewed as
 * a diff — so it OWNS the field and states it explicitly. The carry-forward
 * branch is untouched and still protects any other caller; it simply never
 * fires for the reconciler, which is the intended behaviour: what is written
 * here is exactly what lands in the row.
 */
export type PlatformFeePolicy = Omit<
  UpsertFeePolicyInput,
  "actorHumanId" | "notes" | "connectAccountFeeCents"
> & {
  connectAccountFeeCents: number;
};

/**
 * Scaled per-ticket buyer fee: 3.33% of face, capped at 50¢ per ticket.
 *
 * Per-ticket fee math lives in
 * `packages/core/src/lib/pricing/compute-ticket-price-for-agreement.ts`:
 *
 *   fee = max( min(round(face × buyerFeePct), maxFeeCents) + platformFixedCents,
 *              minFeeCents )
 *
 * which for these values gives:
 *
 *   $5.00  →  17¢     $10.00 →  33¢
 *   $15.00 →  50¢     $50.00 →  50¢   (cap binds from ~$14.87 face upward)
 *
 * This replaced a flat 50¢/ticket, which was regressive on cheap grassroots
 * tickets — the exact market this platform is for.
 */
export const PLATFORM_FEE_POLICY: PlatformFeePolicy = {
  scopeType: "GLOBAL",
  scopeId: null,

  // ── Buyer-facing platform fee ──────────────────────────────────────────
  /** 3.33% of face value, per ticket. */
  buyerFeePct: 0.0333,
  /** PER-TICKET cap, in cents. The 50¢ ceiling. */
  maxFeeCents: 50,
  /** No floor: a $1 ticket pays 3¢, not a minimum. */
  minFeeCents: 0,
  /**
   * ORDER-WIDE cap on total platform fees. Deliberately UNCAPPED — do not
   * confuse this with `maxFeeCents`, which is the per-ticket cap above. A
   * 10-ticket order pays up to 10 × 50¢, not 50¢.
   */
  maxPlatformFeeCents: null,
  /**
   * No fixed component. The old flat 50¢/ticket lived here; it is gone, and
   * the whole fee is now the capped percentage above.
   */
  platformFixedCents: 0,
  /**
   * The mode every new event gets. There is no per-event switch any more
   * (docs/decisions/fee-mode-switch-dropped.md): fees are itemised on top.
   * ABSORB is removed (docs/decisions/absorb-removed.md); pricing reads
   * `SALE_FEE_MODE`, not this field, so it is kept only for the row's record.
   */
  feeMode: "PASS_THROUGH",

  // ── Cost recovery (what the platform is charged, not what it charges) ──
  /** Stripe's percentage. Note the typo'd field name — it is real, and it is
   *  the column name in Postgres. */
  processsorFeePct: 0.029,
  /** Stripe's flat per-charge component, in cents. */
  processorFixedCents: 30,
  /** Stripe Connect payout percentage. */
  payoutPct: 0.0025,
  /** Stripe Connect flat payout component, in cents. */
  payoutFixedCents: 25,
  /** Monthly processor cost component threaded into ticket pricing, in cents. */
  monthlyPayoutCents: 200,
  /** Minimum accumulated balance before a payout transfer executes ($10). */
  payoutMinimumCents: 1000,
  /**
   * Stripe's monthly ACTIVE-connected-account fee recovery, in cents.
   * 0 = recovery OFF. See the field doc on `FeePolicy` in
   * `packages/db/prisma/finance.prisma` for why this is NOT
   * `monthlyPayoutCents`.
   */
  connectAccountFeeCents: 0,
};

/**
 * Every field of {@link PLATFORM_FEE_POLICY} that the reconciler compares
 * against the live row. Exported so the comparison and the constant cannot
 * drift apart: adding a field to the type without adding it here is a type
 * error.
 */
export const PLATFORM_FEE_POLICY_FIELDS = [
  "scopeType",
  "scopeId",
  "buyerFeePct",
  "maxFeeCents",
  "minFeeCents",
  "maxPlatformFeeCents",
  "platformFixedCents",
  "feeMode",
  "processsorFeePct",
  "processorFixedCents",
  "payoutPct",
  "payoutFixedCents",
  "monthlyPayoutCents",
  "payoutMinimumCents",
  "connectAccountFeeCents",
] as const satisfies readonly (keyof PlatformFeePolicy)[];

/**
 * Compile-time completeness check: if a field is added to `PlatformFeePolicy`
 * and NOT added to `PLATFORM_FEE_POLICY_FIELDS`, this alias resolves to
 * `never` and the assignment below fails to compile. Without it the reconciler
 * would silently stop noticing drift on the new field — a fee change that
 * never lands, which is the worst possible failure mode here.
 */
type MissingFeePolicyField = Exclude<
  keyof PlatformFeePolicy,
  (typeof PLATFORM_FEE_POLICY_FIELDS)[number]
>;
const _allFeePolicyFieldsCompared: MissingFeePolicyField extends never
  ? true
  : never = true;
void _allFeePolicyFieldsCompared;
