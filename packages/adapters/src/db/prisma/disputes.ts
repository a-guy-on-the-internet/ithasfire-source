import { Prisma, type Dispute } from "@prisma/client";
import type {
  DisputeDeskRow,
  DisputeEvidenceAttentionRow,
  DisputeEvidenceStatus,
  DisputeRecord,
  DisputesRepo,
  DisputeStatus,
  ListDisputesForDeskInput,
  ListDisputesForDeskResult,
  MembershipDisputeExposureRow,
  OwnerLatestLostMembershipDisputeRow,
  OwnerOpenDisputeCountRow,
  UpsertDisputeFromStripeInput,
} from "@th/ports/repos/disputes";

import type { PrismaClientOrTx } from "./types";

const toNullableJson = (
  value: unknown | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
};

const hasOwn = <K extends keyof UpsertDisputeFromStripeInput>(
  input: UpsertDisputeFromStripeInput,
  key: K,
): boolean => Object.prototype.hasOwnProperty.call(input, key);

function mapDispute(row: Dispute): DisputeRecord {
  return {
    id: row.id,
    stripeDisputeId: row.stripeDisputeId,
    stripeChargeId: row.stripeChargeId ?? null,
    paymentIntentId: row.paymentIntentId ?? null,
    orderId: row.orderId ?? null,
    ownerSubjectType: row.ownerSubjectType ?? null,
    ownerSubjectId: row.ownerSubjectId ?? null,
    ownerOrgId: row.ownerOrgId ?? null,
    ownerHumanId: row.ownerHumanId ?? null,
    amountCents: row.amountCents,
    feeCents: row.feeCents,
    feeBorneBy: row.feeBorneBy ?? null,
    currency: row.currency,
    reason: row.reason,
    status: row.status as DisputeStatus,
    triageReason: row.triageReason ?? null,
    linkedAt: row.linkedAt ?? null,
    evidenceDueBy: row.evidenceDueBy ?? null,
    evidenceHasEvidence: row.evidenceHasEvidence ?? null,
    evidencePastDue: row.evidencePastDue ?? null,
    evidenceSubmissionCount: row.evidenceSubmissionCount ?? null,
    evidenceSubmittedAt: row.evidenceSubmittedAt ?? null,
    fundsWithdrawnAt: row.fundsWithdrawnAt ?? null,
    closedAt: row.closedAt ?? null,
    outcome: row.outcome ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildCreateData(
  input: UpsertDisputeFromStripeInput,
): Prisma.DisputeUncheckedCreateInput {
  return {
    stripeDisputeId: input.stripeDisputeId,
    stripeChargeId: input.stripeChargeId ?? null,
    paymentIntentId: input.paymentIntentId ?? null,
    orderId: input.orderId ?? null,
    ownerSubjectType: input.ownerSubjectType ?? null,
    ownerSubjectId: input.ownerSubjectId ?? null,
    ownerOrgId: input.ownerOrgId ?? null,
    ownerHumanId: input.ownerHumanId ?? null,
    amountCents: input.amountCents,
    feeCents: input.feeCents ?? 0,
    feeBorneBy: input.feeBorneBy ?? null,
    currency: input.currency,
    reason: input.reason,
    status: input.status,
    triageReason: input.triageReason ?? null,
    linkedAt: input.linkedAt ?? null,
    evidenceDueBy: input.evidenceDueBy ?? null,
    fundsWithdrawnAt: input.fundsWithdrawnAt ?? null,
    closedAt: input.closedAt ?? null,
    outcome: input.outcome ?? null,
    metadata: toNullableJson(input.metadata ?? null),
  };
}

function buildUpdateData(
  input: UpsertDisputeFromStripeInput,
): Prisma.DisputeUncheckedUpdateInput {
  return {
    stripeChargeId: hasOwn(input, "stripeChargeId")
      ? (input.stripeChargeId ?? null)
      : undefined,
    paymentIntentId: hasOwn(input, "paymentIntentId")
      ? (input.paymentIntentId ?? null)
      : undefined,
    orderId: hasOwn(input, "orderId") ? (input.orderId ?? null) : undefined,
    ownerSubjectType: hasOwn(input, "ownerSubjectType")
      ? (input.ownerSubjectType ?? null)
      : undefined,
    ownerSubjectId: hasOwn(input, "ownerSubjectId")
      ? (input.ownerSubjectId ?? null)
      : undefined,
    ownerOrgId: hasOwn(input, "ownerOrgId")
      ? (input.ownerOrgId ?? null)
      : undefined,
    ownerHumanId: hasOwn(input, "ownerHumanId")
      ? (input.ownerHumanId ?? null)
      : undefined,
    amountCents: input.amountCents,
    feeCents: hasOwn(input, "feeCents") ? (input.feeCents ?? 0) : undefined,
    feeBorneBy: hasOwn(input, "feeBorneBy")
      ? (input.feeBorneBy ?? null)
      : undefined,
    currency: input.currency,
    reason: input.reason,
    status: input.status,
    triageReason: hasOwn(input, "triageReason")
      ? (input.triageReason ?? null)
      : undefined,
    linkedAt: hasOwn(input, "linkedAt") ? (input.linkedAt ?? null) : undefined,
    evidenceDueBy: hasOwn(input, "evidenceDueBy")
      ? (input.evidenceDueBy ?? null)
      : undefined,
    fundsWithdrawnAt: hasOwn(input, "fundsWithdrawnAt")
      ? (input.fundsWithdrawnAt ?? null)
      : undefined,
    closedAt: hasOwn(input, "closedAt") ? (input.closedAt ?? null) : undefined,
    outcome: hasOwn(input, "outcome") ? (input.outcome ?? null) : undefined,
    metadata: toNullableJson(input.metadata),
  };
}

// Terminal statuses = the desk's "closed" tab; everything else is "open".
const CLOSED_DISPUTE_STATUSES: DisputeStatus[] = [
  "WON",
  "LOST",
  "WARNING_CLOSED",
];

// The daily evidence sweep's feed: OPEN only. Stripe moves a dispute to
// under_review ONLY after evidence has been submitted, so UNDER_REVIEW is by
// definition not chaseable; NEEDS_TRIAGE has no order to build evidence
// from; WARNING_* are inquiries with nothing to submit; the terminal statuses
// are the closed tab.
const EVIDENCE_ATTENTION_STATUSES: DisputeStatus[] = ["OPEN"];
const EVIDENCE_ATTENTION_MAX_ROWS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const ATTENTION_ROW_INCLUDE = {
  order: { select: { id: true, event: { select: { id: true, title: true } } } },
  ownerOrg: { select: { name: true } },
  ownerHuman: { select: { name: true } },
  evidence: { select: { status: true } },
} satisfies Prisma.DisputeInclude;

type AttentionRowSource = Prisma.DisputeGetPayload<{
  include: typeof ATTENTION_ROW_INCLUDE;
}>;

function mapAttentionRow(
  row: AttentionRowSource,
): DisputeEvidenceAttentionRow | null {
  // The predicate already requires orderId IS NOT NULL; the null-guard only
  // protects the DTO contract against a row whose order was deleted between
  // the query and the map (onDelete: SetNull).
  const orderId = row.order?.id ?? row.orderId ?? null;
  if (!orderId) return null;
  return {
    id: row.id,
    stripeDisputeId: row.stripeDisputeId,
    status: row.status as DisputeStatus,
    evidenceDueBy: row.evidenceDueBy ?? null,
    evidencePastDue: row.evidencePastDue ?? null,
    amountCents: row.amountCents,
    currency: row.currency,
    orderId,
    eventId: row.order?.event?.id ?? null,
    eventTitle: row.order?.event?.title ?? null,
    ownerOrgId: row.ownerOrgId ?? null,
    ownerOrgName: row.ownerOrg?.name ?? null,
    ownerHumanId: row.ownerHumanId ?? null,
    ownerHumanName: row.ownerHuman?.name ?? null,
    evidenceStatus: (row.evidence?.status as DisputeEvidenceStatus) ?? null,
  };
}

const DESK_ROW_INCLUDE = {
  order: {
    select: {
      id: true,
      kind: true,
      shortId: true,
      buyerHumanId: true,
      buyer: { select: { name: true } },
      event: { select: { id: true, title: true } },
      // Newest warning regardless of resolution (see DisputeDeskRow).
      earlyFraudWarnings: {
        select: { fraudType: true, stripeCreatedAt: true },
        orderBy: [{ stripeCreatedAt: "desc" }, { id: "desc" }],
        take: 1,
      },
    },
  },
  ownerOrg: { select: { name: true } },
  ownerHuman: { select: { name: true } },
  evidence: {
    select: {
      status: true,
      assembledVersion: true,
      reconciledFromProcessor: true,
    },
  },
} satisfies Prisma.DisputeInclude;

type DeskRowSource = Prisma.DisputeGetPayload<{
  include: typeof DESK_ROW_INCLUDE;
}>;

function mapDeskRow(row: DeskRowSource): DisputeDeskRow {
  return {
    id: row.id,
    stripeDisputeId: row.stripeDisputeId,
    status: row.status as DisputeStatus,
    reason: row.reason,
    amountCents: row.amountCents,
    feeCents: row.feeCents,
    currency: row.currency,
    triageReason: row.triageReason ?? null,
    evidenceDueBy: row.evidenceDueBy ?? null,
    evidenceHasEvidence: row.evidenceHasEvidence ?? null,
    evidencePastDue: row.evidencePastDue ?? null,
    evidenceSubmissionCount: row.evidenceSubmissionCount ?? null,
    evidenceSubmittedAt: row.evidenceSubmittedAt ?? null,
    fundsWithdrawnAt: row.fundsWithdrawnAt ?? null,
    closedAt: row.closedAt ?? null,
    outcome: row.outcome ?? null,
    createdAt: row.createdAt,
    orderId: row.order?.id ?? row.orderId ?? null,
    orderKind: (row.order?.kind as DisputeDeskRow["orderKind"]) ?? null,
    orderShortId: row.order?.shortId ?? null,
    buyerHumanId: row.order?.buyerHumanId ?? null,
    buyerName: row.order?.buyer?.name ?? null,
    eventId: row.order?.event?.id ?? null,
    eventTitle: row.order?.event?.title ?? null,
    ownerOrgId: row.ownerOrgId ?? null,
    ownerOrgName: row.ownerOrg?.name ?? null,
    ownerHumanId: row.ownerHumanId ?? null,
    ownerHumanName: row.ownerHuman?.name ?? null,
    evidenceStatus: (row.evidence?.status as DisputeEvidenceStatus) ?? null,
    evidenceAssembledVersion: row.evidence?.assembledVersion ?? null,
    evidenceReconciledFromProcessor: row.evidence?.reconciledFromProcessor ?? null,
    earlyFraudWarning: mapEarlyFraudWarningSummary(row.order?.earlyFraudWarnings),
  };
}

function mapEarlyFraudWarningSummary(
  rows: Array<{ fraudType: string; stripeCreatedAt: Date }> | undefined,
): DisputeDeskRow["earlyFraudWarning"] {
  const latest = rows?.[0];
  return latest
    ? { fraudType: latest.fraudType, stripeCreatedAt: latest.stripeCreatedAt }
    : null;
}

/**
 * Keyset predicate continuing AFTER the cursor row under the queue's sort.
 * Hand-built (not Prisma `cursor:`) because the sort has NULLS LAST on a
 * nullable column, which Prisma's cursor emulation does not order correctly.
 */
function deskAfterClause(
  filter: ListDisputesForDeskInput["status"],
  after: { id: string; evidenceDueBy: Date | null; closedAt: Date | null },
): Prisma.DisputeWhereInput {
  if (filter === "closed") {
    // closedAt DESC NULLS LAST, id DESC
    if (after.closedAt === null) {
      return { closedAt: null, id: { lt: after.id } };
    }
    return {
      OR: [
        { closedAt: { lt: after.closedAt } },
        { closedAt: after.closedAt, id: { lt: after.id } },
        { closedAt: null },
      ],
    };
  }
  // evidenceDueBy ASC NULLS LAST, id ASC
  if (after.evidenceDueBy === null) {
    return { evidenceDueBy: null, id: { gt: after.id } };
  }
  return {
    OR: [
      { evidenceDueBy: { gt: after.evidenceDueBy } },
      { evidenceDueBy: after.evidenceDueBy, id: { gt: after.id } },
      { evidenceDueBy: null },
    ],
  };
}

export function makeDisputesRepo(p: PrismaClientOrTx): DisputesRepo {
  return {
    findByStripeDisputeId: async (stripeDisputeId) => {
      const row = await p.dispute.findUnique({ where: { stripeDisputeId } });
      return row ? mapDispute(row) : null;
    },

    getById: async (disputeId) => {
      const row = await p.dispute.findUnique({ where: { id: disputeId } });
      return row ? mapDispute(row) : null;
    },

    updateEvidenceDetails: async (input) => {
      // updateMany + re-read rather than update: an unknown dispute is a
      // legitimate no-op here (webhook before intake), not a P2025 throw.
      const updated = await p.dispute.updateMany({
        where: { stripeDisputeId: input.stripeDisputeId },
        data: {
          evidenceHasEvidence: input.evidenceHasEvidence,
          evidencePastDue: input.evidencePastDue,
          evidenceSubmissionCount: input.evidenceSubmissionCount,
          ...(input.evidenceDueBy !== undefined
            ? { evidenceDueBy: input.evidenceDueBy }
            : {}),
          ...(input.evidenceSubmittedAt !== undefined
            ? { evidenceSubmittedAt: input.evidenceSubmittedAt }
            : {}),
        },
      });
      if (updated.count === 0) return null;
      const row = await p.dispute.findUnique({
        where: { stripeDisputeId: input.stripeDisputeId },
      });
      return row ? mapDispute(row) : null;
    },

    listForDesk: async (input): Promise<ListDisputesForDeskResult> => {
      const take = input.limit;
      const statusWhere: Prisma.DisputeWhereInput =
        input.status === "open"
          ? { status: { notIn: CLOSED_DISPUTE_STATUSES } }
          : input.status === "closed"
            ? { status: { in: CLOSED_DISPUTE_STATUSES } }
            : {};

      // Resolve the cursor INSIDE the same status filter: a cursor from the
      // other tab (or a deleted row) resolves to nothing and the page
      // restarts from the top instead of leaking a position.
      const after = input.cursor
        ? await p.dispute.findFirst({
            where: { id: input.cursor, ...statusWhere },
            select: { id: true, evidenceDueBy: true, closedAt: true },
          })
        : null;

      const orderBy: Prisma.DisputeOrderByWithRelationInput[] =
        input.status === "closed"
          ? [{ closedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }]
          : [{ evidenceDueBy: { sort: "asc", nulls: "last" } }, { id: "asc" }];

      const rows = await p.dispute.findMany({
        where: {
          AND: [statusWhere, after ? deskAfterClause(input.status, after) : {}],
        },
        include: DESK_ROW_INCLUDE,
        orderBy,
        // take+1 probes for a next page without a second COUNT query.
        take: take + 1,
      });

      const page = rows.slice(0, take);
      const items = page.map(mapDeskRow);
      const nextCursor =
        rows.length > take ? (page[page.length - 1]?.id ?? null) : null;
      return { items, nextCursor };
    },

    upsertFromStripe: async (input) => {
      const row = await p.dispute.upsert({
        where: { stripeDisputeId: input.stripeDisputeId },
        create: buildCreateData(input),
        update: buildUpdateData(input),
      });
      return mapDispute(row);
    },

    listOpenNeedingEvidenceAttention: async (input) => {
      const take = Math.min(
        Math.max(1, Math.trunc(input.limit ?? EVIDENCE_ATTENTION_MAX_ROWS)),
        EVIDENCE_ATTENTION_MAX_ROWS,
      );
      const cutoff = new Date(
        input.now.getTime() + input.dueWithinDays * DAY_MS,
      );
      const rows = await p.dispute.findMany({
        where: {
          status: { in: EVIDENCE_ATTENTION_STATUSES },
          orderId: { not: null },
          // "Nothing submitted" needs BOTH signals: the desk stamps
          // evidenceSubmittedAt, but evidence submitted by hand in the Stripe
          // Dashboard only shows up in the webhook mirror as
          // evidenceSubmissionCount > 0. Gating on the desk stamp alone
          // chased a hand-submitted dispute daily until Stripe closed it.
          evidenceSubmittedAt: null,
          AND: [
            {
              OR: [
                { evidenceSubmissionCount: null },
                { evidenceSubmissionCount: 0 },
              ],
            },
          ],
          OR: [
            { evidenceDueBy: { lte: cutoff } },
            { evidenceDueBy: null },
            { evidence: { is: null } },
            { evidence: { is: { status: "SUBMIT_FAILED" } } },
          ],
        },
        include: ATTENTION_ROW_INCLUDE,
        orderBy: [
          { evidenceDueBy: { sort: "asc", nulls: "last" } },
          { id: "asc" },
        ],
        take,
      });
      return rows
        .map(mapAttentionRow)
        .filter((r): r is DisputeEvidenceAttentionRow => r !== null);
    },

    listMembershipExposureByOwner: async () => {
      // ONE grouped query: the relation filter narrows to disputes whose
      // linked order is a MEMBERSHIP order, and grouping by the denormalised
      // owner columns keeps owners separate in the database rather than in JS.
      const groups = await p.dispute.groupBy({
        by: ["ownerOrgId", "ownerHumanId", "status"],
        where: { order: { kind: "MEMBERSHIP" } },
        _count: { _all: true },
        _sum: { amountCents: true, feeCents: true },
      });

      return groups
        // A dispute row with NO owner attribution cannot be shown against an
        // account; dropping it here beats inventing a phantom "unknown" owner
        // in every consumer.
        .filter((g) => g.ownerOrgId != null || g.ownerHumanId != null)
        .map(
          (g): MembershipDisputeExposureRow => ({
            ownerOrgId: g.ownerOrgId ?? null,
            ownerHumanId: g.ownerHumanId ?? null,
            status: g.status as DisputeStatus,
            disputeCount: g._count._all,
            amountCents: g._sum.amountCents ?? 0,
            feeCents: g._sum.feeCents ?? 0,
          }),
        );
    },

    latestLostMembershipDisputeAtByOwner: async () => {
      // ONE grouped query platform-wide (LOST membership disputes are rare
      // by construction — see the port note). `_max` of both closedAt and
      // createdAt: the loss timestamp is closedAt, but a hand-written or
      // legacy row may never have had its close stamped, so createdAt is the
      // documented fallback (see OwnerLatestLostMembershipDisputeRow).
      //
      // CAUTION — the `_max(closedAt) ?? _max(createdAt)` blend is an
      // APPROXIMATION whose error direction is UNSAFE. The two columns are
      // maxed independently across the owner's rows, so when the NEWEST lost
      // row has no closedAt, an OLDER row's closedAt wins over the newer
      // row's createdAt — an earlier "latest loss" than the truth. That
      // makes the lost-dispute window (reserve bracket + release freeze)
      // expire SOONER, i.e. LESS reserve than intended. Tolerated because
      // every webhook-written LOST row does get closedAt stamped; if
      // hand-written rows without closedAt ever become common, replace the
      // blend with a per-row `max(coalesce(closedAt, createdAt))`.
      const groups = await p.dispute.groupBy({
        by: ["ownerOrgId", "ownerHumanId"],
        where: { status: "LOST", order: { kind: "MEMBERSHIP" } },
        _max: { closedAt: true, createdAt: true },
      });

      const rows: OwnerLatestLostMembershipDisputeRow[] = [];
      for (const g of groups) {
        // Same posture as the exposure query: a LOST dispute with no owner
        // attribution cannot inform any owner's curve — drop it here rather
        // than invent a phantom owner.
        if (g.ownerOrgId == null && g.ownerHumanId == null) continue;
        const latestLostAt = g._max.closedAt ?? g._max.createdAt;
        if (latestLostAt == null) continue;
        rows.push({
          ownerOrgId: g.ownerOrgId ?? null,
          ownerHumanId: g.ownerHumanId ?? null,
          latestLostAt,
        });
      }
      return rows;
    },

    countOpenByOwners: async ({ orgIds, humanIds }) => {
      if (orgIds.length === 0 && humanIds.length === 0) return [];
      // ONE grouped query scoped to the requested owners. The status list is
      // the payable query's blocking pair (OPEN / UNDER_REVIEW) — NEEDS_TRIAGE
      // has no owner attribution yet by construction, and WARNING_* rows are
      // inquiries, not chargebacks.
      const ownerArms: Prisma.DisputeWhereInput[] = [];
      if (orgIds.length > 0) ownerArms.push({ ownerOrgId: { in: orgIds } });
      if (humanIds.length > 0)
        ownerArms.push({ ownerHumanId: { in: humanIds } });
      const groups = await p.dispute.groupBy({
        by: ["ownerOrgId", "ownerHumanId"],
        where: { status: { in: ["OPEN", "UNDER_REVIEW"] }, OR: ownerArms },
        _count: { _all: true },
      });
      return groups
        .filter((g) => g.ownerOrgId != null || g.ownerHumanId != null)
        .map(
          (g): OwnerOpenDisputeCountRow => ({
            ownerOrgId: g.ownerOrgId ?? null,
            ownerHumanId: g.ownerHumanId ?? null,
            openDisputeCount: g._count._all,
          }),
        );
    },
  };
}
