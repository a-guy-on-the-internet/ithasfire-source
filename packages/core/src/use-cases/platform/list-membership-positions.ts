import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import { CURSOR_MAX_LIMIT } from "@th/ports/pagination";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  MEMBERSHIP_LIVE_STATUSES,
  MEMBERSHIP_PAYMENT_FAILING_STATUSES,
} from "../memberships/membership-status";

// ─────────────────────────────────────────────────────────────────────────────
// listMembershipPositions — the staff "which memberships are broken, and who
// is about to leave" read model, for /platform/memberships.
//
// TWO BUCKETS, ONE SHAPE. They share a row type because they are the same
// join (membership → tier → owner, plus the member) asked two questions:
//
//   * `attention` — `past_due` / `unpaid` (the card is failing and benefits
//     are ALREADY DENIED), plus `incomplete` rows past the grace window (the
//     signup never completed). Ordered longest-stuck first.
//   * `leaving`   — `cancelAtPeriodEnd` with the period ending inside the
//     window. Ordered soonest-to-go first, because it is a deadline.
//
// THE TWO BUCKETS OVERLAP, AND THAT IS CORRECT. `leaving` admits every LIVE
// status and `MEMBERSHIP_LIVE_STATUSES` includes `past_due` / `unpaid`, so a
// member whose card is failing AND who has set `cancelAtPeriodEnd` appears in
// BOTH tables. They are two facts about one person and each calls for a
// different action; narrowing `leaving` to exclude them would hide the most
// urgent retention case there is. The consequence for anyone counting: the
// bucket totals must never be summed — "attention + leaving" is not a count
// of troubled memberships, it double-counts exactly those people.
//
// THE THRESHOLDS ARE THE JOB'S OWN, imported rather than retyped
// (`reportMembershipHealth`'s defaults). A second set of literals here would
// let the page and the alert disagree about which rows are a problem, and a
// staff member reading "3 need attention" under a Discord post saying 5 has no
// way to tell which is lying.
//
// `sinceAt` IS APPROXIMATE AND SAYS SO. There is no per-status timestamp on
// `Membership`: nothing records when a row entered `past_due`. `updatedAt` is
// the closest available proxy and it moves on ANY write, so the row carries a
// `sinceBasis` naming what was measured rather than presenting a guess as a
// fact. For an `incomplete` row `createdAt` IS exact — the row is written at
// signup and an incomplete one has never had a successful invoice — so that
// bucket reports the honest number and labels it differently.
//
// Roles: ADMIN | SUPPORT — the same STAFF_ONLY read set as the settlements
// views, enforced HERE; the transport checks only that an actor exists.
// ─────────────────────────────────────────────────────────────────────────────

export const MEMBERSHIP_POSITIONS_READ_ROLES: HumanRole[] = [
  "ADMIN",
  "SUPPORT",
];

/**
 * Budget for the positions query. Past this the adapter surfaces
 * SERVICE_UNAVAILABLE (`memberships_health_positions_timeout`) and the UI
 * renders an inline "timed out — try again". Same 8s as the sibling views.
 */
export const MEMBERSHIP_POSITIONS_STATEMENT_TIMEOUT_MS = 8_000;

/**
 * Window defaults, SHARED WITH THE JOB.
 *
 * Re-declared here as plain constants rather than reaching into the job's Zod
 * schema defaults, and then pinned equal by a test: importing a schema's
 * internal default is fragile, but two silently-different numbers is worse, so
 * the drift guard lives in the test suite where a mismatch fails loudly.
 */
export const MEMBERSHIP_POSITIONS_INCOMPLETE_GRACE_HOURS = 24;
export const MEMBERSHIP_POSITIONS_LEAVING_WITHIN_DAYS = 14;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const membershipPositionBucketSchema = z.enum(["attention", "leaving"]);
export type MembershipPositionBucket = z.infer<
  typeof membershipPositionBucketSchema
>;

export const listMembershipPositionsInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    bucket: membershipPositionBucketSchema,
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(CURSOR_MAX_LIMIT).optional(),
  })
  .strict();

export type ListMembershipPositionsInput = z.infer<
  typeof listMembershipPositionsInputSchema
>;

export const membershipPositionSchema = z
  .object({
    id: z.string(),
    /** Stripe's status verbatim, never re-cased. */
    status: z.string(),
    memberHumanId: z.string(),
    /** Best-effort display name; null when the human row carries none. */
    memberName: z.string().nullable(),
    tierId: z.string(),
    tierName: z.string(),
    /** Integer cents, per `tierInterval`. */
    tierPriceCents: z.number().int().nonnegative(),
    tierCurrency: z.string(),
    tierInterval: z.enum(["MONTH", "YEAR"]),
    /** "ORG" or "HUMAN" — the tier's owner XOR, resolved. */
    ownerType: z.enum(["ORG", "HUMAN"]),
    ownerId: z.string(),
    ownerLabel: z.string().nullable(),
    /** Organisation slug for the `/admin/<slug>` link; null for humans. */
    ownerSlug: z.string().nullable(),
    currentPeriodStart: z.date(),
    currentPeriodEnd: z.date(),
    cancelAtPeriodEnd: z.boolean(),
    /** When the member first joined this tier. A resume does not reset it. */
    startedAt: z.date(),
    /**
     * The instant `sinceBasis` names. Read it together with that field — on
     * its own it is a date whose meaning is unstated.
     */
    sinceAt: z.date(),
    /**
     * WHAT `sinceAt` actually measures.
     *
     * `"signup"` — the row was created then, and for an `incomplete` row that
     * IS when it got stuck. Exact.
     *
     * `"lastChange"` — the last write to the row, which is usually but not
     * necessarily the status change. A tax-jurisdiction repoint moves it too.
     * Approximate, and the UI must render it as such ("about 9 days").
     */
    sinceBasis: z.enum(["signup", "lastChange"]),
  })
  .strict();

export type MembershipPosition = z.infer<typeof membershipPositionSchema>;

export const listMembershipPositionsOutputSchema = z
  .object({
    items: z.array(membershipPositionSchema),
    nextCursor: z.string().min(1).nullable(),
    /** Rows in the whole bucket — the badge count, not the page size. */
    total: z.number().int().nonnegative(),
    /** The clock these windows were evaluated against. */
    asOf: z.date(),
  })
  .strict();

export type ListMembershipPositionsOutput = z.infer<
  typeof listMembershipPositionsOutputSchema
>;

export type ListMembershipPositionsDeps = {
  repos: Pick<Repos, "memberships">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

async function requireStaff(
  deps: ListMembershipPositionsDeps,
  actorHumanId: string,
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: MEMBERSHIP_POSITIONS_READ_ROLES,
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}

export async function listMembershipPositions(
  deps: ListMembershipPositionsDeps,
  rawInput: unknown,
): Promise<ListMembershipPositionsOutput> {
  const input = parseInput(listMembershipPositionsInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  const asOf = deps.clock.now();

  const page = await deps.repos.memberships.listHealthPositions({
    bucket: input.bucket,
    paymentFailingStatuses: [...MEMBERSHIP_PAYMENT_FAILING_STATUSES],
    liveStatuses: [...MEMBERSHIP_LIVE_STATUSES],
    incompleteBefore: new Date(
      asOf.getTime() - MEMBERSHIP_POSITIONS_INCOMPLETE_GRACE_HOURS * HOUR_MS,
    ),
    leavingFrom: asOf,
    leavingBefore: new Date(
      asOf.getTime() + MEMBERSHIP_POSITIONS_LEAVING_WITHIN_DAYS * DAY_MS,
    ),
    cursor: input.cursor ?? null,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    statementTimeoutMs: MEMBERSHIP_POSITIONS_STATEMENT_TIMEOUT_MS,
  });

  const items: MembershipPosition[] = page.items.map((row) => {
    // The owner XOR, resolved once. A tier with neither owner set is a data
    // integrity violation the schema cannot express, so it falls back to the
    // tier id rather than rendering a row with no owner at all — the row is
    // still actionable and the anomaly is visible.
    const ownerIsOrg = row.ownerOrgId !== null;
    const ownerId = row.ownerOrgId ?? row.ownerHumanId ?? row.tierId;
    const ownerLabel = ownerIsOrg ? row.ownerOrgName : row.ownerHumanName;

    // `incomplete` is the one status whose start instant we genuinely know:
    // the row is written at signup and has never had a successful invoice, so
    // `createdAt` IS when it got stuck. Everything else has to make do with
    // the last write, and says so.
    const stuckIncomplete = row.status === "incomplete";

    return {
      id: row.id,
      status: row.status,
      memberHumanId: row.memberHumanId,
      memberName: row.memberName,
      tierId: row.tierId,
      tierName: row.tierName,
      tierPriceCents: row.tierPriceCents,
      tierCurrency: row.tierCurrency,
      tierInterval: row.tierInterval,
      ownerType: ownerIsOrg ? ("ORG" as const) : ("HUMAN" as const),
      ownerId,
      ownerLabel: ownerLabel ?? null,
      ownerSlug: ownerIsOrg ? row.ownerOrgSlug : null,
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      startedAt: row.startedAt,
      sinceAt: stuckIncomplete ? row.createdAt : row.updatedAt,
      sinceBasis: stuckIncomplete
        ? ("signup" as const)
        : ("lastChange" as const),
    };
  });

  return {
    items,
    nextCursor: page.nextCursor,
    total: page.total,
    asOf,
  };
}
