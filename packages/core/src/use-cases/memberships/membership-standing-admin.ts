import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MembershipStandingRecord } from "@th/ports/repos/membership-standings";

import { parseInput } from "../../lib/io";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
import { MEMBERSHIP_LIVE_STATUSES } from "./membership-status";

// ─────────────────────────────────────────────────────────────────────────────
// Platform-admin standing tools (spec 2026-08-05 recurring-memberships):
// "view dispute-fee exposure per account, set/clear a rolling reserve,
// suspend/unsuspend".
//
// All three are PLATFORM-ADMIN only, enforced HERE (mirrors fee-waivers.ts:
// the transport pre-checks nothing beyond authentication; the use case is the
// authority). Enforcement of `suspended` itself lives in `startMembership`,
// which refuses new signups with MEMBERSHIPS_SUSPENDED — this file is the only
// thing that can SET the flag.
//
// MANUAL-OVERRIDE MARKER (consumed by the reserve seasoning curve):
// ONLY `overrideMembershipStanding` — the reserve editor — stamps
// `overriddenBy = actorHumanId` + `overrideReason`. `overriddenBy != null` on
// a MembershipStanding row means a human pinned the RESERVE — automatic
// seasoning MUST NOT recompute `reserveBps`/`reserveReleaseDays` for such a
// row. There is no separate flag; this field is the flag (see
// `MembershipStandingRecord` in @th/types).
//
// Suspend/unsuspend deliberately do NOT touch the marker: a newly created
// standing row defaults `reserveBps = 0`, so stamping `overriddenBy` on a
// suspend would pin the suspended — highest-risk — payee's reserve at 0%
// forever (the seasoning curve treats a pinned row as manual-always-wins).
// The suspending actor is recorded in the audit row instead.
// ─────────────────────────────────────────────────────────────────────────────

const ownerTypeSchema = z.enum(["ORG", "HUMAN"]);
export type MembershipStandingOwnerType = z.infer<typeof ownerTypeSchema>;

export type MembershipStandingAdminDeps = {
  repos: Pick<
    Repos,
    | "membershipStandings"
    | "membershipTiers"
    | "disputes"
    | "humans"
    | "organizations"
    | "audit"
    | "tx"
  >;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Reports the best-effort owner-label lookup failure in the overview. */
  reportError?: ReporterPort;
};

async function requireStaff(
  deps: MembershipStandingAdminDeps,
  actorHumanId: string,
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: ["ADMIN"],
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}

/**
 * Reject a mutation against an owner that does not exist — otherwise a typo'd
 * id creates a standing row that governs nobody (same posture as
 * grantFeeWaiver's subject check).
 */
async function ensureOwnerExists(
  deps: MembershipStandingAdminDeps,
  ownerType: MembershipStandingOwnerType,
  ownerId: string,
): Promise<void> {
  const exists =
    ownerType === "ORG"
      ? Boolean(await deps.repos.organizations.getById(ownerId))
      : Boolean(await deps.repos.humans.getById(ownerId));
  if (!exists) {
    throw fail("NOT_FOUND", {
      message: `No ${ownerType.toLowerCase()} with id ${ownerId}`,
    });
  }
}

function ownerWhere(ownerType: MembershipStandingOwnerType, ownerId: string) {
  return ownerType === "ORG"
    ? { ownerOrgId: ownerId, ownerHumanId: null }
    : { ownerOrgId: null, ownerHumanId: ownerId };
}

export const membershipStandingOutputSchema = z
  .object({
    ownerType: ownerTypeSchema,
    ownerId: z.string(),
    suspended: z.boolean(),
    suspendedAt: z.date().nullable(),
    suspendedReason: z.string().nullable(),
    reserveBps: z.number().int(),
    reserveReleaseDays: z.number().int(),
    overriddenBy: z.string().nullable(),
    overrideReason: z.string().nullable(),
  })
  .strict();

export type MembershipStandingOutput = z.infer<
  typeof membershipStandingOutputSchema
>;

function toStandingOutput(row: MembershipStandingRecord): MembershipStandingOutput {
  return {
    ownerType: row.ownerOrgId ? "ORG" : "HUMAN",
    ownerId: row.ownerOrgId ?? row.ownerHumanId ?? "",
    suspended: row.suspended,
    suspendedAt: row.suspendedAt,
    suspendedReason: row.suspendedReason,
    reserveBps: row.reserveBps,
    reserveReleaseDays: row.reserveReleaseDays,
    overriddenBy: row.overriddenBy,
    overrideReason: row.overrideReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suspend / unsuspend
// ─────────────────────────────────────────────────────────────────────────────

export const suspendMembershipStandingInputSchema = z
  .object({
    actorHumanId: z.string(),
    ownerType: ownerTypeSchema,
    ownerId: z.string().uuid(),
    /** true = suspend (circuit breaker), false = lift the suspension. */
    suspend: z.boolean(),
    /**
     * Required either way: suspending an account and un-suspending one are
     * both interventions someone later has to understand from the audit log.
     */
    reason: plainTextRequired(500),
  })
  .strict();

export type SuspendMembershipStandingInput = z.infer<
  typeof suspendMembershipStandingInputSchema
>;

export const suspendMembershipStandingOutputSchema = z
  .object({ standing: membershipStandingOutputSchema })
  .strict();

export type SuspendMembershipStandingOutput = z.infer<
  typeof suspendMembershipStandingOutputSchema
>;

/**
 * Set or clear `MembershipStanding.suspended` for an owner. Suspension blocks
 * NEW membership signups (`startMembership` → MEMBERSHIPS_SUSPENDED); it does
 * not cancel existing subscriptions.
 *
 * Leaves `overriddenBy`/`overrideReason` UNTOUCHED (see the header note):
 * those fields pin the RESERVE, and stamping them here would zero the reserve
 * of exactly the payee just judged risky enough to suspend. The actor and
 * reason live in `suspendedReason` + the audit row.
 */
export async function suspendMembershipStanding(
  deps: MembershipStandingAdminDeps,
  rawInput: unknown,
): Promise<SuspendMembershipStandingOutput> {
  const logger = deps.logger?.child({ useCase: "suspendMembershipStanding" });
  const input = parseInput(suspendMembershipStandingInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);
  await ensureOwnerExists(deps, input.ownerType, input.ownerId);

  const now = deps.clock.now();
  const where = ownerWhere(input.ownerType, input.ownerId);

  const standing = await deps.repos.tx(async (tx) => {
    const previous = await tx.membershipStandings.findForOwner(where);

    // `overriddenBy`/`overrideReason` deliberately absent: they are the
    // reserve-pin marker and belong to overrideMembershipStanding alone.
    // Omitted fields are left untouched on an existing row and take schema
    // defaults (null) on a fresh one.
    const row = await tx.membershipStandings.upsertForOwner({
      ...where,
      suspended: input.suspend,
      suspendedAt: input.suspend ? now : null,
      suspendedReason: input.suspend ? input.reason : null,
    });

    // Audit INSIDE the transaction — a standing flip without its audit row
    // must not be possible.
    await tx.audit.log({
      entity: "membership_standing",
      entityId: row.id,
      action: input.suspend ? "suspended" : "unsuspended",
      data: {
        actorHumanId: input.actorHumanId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        reason: input.reason,
        previousSuspended: previous?.suspended ?? false,
      },
    });

    return row;
  });

  logger?.info("membership_standing_suspension_set", {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    suspended: input.suspend,
    actorHumanId: input.actorHumanId,
  });

  return { standing: toStandingOutput(standing) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reserve override
// ─────────────────────────────────────────────────────────────────────────────

export const overrideMembershipStandingInputSchema = z
  .object({
    actorHumanId: z.string(),
    ownerType: ownerTypeSchema,
    ownerId: z.string().uuid(),
    /** Rolling reserve on membership payouts. 0 clears it; 10000 = 100%. */
    reserveBps: z.number().int().min(0).max(10_000),
    /** Days a reserved slice is held before release. Bounded at one year. */
    reserveReleaseDays: z.number().int().min(0).max(365),
    /** Required: a reserve is someone's withheld money. */
    reason: plainTextRequired(500),
  })
  .strict();

export type OverrideMembershipStandingInput = z.infer<
  typeof overrideMembershipStandingInputSchema
>;

export const overrideMembershipStandingOutputSchema = z
  .object({ standing: membershipStandingOutputSchema })
  .strict();

export type OverrideMembershipStandingOutput = z.infer<
  typeof overrideMembershipStandingOutputSchema
>;

/**
 * Manually set the rolling reserve for an owner. Stamps the manual-override
 * marker (`overriddenBy`), which automatic reserve seasoning must honour by
 * never recomputing a pinned row — see the header note.
 */
export async function overrideMembershipStanding(
  deps: MembershipStandingAdminDeps,
  rawInput: unknown,
): Promise<OverrideMembershipStandingOutput> {
  const logger = deps.logger?.child({ useCase: "overrideMembershipStanding" });
  const input = parseInput(overrideMembershipStandingInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);
  await ensureOwnerExists(deps, input.ownerType, input.ownerId);

  const where = ownerWhere(input.ownerType, input.ownerId);

  const standing = await deps.repos.tx(async (tx) => {
    const previous = await tx.membershipStandings.findForOwner(where);

    const row = await tx.membershipStandings.upsertForOwner({
      ...where,
      reserveBps: input.reserveBps,
      reserveReleaseDays: input.reserveReleaseDays,
      overriddenBy: input.actorHumanId,
      overrideReason: input.reason,
    });

    await tx.audit.log({
      entity: "membership_standing",
      entityId: row.id,
      action: "reserve_overridden",
      data: {
        actorHumanId: input.actorHumanId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        reason: input.reason,
        overriddenBy: input.actorHumanId,
        overrideReason: input.reason,
        reserveBps: input.reserveBps,
        reserveReleaseDays: input.reserveReleaseDays,
        previousReserveBps: previous?.reserveBps ?? 0,
        previousReserveReleaseDays: previous?.reserveReleaseDays ?? null,
      },
    });

    return row;
  });

  logger?.info("membership_standing_reserve_overridden", {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    reserveBps: input.reserveBps,
    reserveReleaseDays: input.reserveReleaseDays,
    actorHumanId: input.actorHumanId,
  });

  return { standing: toStandingOutput(standing) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispute statuses that still expose us to loss. WON and WARNING_CLOSED are
 * neither open nor lost; they count only in the totals.
 */
const OPEN_DISPUTE_STATUSES: ReadonlySet<string> = new Set([
  "NEEDS_TRIAGE",
  "OPEN",
  "UNDER_REVIEW",
  "WARNING_OPEN",
  "WARNING_UNDER_REVIEW",
]);

export const getMembershipStandingOverviewInputSchema = z
  .object({ actorHumanId: z.string() })
  .strict();

export type GetMembershipStandingOverviewInput = z.infer<
  typeof getMembershipStandingOverviewInputSchema
>;

export const membershipStandingOverviewRowSchema = z
  .object({
    ownerType: ownerTypeSchema,
    ownerId: z.string(),
    /** Best-effort display name; null when the human/org lookup misses. */
    ownerLabel: z.string().nullable(),
    tierCount: z.number().int(),
    activeTierCount: z.number().int(),
    /** Members with a LIVE subscription (active/trialing/past_due/unpaid). */
    memberCount: z.number().int(),
    suspended: z.boolean(),
    suspendedAt: z.date().nullable(),
    suspendedReason: z.string().nullable(),
    reserveBps: z.number().int(),
    reserveReleaseDays: z.number().int(),
    overriddenBy: z.string().nullable(),
    overrideReason: z.string().nullable(),
    /** All-time dispute exposure on this owner's MEMBERSHIP orders. */
    disputeCount: z.number().int(),
    disputeAmountCents: z.number().int(),
    disputeFeeCents: z.number().int(),
    openDisputeCount: z.number().int(),
    openDisputeAmountCents: z.number().int(),
    openDisputeFeeCents: z.number().int(),
    lostDisputeCount: z.number().int(),
    lostDisputeAmountCents: z.number().int(),
    lostDisputeFeeCents: z.number().int(),
  })
  .strict();

export type MembershipStandingOverviewRow = z.infer<
  typeof membershipStandingOverviewRowSchema
>;

export const getMembershipStandingOverviewOutputSchema = z
  .object({ rows: z.array(membershipStandingOverviewRowSchema) })
  .strict();

export type GetMembershipStandingOverviewOutput = z.infer<
  typeof getMembershipStandingOverviewOutputSchema
>;

type OwnerKey = `${MembershipStandingOwnerType}:${string}`;

function keyOf(
  ownerOrgId: string | null,
  ownerHumanId: string | null,
): OwnerKey | null {
  if (ownerOrgId) return `ORG:${ownerOrgId}`;
  if (ownerHumanId) return `HUMAN:${ownerHumanId}`;
  return null;
}

/**
 * Platform view: one row per owner that has ANY membership footprint — a tier
 * (any status), a standing row, or a dispute on a membership order. Three
 * grouped reads plus two batched label lookups; never a per-owner fan-out.
 */
export async function getMembershipStandingOverview(
  deps: MembershipStandingAdminDeps,
  rawInput: unknown,
): Promise<GetMembershipStandingOverviewOutput> {
  const input = parseInput(getMembershipStandingOverviewInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  const tierStats = await deps.repos.membershipTiers.listOwnersWithTiers({
    memberStatuses: [...MEMBERSHIP_LIVE_STATUSES],
  });
  const exposure = await deps.repos.disputes.listMembershipExposureByOwner();

  // The row set is the UNION of owners seen anywhere: a suspended owner who
  // deleted every tier must stay visible (they are exactly who this page is
  // for), as must an owner whose tiers are gone but whose disputes are not.
  const rows = new Map<OwnerKey, MembershipStandingOverviewRow>();

  const ensureRow = (
    ownerOrgId: string | null,
    ownerHumanId: string | null,
  ): MembershipStandingOverviewRow | null => {
    const key = keyOf(ownerOrgId, ownerHumanId);
    if (!key) return null;
    let row = rows.get(key);
    if (!row) {
      row = {
        ownerType: ownerOrgId ? "ORG" : "HUMAN",
        ownerId: (ownerOrgId ?? ownerHumanId)!,
        ownerLabel: null,
        tierCount: 0,
        activeTierCount: 0,
        memberCount: 0,
        suspended: false,
        suspendedAt: null,
        suspendedReason: null,
        // Schema defaults for an owner with no standing row: no reserve, the
        // standard 90-day release window.
        reserveBps: 0,
        reserveReleaseDays: 90,
        overriddenBy: null,
        overrideReason: null,
        disputeCount: 0,
        disputeAmountCents: 0,
        disputeFeeCents: 0,
        openDisputeCount: 0,
        openDisputeAmountCents: 0,
        openDisputeFeeCents: 0,
        lostDisputeCount: 0,
        lostDisputeAmountCents: 0,
        lostDisputeFeeCents: 0,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const stats of tierStats) {
    const row = ensureRow(stats.ownerOrgId, stats.ownerHumanId);
    if (!row) continue;
    row.tierCount = stats.tierCount;
    row.activeTierCount = stats.activeTierCount;
    row.memberCount = stats.memberCount;
  }

  for (const group of exposure) {
    const row = ensureRow(group.ownerOrgId, group.ownerHumanId);
    if (!row) continue;
    row.disputeCount += group.disputeCount;
    row.disputeAmountCents += group.amountCents;
    row.disputeFeeCents += group.feeCents;
    if (group.status === "LOST") {
      row.lostDisputeCount += group.disputeCount;
      row.lostDisputeAmountCents += group.amountCents;
      row.lostDisputeFeeCents += group.feeCents;
    } else if (OPEN_DISPUTE_STATUSES.has(group.status)) {
      row.openDisputeCount += group.disputeCount;
      row.openDisputeAmountCents += group.amountCents;
      row.openDisputeFeeCents += group.feeCents;
    }
  }

  // ALL standing rows, not an id-driven batch: a suspended owner who deleted
  // every tier has no tier/dispute footprint left, and an id-driven read
  // would structurally miss exactly them. The table only holds intervened-on
  // owners, so "all" is small by construction. Standing-only owners join the
  // union via `ensureRow`; owners already present are simply updated.
  const standings = await deps.repos.membershipStandings.listAll();
  for (const standing of standings) {
    const row = ensureRow(standing.ownerOrgId, standing.ownerHumanId);
    if (!row) continue;
    row.suspended = standing.suspended;
    row.suspendedAt = standing.suspendedAt;
    row.suspendedReason = standing.suspendedReason;
    row.reserveBps = standing.reserveBps;
    row.reserveReleaseDays = standing.reserveReleaseDays;
    row.overriddenBy = standing.overriddenBy;
    row.overrideReason = standing.overrideReason;
  }

  // Best-effort labels: a naming miss must never take down the risk view —
  // an owner is still suspendable by id. Swallow + report (ReporterPort
  // convention, see CLAUDE.md).
  try {
    const orgIds = [...rows.values()]
      .filter((r) => r.ownerType === "ORG")
      .map((r) => r.ownerId);
    const humanIds = [...rows.values()]
      .filter((r) => r.ownerType === "HUMAN")
      .map((r) => r.ownerId);
    const [orgs, humans] = await Promise.all([
      orgIds.length > 0 ? deps.repos.organizations.getByIds(orgIds) : [],
      humanIds.length > 0 ? deps.repos.humans.getByIds(humanIds) : [],
    ]);
    for (const org of orgs) {
      const row = rows.get(`ORG:${org.id}`);
      if (row) row.ownerLabel = org.name || org.slug || null;
    }
    for (const human of humans) {
      const row = rows.get(`HUMAN:${human.id}`);
      if (row) row.ownerLabel = human.name ?? null;
    }
  } catch (err) {
    deps.logger?.error("membership_standing_owner_label_lookup_failed", {
      err,
    });
    deps.reportError?.(err, {
      tags: {
        useCase: "getMembershipStandingOverview",
        step: "attachOwnerLabels",
      },
    });
  }

  // Riskiest first: exposure (fee + disputed amount) descending, then by
  // label so the order is stable for equal exposure.
  const sorted = [...rows.values()].sort((a, b) => {
    const exposureA = a.disputeFeeCents + a.disputeAmountCents;
    const exposureB = b.disputeFeeCents + b.disputeAmountCents;
    if (exposureA !== exposureB) return exposureB - exposureA;
    return (a.ownerLabel ?? a.ownerId).localeCompare(b.ownerLabel ?? b.ownerId);
  });

  return { rows: sorted };
}
