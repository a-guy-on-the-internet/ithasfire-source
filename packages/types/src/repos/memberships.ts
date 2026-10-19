import type { MembershipInterval } from "./membership-tiers";

export interface MembershipRecord {
  id: string;
  tierId: string;
  memberHumanId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  /** Mirrors Stripe's subscription status vocabulary verbatim. */
  status: string;
  taxJurisdictionId: string | null;
  billingPostalCode: string | null;
  billingCountryCode: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMembershipInput {
  tierId: string;
  memberHumanId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  status: string;
  taxJurisdictionId?: string | null;
  billingPostalCode?: string | null;
  billingCountryCode?: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd?: boolean;
}

/**
 * The full re-point a RESUME writes — see `MembershipsRepo.resumeFromStripe`.
 *
 * Every field is REQUIRED on purpose: a resume replaces the row's dead
 * subscription with a freshly created one, and forgetting any of the Stripe /
 * tax linkage fields silently leaves the row pointing at stale billing state
 * (the exact bug this method exists to prevent).
 */
export interface ResumeMembershipFromStripeInput {
  id: string;
  /** The NEW subscription minted for the returning member. */
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  status: string;
  /** Freshly re-resolved at resume time — the member may have moved. */
  taxJurisdictionId: string | null;
  billingPostalCode: string | null;
  billingCountryCode: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** Always null on a resume — the row is live again, not canceled. */
  canceledAt: null;
}

export interface MembershipsRepo {
  /**
   * A member's membership to one tier, in ANY state.
   *
   * Includes canceled rows deliberately: the (tierId, memberHumanId) unique
   * index means a returning member re-subscribes to the same row rather than
   * creating a second one, so callers must see the lapsed row to resume it.
   */
  findForMemberAndTier(input: {
    tierId: string;
    memberHumanId: string;
  }): Promise<MembershipRecord | null>;

  findById(id: string): Promise<MembershipRecord | null>;

  findByStripeSubscriptionId(
    stripeSubscriptionId: string,
  ): Promise<MembershipRecord | null>;

  create(input: CreateMembershipInput): Promise<MembershipRecord>;

  /**
   * Sync lifecycle state from Stripe. Omitted fields are left untouched.
   *
   * Deliberately CANNOT carry `stripeSubscriptionId` / `stripeCustomerId` /
   * tax-address fields: webhook sync must never be able to re-point a row at
   * a different subscription. Re-pointing is `resumeFromStripe`'s job only.
   */
  updateFromStripe(input: {
    id: string;
    status?: string;
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: Date | null;
  }): Promise<MembershipRecord>;

  /**
   * Re-point a lapsed row at a freshly created subscription (the
   * `startMembership` resume branch). The `(tierId, memberHumanId)` unique
   * index means a returning member reuses their row, so the row must be
   * re-pointed at the NEW subscription — leaving the old `stripeSubscriptionId`
   * in place makes every future `invoice.payment_succeeded` lookup for the new
   * subscription miss (DLQ forever: the member is billed, the owner unpaid).
   * The unique index on `stripeSubscriptionId` makes the re-point safe.
   *
   * `startedAt` is deliberately NOT touched: it records when the member first
   * joined this tier; a resume continues that history rather than restarting
   * it (webhook-side period fields carry the new billing anchor).
   */
  resumeFromStripe(
    input: ResumeMembershipFromStripeInput,
  ): Promise<MembershipRecord>;

  /**
   * ALL memberships behind one Stripe Customer, any status.
   *
   * A member supporting three owners has one platform-owned Customer and
   * three rows — a `customer.updated` (billing-address change) must reach
   * every one of them, so this deliberately has no status filter; the caller
   * decides which states a change can still act on. Empty means "not a
   * customer we track" — the webhook's not-ours guard.
   */
  listByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<MembershipRecord[]>;

  /**
   * Memberships pointing at ONE tax jurisdiction row. With `statuses`, only
   * rows in those states.
   *
   * Exists for the refresh job's subscription migration: when a jurisdiction's
   * rate changes, every LIVE subscription referencing the archived row must
   * have its Stripe `default_tax_rates` repointed at the replacement — and the
   * job must read this set BEFORE `migrateMemberships` repoints the DB rows,
   * or the set is empty by construction.
   */
  listByTaxJurisdictionId(input: {
    taxJurisdictionId: string;
    statuses?: string[];
  }): Promise<MembershipRecord[]>;

  /**
   * Re-point a row's TAX linkage after a billing-address change — and nothing
   * else. Deliberately as narrow as `updateFromStripe` is for lifecycle state:
   * the address path must never be able to re-point a row at a different
   * subscription or customer (that is `resumeFromStripe`'s job only), and the
   * lifecycle fields belong to the subscription webhooks.
   *
   * Callers must update the LIVE Stripe subscription's `default_tax_rates`
   * BEFORE writing this row: written the other way round, a Stripe failure
   * leaves the row claiming the new jurisdiction while the subscription keeps
   * billing the old rate — and the replay would then skip the row as
   * "unchanged" forever.
   */
  updateBillingAddress(input: {
    id: string;
    taxJurisdictionId: string;
    billingPostalCode: string;
    billingCountryCode: string;
  }): Promise<MembershipRecord>;

  /**
   * Memberships for a member. With `statuses`, only those states — checkout
   * benefit resolution passes the statuses it trusts (a PAST_DUE membership
   * must NOT grant benefits). Without `statuses`, ALL rows, for the member's
   * own account view (lapsed and canceled memberships included).
   */
  listForMember(input: {
    memberHumanId: string;
    statuses?: string[];
  }): Promise<MembershipRecord[]>;

  /**
   * Grouped membership counts per tier. With `statuses`, only rows in those
   * states count (e.g. live members); without, ALL rows ever — which is the
   * price-immutability question ("has this tier ever had a subscriber?").
   * Tiers with zero rows are omitted from the result.
   */
  countByTier(input: {
    tierIds: string[];
    statuses?: string[];
  }): Promise<Array<{ tierId: string; count: number }>>;

  /**
   * The three health counts behind `memberships.report-health`. ONE read, so
   * the job cannot page about a picture assembled from three different
   * instants.
   */
  countHealth(
    query: MembershipHealthCountsQuery,
  ): Promise<MembershipHealthCounts>;

  /**
   * The rows behind one health count, joined to member / tier / owner, newest
   * problem LAST (see the adapter for the ordering per bucket).
   *
   * Cursor-paged rather than truncated: unlike the payable feed there is no
   * batch that wants the whole set in one read, and a staff member triaging
   * failing cards works through them in order.
   */
  listHealthPositions(
    query: MembershipHealthPositionsQuery,
  ): Promise<MembershipHealthPositionsResult>;

  /**
   * Subscriber counts grouped by (tier, status), restricted to `statuses`.
   *
   * The recurring-revenue panel's only membership read. Bounded by the tier
   * count, not the member count — one row per tier per status — so it stays
   * small however many members exist.
   */
  countByTierAndStatus(input: {
    statuses: string[];
    statementTimeoutMs?: number;
  }): Promise<MembershipTierStatusCount[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform health + visibility reads (`memberships.report-health`,
// /platform/memberships). Separate from the member-facing reads above because
// they ask a different question: not "what does this member have" but "which
// subscriptions are quietly broken".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three ways a set of memberships goes wrong without anyone noticing.
 *
 * Counted separately rather than summed because they call for different
 * responses: a failing card is a member losing benefits they are still paying
 * for, an abandoned signup is a funnel leak, and a scheduled cancellation is a
 * retention conversation with a deadline.
 */
export interface MembershipHealthCounts {
  /**
   * `past_due` / `unpaid` — the card is failing and Stripe is retrying.
   * Benefits are ALREADY DENIED for these members
   * (`MEMBERSHIP_BENEFIT_GRANTING_STATUSES` excludes both), so the member is
   * losing what they pay for while the subscription still exists.
   */
  paymentFailing: number;
  /** `incomplete` past the grace window — the signup never completed. */
  stuckIncomplete: number;
  /** `cancelAtPeriodEnd` with the period ending inside the warning window. */
  leavingSoon: number;
}

export interface MembershipHealthCountsQuery {
  /** Statuses that mean "the card is failing" — from `membership-status.ts`. */
  paymentFailingStatuses: string[];
  /** Statuses that mean "this subscription still exists on Stripe". */
  liveStatuses: string[];
  /** `incomplete` rows created at/before this have had their chance. */
  incompleteBefore: Date;
  /**
   * Lower bound of the leaving window — normally `now`.
   *
   * A `cancelAtPeriodEnd` row whose period END has already passed is NOT
   * counted: there is no window left to intervene in, so reporting it as a
   * retention opportunity would be a lie. If such a row is still `active` past
   * its end that is a Stripe-sync question, not a churn one, and it belongs to
   * a different signal than this.
   */
  leavingFrom: Date;
  /** Upper bound — the end of the warning window. */
  leavingBefore: Date;
}

/** Which of the two "something is wrong" lists a positions read wants. */
export type MembershipHealthBucket =
  /** `past_due` / `unpaid` / stuck `incomplete` — benefits lost or never started. */
  | "attention"
  /** `cancelAtPeriodEnd` inside the window — the last chance to intervene. */
  | "leaving";

/**
 * One membership row as the staff visibility sections render it: who, which
 * tier, whose tier, how much, and since when.
 *
 * Names are joined in the adapter rather than fanned out per row in core: the
 * page shows at most a screenful, and an N+1 over `humans` / `organizations`
 * for every row is the thing this shape exists to avoid.
 */
export interface MembershipHealthPosition {
  id: string;
  /** Stripe's status verbatim — never re-cased. */
  status: string;
  memberHumanId: string;
  /** Best-effort display name. Null when the human row has none. */
  memberName: string | null;
  tierId: string;
  tierName: string;
  /** Integer cents, per `tierInterval`. */
  tierPriceCents: number;
  tierCurrency: string;
  tierInterval: MembershipInterval;
  /** Exactly one owner id is set — the tier's XOR, carried through. */
  ownerOrgId: string | null;
  ownerOrgName: string | null;
  /** For the `/admin/<slug>` link. Null for human-owned tiers. */
  ownerOrgSlug: string | null;
  ownerHumanId: string | null;
  ownerHumanName: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** When the member first joined this tier. A resume does NOT reset it. */
  startedAt: Date;
  createdAt: Date;
  /**
   * Last write to the row. The ONLY available proxy for "how long has it been
   * in this state" — there is no per-status timestamp — and it moves on any
   * write, so callers must present it as approximate. `createdAt` is the exact
   * answer for an `incomplete` row, which has never had a successful invoice.
   */
  updatedAt: Date;
}

export interface MembershipHealthPositionsQuery {
  bucket: MembershipHealthBucket;
  paymentFailingStatuses: string[];
  liveStatuses: string[];
  incompleteBefore: Date;
  leavingFrom: Date;
  leavingBefore: Date;
  cursor?: string | null;
  limit?: number;
  /**
   * Postgres budget for this read. Omit for headless callers; the interactive
   * staff page passes one so a slow read fails the panel instead of hanging
   * the page.
   */
  statementTimeoutMs?: number;
}

export interface MembershipHealthPositionsResult {
  items: MembershipHealthPosition[];
  nextCursor: string | null;
  /** Rows matching the bucket, whole set — not just this page. */
  total: number;
}

/**
 * Live subscriber counts, grouped by tier AND status.
 *
 * Grouped rather than collapsed because the recurring-revenue panel reports
 * `active` and `trialing` SEPARATELY: a trialing member is worth nothing yet
 * and folding them into one number would overstate revenue by exactly the
 * trial cohort.
 */
export interface MembershipTierStatusCount {
  tierId: string;
  status: string;
  count: number;
}
