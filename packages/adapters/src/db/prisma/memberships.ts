import type { Membership, Prisma } from "@prisma/client";
import type {
  CreateMembershipInput,
  MembershipHealthCounts,
  MembershipHealthCountsQuery,
  MembershipHealthPosition,
  MembershipHealthPositionsQuery,
  MembershipHealthPositionsResult,
  MembershipRecord,
  MembershipsRepo,
  MembershipTierStatusCount,
  ResumeMembershipFromStripeInput,
} from "@th/ports/repos/memberships";

import { withStatementBudget } from "./statement-budget";
import type { PrismaClientOrTx } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Health / visibility reads (`memberships.report-health`,
// /platform/memberships). Everything below is READ-ONLY and joins nothing the
// write paths above touch.
// ─────────────────────────────────────────────────────────────────────────────

const HEALTH_DEFAULT_LIMIT = 25;
const HEALTH_MAX_LIMIT = 200;

/**
 * The three health predicates, written ONCE and shared by every caller.
 *
 * Shared on purpose: a count that disagrees with the list it sits above is the
 * defect this page would most easily ship — the badge says 12, the table shows
 * 9, and nothing on screen explains which is wrong. The job's three separate
 * counts and the page's two lists all compose from these.
 */
type HealthPredicateInput = {
  paymentFailingStatuses: string[];
  liveStatuses: string[];
  incompleteBefore: Date;
  leavingFrom: Date;
  leavingBefore: Date;
};

/** The card is failing NOW. Benefits are already denied for these members. */
const paymentFailingWhere = (
  q: HealthPredicateInput,
): Prisma.MembershipWhereInput => ({
  status: { in: q.paymentFailingStatuses },
});

/**
 * Signup started and never finished. `incomplete` is Stripe's own term for
 * "the first payment has not succeeded"; an `incomplete_expired` row is Stripe
 * having given up, and is deliberately NOT included because there is nothing
 * left to chase.
 */
const stuckIncompleteWhere = (
  q: HealthPredicateInput,
): Prisma.MembershipWhereInput => ({
  status: "incomplete",
  createdAt: { lte: q.incompleteBefore },
});

/**
 * Scheduled to end, inside the warning window.
 *
 * LIVE statuses only: a row already `canceled` has left, and listing it under
 * "the last window to intervene" would send someone to have a conversation
 * that is over. The `gte: leavingFrom` bound is the same idea — a period end
 * already in the past is not intervenable.
 */
const leavingWhere = (
  q: HealthPredicateInput,
): Prisma.MembershipWhereInput => ({
  cancelAtPeriodEnd: true,
  status: { in: q.liveStatuses },
  currentPeriodEnd: { gte: q.leavingFrom, lte: q.leavingBefore },
});

function healthWhere(
  bucket: "attention" | "leaving",
  q: HealthPredicateInput,
): Prisma.MembershipWhereInput {
  return bucket === "attention"
    ? { OR: [paymentFailingWhere(q), stuckIncompleteWhere(q)] }
    : leavingWhere(q);
}

/**
 * Cursor over (bucket, sort key, id).
 *
 * The id tie-break is load-bearing: two rows written in the same millisecond
 * would otherwise page in an order Postgres is free to change between queries,
 * which silently drops or duplicates rows across a page boundary.
 *
 * The BUCKET is load-bearing for a different reason. `at` does not mean the
 * same thing in the two buckets — it is `updatedAt` for `attention` and
 * `currentPeriodEnd` for `leaving` — so a cursor minted by one and replayed
 * against the other compares two unrelated timestamps and returns a page that
 * is wrong rather than empty. Nothing in the UI does this today (each section
 * voids its chain on refetch and never shares one), but a wrong page is the
 * worst failure mode a cursor has: it looks like data.
 */
type HealthCursor = {
  bucket: "attention" | "leaving";
  at: string;
  id: string;
};

function encodeHealthCursor(c: HealthCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/**
 * A malformed, hand-edited, or WRONG-BUCKET cursor decodes to null, which
 * restarts from the top. Deliberately not an error: the worst outcome of a bad
 * cursor on a read-only staff table is seeing page one twice, and that is
 * strictly better than answering with a page assembled from the wrong column.
 */
function decodeHealthCursor(
  raw: string | null | undefined,
  bucket: "attention" | "leaving",
): HealthCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as HealthCursor).at === "string" &&
      typeof (parsed as HealthCursor).id === "string" &&
      // A cursor with no bucket predates this field, and a cursor for the
      // OTHER bucket is measuring a different column. Both restart.
      (parsed as HealthCursor).bucket === bucket
    ) {
      const at = new Date((parsed as HealthCursor).at);
      if (Number.isNaN(at.getTime())) return null;
      return {
        bucket,
        at: (parsed as HealthCursor).at,
        id: (parsed as HealthCursor).id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

const healthPositionInclude = {
  memberHuman: { select: { id: true, name: true } },
  tier: {
    select: {
      id: true,
      name: true,
      priceCents: true,
      currency: true,
      interval: true,
      ownerOrgId: true,
      ownerHumanId: true,
      ownerOrg: { select: { id: true, name: true, slug: true } },
      ownerHuman: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.MembershipInclude;

type HealthPositionRow = Prisma.MembershipGetPayload<{
  include: typeof healthPositionInclude;
}>;

function mapHealthPosition(row: HealthPositionRow): MembershipHealthPosition {
  return {
    id: row.id,
    status: row.status,
    memberHumanId: row.memberHumanId,
    memberName: row.memberHuman?.name ?? null,
    tierId: row.tierId,
    tierName: row.tier.name,
    tierPriceCents: row.tier.priceCents,
    tierCurrency: row.tier.currency,
    tierInterval: row.tier.interval,
    ownerOrgId: row.tier.ownerOrgId ?? null,
    ownerOrgName: row.tier.ownerOrg?.name ?? null,
    ownerOrgSlug: row.tier.ownerOrg?.slug ?? null,
    ownerHumanId: row.tier.ownerHumanId ?? null,
    ownerHumanName: row.tier.ownerHuman?.name ?? null,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMembership(row: Membership): MembershipRecord {
  return {
    id: row.id,
    tierId: row.tierId,
    memberHumanId: row.memberHumanId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeCustomerId: row.stripeCustomerId,
    status: row.status,
    taxJurisdictionId: row.taxJurisdictionId ?? null,
    billingPostalCode: row.billingPostalCode ?? null,
    billingCountryCode: row.billingCountryCode ?? null,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    canceledAt: row.canceledAt ?? null,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeMembershipsRepo(p: PrismaClientOrTx): MembershipsRepo {
  return {
    findForMemberAndTier: async (input) => {
      const row = await p.membership.findUnique({
        where: {
          tierId_memberHumanId: {
            tierId: input.tierId,
            memberHumanId: input.memberHumanId,
          },
        },
      });
      return row ? mapMembership(row) : null;
    },

    findById: async (id: string) => {
      const row = await p.membership.findUnique({ where: { id } });
      return row ? mapMembership(row) : null;
    },

    findByStripeSubscriptionId: async (stripeSubscriptionId: string) => {
      const row = await p.membership.findUnique({
        where: { stripeSubscriptionId },
      });
      return row ? mapMembership(row) : null;
    },

    create: async (input: CreateMembershipInput) => {
      const row = await p.membership.create({
        data: {
          tierId: input.tierId,
          memberHumanId: input.memberHumanId,
          stripeSubscriptionId: input.stripeSubscriptionId,
          stripeCustomerId: input.stripeCustomerId,
          status: input.status,
          taxJurisdictionId: input.taxJurisdictionId ?? null,
          billingPostalCode: input.billingPostalCode ?? null,
          billingCountryCode: input.billingCountryCode ?? null,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
        },
      });
      return mapMembership(row);
    },

    updateFromStripe: async (input) => {
      const row = await p.membership.update({
        where: { id: input.id },
        data: {
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.currentPeriodStart === undefined
            ? {}
            : { currentPeriodStart: input.currentPeriodStart }),
          ...(input.currentPeriodEnd === undefined
            ? {}
            : { currentPeriodEnd: input.currentPeriodEnd }),
          ...(input.cancelAtPeriodEnd === undefined
            ? {}
            : { cancelAtPeriodEnd: input.cancelAtPeriodEnd }),
          ...(input.canceledAt === undefined
            ? {}
            : { canceledAt: input.canceledAt }),
        },
      });
      return mapMembership(row);
    },

    resumeFromStripe: async (input: ResumeMembershipFromStripeInput) => {
      // Full re-point, no partial-update spreading: every field is required
      // (see ResumeMembershipFromStripeInput) so a resume can never leave the
      // row referencing the dead subscription's billing/tax state.
      const row = await p.membership.update({
        where: { id: input.id },
        data: {
          stripeSubscriptionId: input.stripeSubscriptionId,
          stripeCustomerId: input.stripeCustomerId,
          status: input.status,
          taxJurisdictionId: input.taxJurisdictionId,
          billingPostalCode: input.billingPostalCode,
          billingCountryCode: input.billingCountryCode,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd,
          // The row is live again. `startedAt` is deliberately untouched —
          // it records the member's original join, not the resume.
          canceledAt: null,
        },
      });
      return mapMembership(row);
    },

    listByStripeCustomerId: async (stripeCustomerId: string) => {
      const rows = await p.membership.findMany({
        where: { stripeCustomerId },
      });
      return rows.map(mapMembership);
    },

    listByTaxJurisdictionId: async (input) => {
      const rows = await p.membership.findMany({
        where: {
          taxJurisdictionId: input.taxJurisdictionId,
          ...(input.statuses ? { status: { in: input.statuses } } : {}),
        },
      });
      return rows.map(mapMembership);
    },

    updateBillingAddress: async (input) => {
      // Tax linkage ONLY — see the port note. The subscription/customer ids
      // and lifecycle fields are deliberately not writable from this path.
      const row = await p.membership.update({
        where: { id: input.id },
        data: {
          taxJurisdictionId: input.taxJurisdictionId,
          billingPostalCode: input.billingPostalCode,
          billingCountryCode: input.billingCountryCode,
        },
      });
      return mapMembership(row);
    },

    listForMember: async (input) => {
      const rows = await p.membership.findMany({
        where: {
          memberHumanId: input.memberHumanId,
          ...(input.statuses ? { status: { in: input.statuses } } : {}),
        },
      });
      return rows.map(mapMembership);
    },

    countByTier: async (input) => {
      if (input.tierIds.length === 0) return [];
      const grouped = await p.membership.groupBy({
        by: ["tierId"],
        where: {
          tierId: { in: input.tierIds },
          ...(input.statuses ? { status: { in: input.statuses } } : {}),
        },
        _count: { _all: true },
      });
      return grouped.map((row) => ({
        tierId: row.tierId,
        count: row._count._all,
      }));
    },

    countHealth: async (
      query: MembershipHealthCountsQuery,
    ): Promise<MembershipHealthCounts> => {
      // Three counts, issued concurrently and deliberately NOT in one snapshot.
      //
      // THE BUCKETS OVERLAP, ON PURPOSE. An earlier version of this comment
      // claimed they share no row, and that was simply false: `leavingWhere`
      // admits every LIVE status, and `MEMBERSHIP_LIVE_STATUSES` includes
      // `past_due` and `unpaid`. A member whose card is failing AND who has
      // set `cancelAtPeriodEnd` with a near period end is counted in BOTH
      // `paymentFailing` and `leavingSoon`, and shows in both tables. That is
      // correct — they are two facts about one person and each calls for a
      // different action — and narrowing `leaving` to exclude them would hide
      // the most urgent retention case there is.
      //
      // THEREFORE: NEVER SUM OR COMPARE THESE THREE. `paymentFailing +
      // stuckIncomplete + leavingSoon` is not "memberships with a problem" and
      // would double-count. Nothing does this today — the health job feeds
      // each count to its own signal and the page renders each bucket in its
      // own table — and nothing should start.
      //
      // The real reason one snapshot is unnecessary is that no invariant spans
      // the three: they are never summed, never differenced, and never checked
      // against each other, so a few milliseconds of skew between them cannot
      // produce a combination that is wrong about anything. Opening a
      // transaction to make three cheap indexed counts atomic would buy that
      // nothing and cost a connection on every run of a daily job.
      const [paymentFailing, stuckIncomplete, leavingSoon] = await Promise.all([
        p.membership.count({ where: paymentFailingWhere(query) }),
        p.membership.count({ where: stuckIncompleteWhere(query) }),
        p.membership.count({ where: leavingWhere(query) }),
      ]);
      return { paymentFailing, stuckIncomplete, leavingSoon };
    },

    listHealthPositions: async (
      query: MembershipHealthPositionsQuery,
    ): Promise<MembershipHealthPositionsResult> => {
      const limit = Math.min(
        Math.max(query.limit ?? HEALTH_DEFAULT_LIMIT, 1),
        HEALTH_MAX_LIMIT,
      );
      const cursor = decodeHealthCursor(query.cursor, query.bucket);
      const where = healthWhere(query.bucket, query);

      // ATTENTION sorts by `updatedAt` ASC — longest-stuck first, which is the
      // order someone working the list wants. For a never-touched `incomplete`
      // row Prisma's `@updatedAt` equals `createdAt`, so "oldest abandoned
      // signup" and "longest-failing card" interleave correctly on one axis.
      //
      // LEAVING sorts by `currentPeriodEnd` ASC — soonest to go first, because
      // the whole point of the section is a deadline.
      const sortField =
        query.bucket === "attention"
          ? ("updatedAt" as const)
          : ("currentPeriodEnd" as const);

      // Keyset pagination, not `skip`: rows shift under an offset while a
      // human reads, and a shifted offset drops rows silently.
      const cursorWhere: Prisma.MembershipWhereInput | null = cursor
        ? {
            OR: [
              { [sortField]: { gt: new Date(cursor.at) } },
              {
                [sortField]: new Date(cursor.at),
                id: { gt: cursor.id },
              },
            ],
          }
        : null;

      const pagedWhere: Prisma.MembershipWhereInput = cursorWhere
        ? { AND: [where, cursorWhere] }
        : where;

      const { rows, total } = await withStatementBudget(
        p,
        query.statementTimeoutMs,
        "memberships_health_positions",
        async (client) => {
          const [rows, total] = await Promise.all([
            client.membership.findMany({
              where: pagedWhere,
              include: healthPositionInclude,
              orderBy: [{ [sortField]: "asc" }, { id: "asc" }],
              // One extra row is the has-next probe. A separate count for
              // "is there more" would be a second query that can disagree
              // with the page it describes.
              take: limit + 1,
            }),
            // `total` counts the WHOLE bucket, not the page and not the
            // remainder after the cursor: it is the badge beside the section
            // heading, and a badge that shrank as you paged would read as
            // rows disappearing.
            client.membership.count({ where }),
          ]);
          return { rows, total };
        },
      );

      const hasNextPage = rows.length > limit;
      const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];

      return {
        items: pageRows.map(mapHealthPosition),
        nextCursor:
          hasNextPage && last
            ? encodeHealthCursor({
                bucket: query.bucket,
                at: last[sortField].toISOString(),
                id: last.id,
              })
            : null,
        total,
      };
    },

    countByTierAndStatus: async (input): Promise<MembershipTierStatusCount[]> => {
      if (input.statuses.length === 0) return [];
      const grouped = await withStatementBudget(
        p,
        input.statementTimeoutMs,
        "memberships_tier_status_counts",
        (client) =>
          client.membership.groupBy({
            by: ["tierId", "status"],
            where: { status: { in: input.statuses } },
            _count: { _all: true },
          }),
      );
      return grouped.map((row) => ({
        tierId: row.tierId,
        status: row.status,
        count: row._count._all,
      }));
    },
  };
}
