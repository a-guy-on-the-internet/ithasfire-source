/**
 * M5 — who sees what of a deal, enforced HERE on the server, never as a UI
 * filter (deal-terms-and-settlement M5):
 *
 *   - every PARTY sees the whole breakdown — M13: through an edit or
 *     finance role on a party org (OWNER/ADMIN/EDITOR/FINANCE), or as the
 *     human party; never a VIEWER or SCANNER;
 *   - a PAYEE who is not a party sees only their own line, with the number
 *     their percentage is of (M14);
 *   - nobody else sees anything (never public).
 *
 * `resolveDealViewer` decides which, and the `project*` functions build the
 * only shapes a non-party may receive. The OWN_LINE shapes are allow-lists:
 * every field is copied by name, so a field later added to the calculator's
 * output never reaches a non-party by default. Their zod schemas are
 * `.strict()` and run as the procedures' output schemas, a second check.
 */
import { z } from "zod";

import type { OrgRole } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";

import { ORG_ADMIN_ROLES } from "../../../lib/rbac";
import type {
  DealClauseResult,
  DealPayeePosition,
  DealSettlementResult,
} from "../../../lib/settlement";
import type { AgreementParty } from "../../booking-agreements/_shared/agreement-access";

export type DealViewer =
  | { visibility: "FULL" }
  | { visibility: "OWN_LINE"; payeeIds: string[] };

export type DealViewerRepos = Pick<Repos, "authz" | "payees">;

/**
 * FULL when the actor controls one of `parties` (a human party is the actor;
 * an org party needs a role in `partyOrgRoles`). Otherwise OWN_LINE when the
 * actor controls a payee on the deal — the payee rule `confirmPayoutLine`
 * already uses: a HUMAN payee is the actor; an ORGANIZATION payee needs
 * OWNER/ADMIN. Otherwise null — the caller refuses.
 */
export async function resolveDealViewer(
  repos: DealViewerRepos,
  input: {
    actorHumanId: string;
    parties: readonly AgreementParty[];
    partyOrgRoles: readonly OrgRole[];
    /** Every payee on the deal or the sheet. */
    payeeIds: readonly string[];
  },
): Promise<DealViewer | null> {
  const partyOrgIds = new Set<string>();
  for (const party of input.parties) {
    if (party.type === "human") {
      if (party.id === input.actorHumanId) return { visibility: "FULL" };
    } else {
      partyOrgIds.add(party.id);
    }
  }
  if (partyOrgIds.size > 0) {
    const memberships = await repos.authz.getOrgMemberships({
      orgIds: [...partyOrgIds],
      humanId: input.actorHumanId,
    });
    if (memberships.some((m) => input.partyOrgRoles.includes(m.role))) {
      return { visibility: "FULL" };
    }
  }

  const uniquePayeeIds = [...new Set(input.payeeIds)];
  if (uniquePayeeIds.length === 0) return null;
  const payees = await repos.payees.getByIds(uniquePayeeIds);
  const own = new Set<string>();
  const payeesByOrg = new Map<string, string[]>();
  for (const payee of payees) {
    if (payee.subjectType === "HUMAN") {
      if (payee.subjectId === input.actorHumanId) own.add(payee.id);
    } else {
      payeesByOrg.set(payee.subjectId, [
        ...(payeesByOrg.get(payee.subjectId) ?? []),
        payee.id,
      ]);
    }
  }
  if (payeesByOrg.size > 0) {
    const memberships = await repos.authz.getOrgMemberships({
      orgIds: [...payeesByOrg.keys()],
      humanId: input.actorHumanId,
    });
    for (const m of memberships) {
      if (ORG_ADMIN_ROLES.includes(m.role)) {
        for (const id of payeesByOrg.get(m.orgId) ?? []) own.add(id);
      }
    }
  }
  if (own.size === 0) return null;
  return { visibility: "OWN_LINE", payeeIds: [...own].sort() };
}

// ── The OWN_LINE shapes (allow-lists) ─────────────────────────────────────

const percentOfSchema = z
  .object({
    basis: z.enum(["GROSS", "NET_POOL"]),
    basisCents: z.number().int(),
    afterDeductionIds: z.array(z.string()),
  })
  .strict();

const clauseHowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("FIXED"), fixedCents: z.number().int() }).strict(),
  z
    .object({
      kind: z.literal("PERCENT"),
      percent: z.number().int(),
      percentOf: percentOfSchema,
      percentCents: z.number().int(),
      paidPerOrderCents: z.number().int().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("SUM"),
      fixedCents: z.number().int(),
      percent: z.number().int(),
      percentOf: percentOfSchema,
      percentCents: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("GREATER_OF"),
      fixedCents: z.number().int(),
      percent: z.number().int(),
      percentOf: percentOfSchema,
      percentCents: z.number().int(),
      picked: z.enum(["FIXED", "PERCENT", "TIE"]),
    })
    .strict(),
]);

export const ownClauseResultSchema = z
  .object({
    clauseId: z.string(),
    payeeId: z.string(),
    amountType: z.enum(["FIXED", "PERCENT", "FIXED_AND_PERCENT"]),
    displayLabel: z.string().nullable(),
    entitlementCents: z.number().int(),
    how: clauseHowSchema,
    stage1: z.enum(["PAID_PER_ORDER", "SETTLED_DIRECTLY"]),
    coveredByPoolCents: z.number().int(),
    uncoveredCents: z.number().int(),
  })
  .strict();
export type OwnClauseResult = z.infer<typeof ownClauseResultSchema>;

export const ownPositionSchema = z
  .object({
    payeeId: z.string(),
    clauseIds: z.array(z.string()),
    clauseCents: z.number().int(),
    creditedDeductionsCents: z.number().int(),
    notRecoveredCents: z.number().int(),
    entitlementCents: z.number().int(),
    offPlatformShareCents: z.number().int(),
    heldOffPlatformCents: z.number().int(),
    directReceivedCents: z.number().int(),
    directPaidCents: z.number().int(),
    paidThroughPlatformCents: z.number().int().nullable(),
    settleDirectlyCents: z.number().int().nullable(),
    projectedPaidPerOrderCents: z.number().int().nullable(),
    projectedSettleDirectlyCents: z.number().int().nullable(),
    shortfallDueCents: z.number().int(),
  })
  .strict();
export type OwnPosition = z.infer<typeof ownPositionSchema>;

export const ownCostSchema = z
  .object({
    deductionId: z.string(),
    kind: z.enum(["RENTAL", "EXPENSE", "HOUSE_NUT"]),
    label: z.string(),
    creditedPayeeId: z.string(),
    percent: z.number().int().nullable(),
    amountCents: z.number().int(),
    amountSource: z.enum(["AGREED", "ESTIMATE", "ACTUAL"]),
    estimated: z.boolean(),
    recoupedCents: z.number().int(),
    notRecoveredCents: z.number().int(),
  })
  .strict();

export const ownOffPlatformSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["DOOR_CASH", "BAR_SHARE", "OTHER"]),
    label: z.string(),
    heldByPayeeId: z.string(),
    ownerPayeeId: z.string(),
    entered: z.boolean(),
    amountCents: z.number().int().optional(),
  })
  .strict();

export const ownLineSettlementViewSchema = z
  .object({
    visibility: z.literal("OWN_LINE"),
    engineVersion: z.number().int(),
    revenueMode: z.enum(["PROJECTED", "ACTUAL"]),
    payeeIds: z.array(z.string()),
    clauses: z.array(ownClauseResultSchema),
    positions: z.array(ownPositionSchema),
    costsCredited: z.array(ownCostSchema),
    offPlatform: z.array(ownOffPlatformSchema),
    /** Shortfall the remainder payee owes these payees directly. */
    shortfallDue: z.array(
      z
        .object({
          payeeId: z.string(),
          owedByPayeeId: z.string(),
          cents: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();
export type OwnLineSettlementView = z.infer<typeof ownLineSettlementViewSchema>;

/**
 * FULL is the calculator's whole result for a party. Not re-validated field
 * by field (the calculator asserts its own invariants); the envelope is.
 */
export const fullSettlementViewSchema = z
  .object({
    visibility: z.literal("FULL"),
    result: z.custom<DealSettlementResult>(
      (value) => typeof value === "object" && value !== null,
    ),
  })
  .strict();
export type FullSettlementView = z.infer<typeof fullSettlementViewSchema>;

export const settlementViewSchema = z.discriminatedUnion("visibility", [
  fullSettlementViewSchema,
  ownLineSettlementViewSchema,
]);
export type SettlementView = FullSettlementView | OwnLineSettlementView;

function ownClause(c: DealClauseResult): OwnClauseResult {
  return {
    clauseId: c.clauseId,
    payeeId: c.payeeId,
    amountType: c.amountType,
    displayLabel: c.displayLabel,
    entitlementCents: c.entitlementCents,
    how: c.how,
    stage1: c.stage1,
    coveredByPoolCents: c.coveredByPoolCents,
    uncoveredCents: c.uncoveredCents,
  };
}

function ownPosition(p: DealPayeePosition): OwnPosition {
  return {
    payeeId: p.payeeId,
    clauseIds: p.clauseIds,
    clauseCents: p.clauseCents,
    creditedDeductionsCents: p.creditedDeductionsCents,
    notRecoveredCents: p.notRecoveredCents,
    entitlementCents: p.entitlementCents,
    offPlatformShareCents: p.offPlatformShareCents,
    heldOffPlatformCents: p.heldOffPlatformCents,
    directReceivedCents: p.directReceivedCents,
    directPaidCents: p.directPaidCents,
    paidThroughPlatformCents: p.paidThroughPlatformCents,
    settleDirectlyCents: p.settleDirectlyCents,
    projectedPaidPerOrderCents: p.projectedPaidPerOrderCents,
    projectedSettleDirectlyCents: p.projectedSettleDirectlyCents,
    shortfallDueCents: p.shortfallDueCents,
  };
}

/**
 * The calculator's output as `viewer` may see it. FULL → everything.
 * OWN_LINE → only rows that are the viewer's own: their clauses, their
 * position, the costs credited to them, off-platform money they hold or own,
 * and any shortfall owed to them. No waterfall, no other payee's line.
 *
 * M14 (owner, 2026-10-04): a percentage clause DOES carry the number it is
 * a percentage of (`how.percentOf.basisCents` — the ticket money for a
 * GROSS clause, the pool after costs for a NET_POOL one), so a payee can
 * check their own money: "10% of the pool after costs ($3,050) = $305".
 */
export function projectSettlementForViewer(
  result: DealSettlementResult,
  viewer: DealViewer,
): SettlementView {
  if (viewer.visibility === "FULL") return { visibility: "FULL", result };
  const own = new Set(viewer.payeeIds);
  return {
    visibility: "OWN_LINE",
    engineVersion: result.engineVersion,
    revenueMode: result.revenueMode,
    payeeIds: [...own],
    clauses: result.clauses.filter((c) => own.has(c.payeeId)).map(ownClause),
    positions: result.payees.filter((p) => own.has(p.payeeId)).map(ownPosition),
    costsCredited: result.waterfall.steps
      .filter((s) => own.has(s.creditedPayeeId))
      .map((s) => ({
        deductionId: s.deductionId,
        kind: s.kind,
        label: s.label,
        creditedPayeeId: s.creditedPayeeId,
        percent: s.percent,
        amountCents: s.amountCents,
        amountSource: s.amountSource,
        estimated: s.estimated,
        recoupedCents: s.recoupedCents,
        notRecoveredCents: s.notRecoveredCents,
      })),
    offPlatform: result.offPlatform.rows
      .filter((o) => own.has(o.heldByPayeeId) || own.has(o.ownerPayeeId))
      .map((o) => ({
        id: o.id,
        kind: o.kind,
        label: o.label,
        heldByPayeeId: o.heldByPayeeId,
        ownerPayeeId: o.ownerPayeeId,
        entered: o.entered,
        ...(o.amountCents !== undefined ? { amountCents: o.amountCents } : {}),
      })),
    shortfallDue: result.shortfall
      ? result.shortfall.owedTo
          .filter((o) => own.has(o.payeeId))
          .map((o) => ({
            payeeId: o.payeeId,
            owedByPayeeId: result.shortfall!.owedByPayeeId,
            cents: o.cents,
          }))
      : [],
  };
}

/**
 * The payee ids a viewer may see named in this view — the only ones whose
 * display names the read resolves.
 */
export function visiblePayeeIds(view: SettlementView): string[] {
  const ids = new Set<string>();
  if (view.visibility === "FULL") {
    for (const p of view.result.payees) ids.add(p.payeeId);
    return [...ids];
  }
  for (const id of view.payeeIds) ids.add(id);
  for (const c of view.costsCredited) ids.add(c.creditedPayeeId);
  for (const o of view.offPlatform) {
    ids.add(o.heldByPayeeId);
    ids.add(o.ownerPayeeId);
  }
  for (const s of view.shortfallDue) ids.add(s.owedByPayeeId);
  return [...ids];
}
